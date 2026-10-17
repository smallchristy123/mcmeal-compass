"""发布封包流水线（v3.7.4 起纳入仓库，供第三方复跑）

用法：
    python scripts/release/pack.py --base <项目根> --ws <工作区> --release v3.7.4 --date 20261017

    · `--base`：含 `mcmeal-compass/` 与 `outputs/` 的目录
    · `--ws`  ：放中间产物（cleanroom、最终解压目录）的工作区
    · 本脚本**不含**任何执行方私有路径；包根另放一份同名副本 `tools/pack-release.py`，
      由本流水线断言与仓库版逐字节一致（否则中止打包）。

流水线：
  ⓪ **包根脚本一致性断言**：包根凡有仓库同名件，逐字节 SHA-256 必须相等，否则**中止打包**
     （`.mjs` → `scripts/` 或 `scripts/review-scaffolds/`；`.py` → `scripts/release/`）
  ⓪b **文档路径门槛**：
     · 扫描范围**不写文件名白名单**，由目录 + 扩展名规则从实际清单推导；
     · **纳入**：包内全部 `.md` ＋ 包根与 `source/` 下的 `.txt`/`.log`
       （含根因文件 `source/SOURCE-IDENTITY.txt`——v3.7.3 的 6 份白名单恰恰漏了它）；
     · **不扫**：`online-evidence/`、`sample-outputs/`、`human-review/`（机器产物与原始响应）、
       `SHA256SUMS.txt`（机器生成的哈希清单）；
     · **豁免**：非本版的历史 `REVIEW-RESPONSE-*` / `SIGNOFF-*`（历史账，按当年包结构书写）；
     · **负向自测**：正式扫描前注入一个必不存在的包根相对路径，门槛**必须**报缺失，
       否则说明这道门已失效 ⇒ **中止打包**；
     · **声明范围 = 实际范围**：打印与 manifest 只写「实际扫了几份」，不写「所有」。
  ① 源码身份材料归入 `source/`
  ② 生成包内 `SHA256SUMS.txt`（**不含自身**）
  ③ 打外层 ZIP
  ④ **解压最终 ZIP** 到全新目录（外包 + 内包都解开）
  ⑤ 在**最终解压态**上跑扫描（占位字样 / 凭据）
  ⑥ 报告写到**包外** reports 目录；`release-manifest.json` 的统计**全部机器生成**

绝不把「对最终包的扫描报告」放进最终包——否则报告本身会改变包内容，自指失真。
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone, timedelta

ap = argparse.ArgumentParser(description="McMeal Compass 发布封包流水线")
ap.add_argument("--base", required=True, help="项目根（含 mcmeal-compass/ 与 outputs/）")
ap.add_argument("--ws", required=True, help="工作区（放 cleanroom 与最终解压目录）")
ap.add_argument("--release", required=True, help="版本号，如 v3.7.4")
ap.add_argument("--date", required=True, help="日期戳，如 20261017")
ap.add_argument("--node", default="node", help="node 可执行文件（默认取 PATH）")
args = ap.parse_args()

BASE = os.path.abspath(args.base)
WS = os.path.abspath(args.ws)
RELEASE = args.release
REPO = os.path.join(BASE, "mcmeal-compass")
STAGE = os.path.join(BASE, "outputs", "review-package-%s" % RELEASE)
REPORTS = os.path.join(BASE, "outputs", "review-package-%s-reports" % RELEASE)
CLEANROOM = os.path.join(WS, "outputs", "_pkg-%s-cleanroom" % RELEASE)
FINAL_EXTRACT = os.path.join(WS, "outputs", "_final-zip-check-%s" % RELEASE)
INNER_NAME = "mcmeal-compass-src-%s.zip" % RELEASE
OUTER = os.path.join(BASE, "outputs", "mcmeal-compass-review-package-%s-%s.zip" % (RELEASE, args.date))
IDENTITY_DIR = os.path.join(REPO, "work", "source-identity")
NODE = args.node

if not os.path.isdir(STAGE):
    sys.exit("✗ 包根目录不存在：%s（请先搭好包根骨架）" % STAGE)
if not os.path.isdir(IDENTITY_DIR):
    sys.exit("✗ 源码身份材料不存在：%s（请先跑 scripts/source-identity.mjs）" % IDENTITY_DIR)

PACKAGE_VERSION = json.load(open(os.path.join(REPO, "package.json"), encoding="utf-8"))["version"]


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 16), b""):
            h.update(c)
    return h.hexdigest().upper()


def git(*a):
    return subprocess.run(["git", *a], cwd=REPO, capture_output=True, text=True).stdout.strip()


# ── ⓪ 包根脚本一致性断言 ─────────────────────────────────────
def repo_counterpart(name):
    for cand in (os.path.join(REPO, "scripts", name),
                 os.path.join(REPO, "scripts", "review-scaffolds", name),
                 os.path.join(REPO, "scripts", "release", name)):
        if os.path.isfile(cand):
            return cand
    return None


tracked, mismatched, untracked = [], [], []
root_scripts = sorted(
    f for f in os.listdir(STAGE)
    if f.endswith((".mjs", ".py")) and os.path.isfile(os.path.join(STAGE, f))
)
# 包根 tools/ 下的副本也要比对（打包脚本自证同源）
for sub in ("tools",):
    d = os.path.join(STAGE, sub)
    if os.path.isdir(d):
        root_scripts += ["%s/%s" % (sub, f) for f in sorted(os.listdir(d))
                         if f.endswith((".mjs", ".py"))]

for f in root_scripts:
    repo_copy = repo_counterpart(os.path.basename(f))
    if repo_copy is not None:
        a, b = sha256(repo_copy), sha256(os.path.join(STAGE, f))
        if a != b:
            mismatched.append("%s（仓库 %s ≠ 包根 %s）" % (f, a[:12], b[:12]))
        else:
            tracked.append(f)
    else:
        untracked.append(f)
if mismatched:
    sys.exit("✗ 中止打包：包根脚本与仓库权威件不一致 →\n   " + "\n   ".join(mismatched))
print("⓪ 包根脚本一致性：%d/%d 件与仓库逐字节一致" % (len(tracked), len(root_scripts)))
print("   与仓库同源：%s" % "、".join(tracked))
if untracked:
    print("   ⚠️ 仓库无同名件（按指纹登记，须尽快纳入）：%s" % "、".join(untracked))

# ── ① 源码身份材料归入 source/ ────────────────────────────────
src_dir = os.path.join(STAGE, "source")
os.makedirs(src_dir, exist_ok=True)
for name in ("mcmeal-compass-history.bundle", "SOURCE-IDENTITY.txt", "tree-listing.tsv"):
    shutil.copy2(os.path.join(IDENTITY_DIR, name), os.path.join(src_dir, name))
shutil.copy2(os.path.join(CLEANROOM, "history-secrets-scan.json"),
             os.path.join(src_dir, "history-secrets-scan.json"))
bundle_path = os.path.join(src_dir, "mcmeal-compass-history.bundle")
print("① 源码身份材料：%d 件（bundle %s bytes）"
      % (len(os.listdir(src_dir)), format(os.path.getsize(bundle_path), ",")))

# ── ② 包内清单 ───────────────────────────────────────────────
files, dirs = [], []
for dp, dn, fn in os.walk(STAGE):
    for d in dn:
        dirs.append(os.path.relpath(os.path.join(dp, d), STAGE).replace("\\", "/") + "/")
    for f in fn:
        rel = os.path.relpath(os.path.join(dp, f), STAGE).replace("\\", "/")
        if rel != "SHA256SUMS.txt":
            files.append(rel)
files.sort()
dirs.sort()
lines = ["%s  %s" % (sha256(os.path.join(STAGE, r)), r) for r in files]
open(os.path.join(STAGE, "SHA256SUMS.txt"), "w", encoding="utf-8", newline="\n").write(
    "\n".join(lines) + "\n"
)
print("② 包内清单：%d 条（被哈希载荷文件）" % len(lines))

# ── ②b 文档路径存在性门槛（v3.7.4 重造）──────────────────────
# ⚠️ v3.7.3 的病：手写 6 份白名单，日志却写成「扫 .md/.txt/.log 内的」；
#    更糟的是白名单**不含 `source/SOURCE-IDENTITY.txt`**——正是它要防的那个文件。
SCOPE_NOTE = ("纳入：包内全部 .md ＋ 包根与 source/ 下的 .txt/.log；"
              "不扫：online-evidence/、sample-outputs/、human-review/（机器产物与原始响应）"
              "及 SHA256SUMS.txt（机器生成的哈希清单）")
ROOT_ENTRIES = set(os.listdir(STAGE)) | {"SHA256SUMS.txt"}
REL_PATH_RE = re.compile(r"(?<![\w./-])([A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+)")
HIST_DOC_RE = re.compile(r"^(REVIEW-RESPONSE|SIGNOFF)-v(\d+\.\d+\.\d+)-[0-9-]+\.md$")
NON_NARRATIVE_DIRS = ("online-evidence/", "sample-outputs/", "human-review/")
PATH_CHECK_ALLOW = {
    "online-evidence/history-secrets-scan.json":
        "GUIDE/RESPONSE 为说明 v3.7.3 复评 P3-2，**原文引述**当年写错的路径"
        "（正确路径为 source/history-secrets-scan.json）；此处属引述而非指向，故登记豁免",
}


def is_narrative_doc(rel):
    """叙述性文档的判据——**规则推导，不写文件名清单**"""
    if rel == "SHA256SUMS.txt":
        return False
    if rel.startswith(NON_NARRATIVE_DIRS):
        return False
    if rel.endswith(".md"):
        return True
    if rel.endswith((".txt", ".log")) and ("/" not in rel or rel.startswith("source/")):
        return True
    return False


def scan_doc_paths(doc_list):
    """返回 (命中处数, 缺失列表)——正式扫描与负向自测**共用同一实现**"""
    hits, missing = 0, []
    for rel in doc_list:
        text = open(os.path.join(STAGE, rel), encoding="utf-8", errors="ignore").read()
        for m in REL_PATH_RE.finditer(text):
            p = m.group(1).rstrip(".,;:、。）)】」'\"`")
            if p.startswith("..") or p.split("/")[0] not in ROOT_ENTRIES:
                continue
            if p in PATH_CHECK_ALLOW:
                continue
            hits += 1
            if not os.path.exists(os.path.join(STAGE, p)):
                missing.append("%s → %s" % (rel, p))
    return hits, missing


narrative = [r for r in files if is_narrative_doc(r)]
exempt_hist = []
for r in narrative:
    m = HIST_DOC_RE.match(os.path.basename(r))
    if m and m.group(2) != RELEASE.lstrip("v"):
        exempt_hist.append(r)
scanned_docs = [r for r in narrative if r not in exempt_hist]

# 负向自测：注入一个**必不存在**的包根相对路径，门槛必须报缺失
PROBE_REL = "_path-gate-probe.tmp.md"
probe_target = "source/not-exist-%s.json" % os.urandom(4).hex()
open(os.path.join(STAGE, PROBE_REL), "w", encoding="utf-8", newline="\n").write(probe_target + "\n")
_, probe_missing = scan_doc_paths([PROBE_REL])
os.remove(os.path.join(STAGE, PROBE_REL))
if not any(probe_target in m for m in probe_missing):
    sys.exit(
        "✗ 中止打包：文档路径门槛**负向自测未通过**——注入不存在的路径 %s 却未报缺失，"
        "说明这道门已失效（检查 ROOT_ENTRIES / REL_PATH_RE 是否还活着）" % probe_target
    )

doc_hits, doc_missing = scan_doc_paths(scanned_docs)
if doc_missing:
    sys.exit(
        "✗ 中止打包：文档中列出的**包根相对路径**在包内不存在 →\n   "
        + "\n   ".join(sorted(set(doc_missing)))
    )
print("②b 文档路径门槛")
print("   口径：%s" % SCOPE_NOTE)
print("   纳入 %d 份 → 实际扫描 %d 份（豁免 %d 份历史账），命中包根相对路径 %d 处 ⇒ **全部存在** ✓"
      % (len(narrative), len(scanned_docs), len(exempt_hist), doc_hits))
print("   负向自测：注入 %s ⇒ 门槛如期报缺失 ✓" % probe_target)
print("   豁免登记：%s" % "；".join("%s（%s）" % (k, v[:26] + "…") for k, v in PATH_CHECK_ALLOW.items()))
print("   扫描清单：%s" % "、".join(scanned_docs))

# ── ③ 外层 ZIP ───────────────────────────────────────────────
with zipfile.ZipFile(OUTER, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for d in dirs:
        z.writestr(zipfile.ZipInfo(d), b"")
    for r in sorted(files + ["SHA256SUMS.txt"]):
        z.write(os.path.join(STAGE, r), r)
outer_sha = sha256(OUTER)
with zipfile.ZipFile(OUTER) as z:
    names = z.namelist()
outer_entries = len(names)
outer_file_entries = len([n for n in names if not n.endswith("/")])
outer_dir_entries = outer_entries - outer_file_entries
print("③ 外层 ZIP：%s bytes / %d entries（文件 %d · 目录 %d）"
      % (format(os.path.getsize(OUTER), ","), outer_entries, outer_file_entries, outer_dir_entries))
print("   外层 SHA-256：%s" % outer_sha)

# ── ④ 解压最终 ZIP 到全新目录 ────────────────────────────────
if os.path.isdir(FINAL_EXTRACT):
    subprocess.run(["cmd", "/c", "rmdir", "/s", "/q", FINAL_EXTRACT], capture_output=True)
os.makedirs(FINAL_EXTRACT, exist_ok=True)
with zipfile.ZipFile(OUTER) as z:
    z.extractall(FINAL_EXTRACT)
inner = os.path.join(FINAL_EXTRACT, INNER_NAME)
with zipfile.ZipFile(inner) as z:
    z.extractall(os.path.join(FINAL_EXTRACT, "mcmeal-compass"))
print("④ 最终态已解压：%s" % FINAL_EXTRACT)

# ── ⑤ 在最终态上扫描 ────────────────────────────────────────
os.makedirs(REPORTS, exist_ok=True)
ph_json = os.path.join(REPORTS, "final-zip-scan.json")
ph = subprocess.run(
    [NODE, os.path.join(FINAL_EXTRACT, "check-placeholders.mjs"), "--dir", FINAL_EXTRACT,
     "--json", ph_json],
    capture_output=True, text=True, cwd=FINAL_EXTRACT,
)
ph_summary = [l for l in (ph.stdout + ph.stderr).splitlines() if "findings" in l]
print("⑤ 最终态占位扫描：%s" % (ph_summary[-1] if ph_summary else "(见报告)"))

ss_json = os.path.join(REPORTS, "final-zip-secrets-scan.json")
ss = subprocess.run(
    [NODE, os.path.join(FINAL_EXTRACT, "mcmeal-compass", "scripts", "secrets-scan.mjs"),
     "--json", ss_json, "--no-fail"],
    capture_output=True, text=True, cwd=os.path.join(FINAL_EXTRACT, "mcmeal-compass"),
)
ss_summary = [l for l in (ss.stdout + ss.stderr).splitlines() if "findings" in l]
print("   最终态凭据扫描：%s" % (ss_summary[-1] if ss_summary else "(见报告)"))

open(os.path.join(REPORTS, "final-zip-sha256.txt"), "w", encoding="utf-8", newline="\n").write(
    "artifact       : %s\nouter_sha256   : %s\nsize_bytes     : %d\nentries        : %d\n"
    "file_entries   : %d\ndir_entries    : %d\ninner_sha256   : %s\n"
    % (os.path.basename(OUTER), outer_sha, os.path.getsize(OUTER), outer_entries,
       outer_file_entries, outer_dir_entries, sha256(inner))
)

# ── ⑥ 机器生成清单（字段语义逐一定义）─────────────────────
cn = timezone(timedelta(hours=8))
manifest = {
    "releaseVersion": RELEASE,
    "packageVersion": PACKAGE_VERSION,
    "sourceCommit": git("rev-parse", "HEAD"),
    "sourceCommitShort": git("rev-parse", "--short", "HEAD"),
    "sourceTreeId": git("rev-parse", "HEAD^{tree}"),
    "commitCount": int(git("rev-list", "--count", "HEAD") or 0),
    "trackedFileCount": len([x for x in git("ls-files").splitlines() if x]),
    "branchAheadOfOrigin": git("status", "-sb").splitlines()[0] if git("status", "-sb") else "",
    "artifact": os.path.basename(OUTER),
    "artifactSha256": outer_sha,
    "artifactSizeBytes": os.path.getsize(OUTER),
    "artifactEntries": outer_entries,
    "artifactFileEntries": outer_file_entries,
    "artifactDirectoryEntries": outer_dir_entries,
    "hashedPayloadFileCount": len(files),
    "innerSourceZip": os.path.basename(inner),
    "innerSourceZipSha256": sha256(inner),
    "historyBundle": "source/mcmeal-compass-history.bundle",
    "historyBundleSha256": sha256(bundle_path),
    "packageRootScripts": {
        "repoTracked": {f: sha256(os.path.join(STAGE, f)) for f in tracked},
        "repoMissing": {f: sha256(os.path.join(STAGE, f)) for f in untracked},
        "assertion": "包根 `.mjs`/`.py` 与仓库 `scripts/`（或 `scripts/review-scaffolds/`、`scripts/release/`）同名件逐字节一致，否则打包中止",
    },
    "documentPathGate": {
        "scope": SCOPE_NOTE,
        "narrativeDocsFound": len(narrative),
        "documentsScanned": len(scanned_docs),
        "exemptedHistoricalDocs": exempt_hist,
        "rootRelativePathsFound": doc_hits,
        "missing": [],
        "negativeSelfTest": {
            "injectedPath": probe_target,
            "detected": True,
            "method": "注入必不存在的包根相对路径，门槛须报缺失，否则中止打包",
        },
        "assertion": "上述「纳入」范围内的文档，其中形如 `<包根一级条目>/…` 的相对路径必须存在，否则打包中止（v3.7.4 重造）",
    },
    "generatedAt": datetime.now(cn).isoformat(timespec="seconds"),
    "generatedBy": "scripts/release/pack.py（仓库内权威件；包根 tools/pack-release.py 为其同字节副本）",
    "fieldSemantics": {
        "artifactEntries": "外层 ZIP 的条目总数（含目录条目）",
        "artifactFileEntries": "外层 ZIP 中**文件**条目数",
        "artifactDirectoryEntries": "外层 ZIP 中**目录**条目数",
        "hashedPayloadFileCount": "SHA256SUMS.txt **实际列出**的文件数（= 文件条目数 − 清单自身，清单不能自哈希）",
        "documentPathGate.documentsScanned": "**实际扫描**的文档份数（= 纳入数 − 历史账豁免数），不是「包内所有文档」",
    },
    "note": "本清单与扫描报告**刻意置于包外**：对最终包的扫描报告若放进包内，会改变包内容而自指失真（v3.7.0 复评 P2）。",
}
open(os.path.join(REPORTS, "release-manifest.json"), "w", encoding="utf-8", newline="\n").write(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
)

print()
print("⑥ 包外报告目录：%s" % REPORTS)
for k in ("releaseVersion", "packageVersion", "sourceCommitShort", "sourceTreeId", "commitCount",
          "trackedFileCount", "artifactSha256", "artifactEntries", "artifactFileEntries",
          "artifactDirectoryEntries", "hashedPayloadFileCount", "historyBundleSha256",
          "generatedAt"):
    v = manifest[k]
    print("   %-24s %s" % (k, str(v)[:64]))
