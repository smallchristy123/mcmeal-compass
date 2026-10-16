/**
 * 源码身份材料生成（复评 v3.7.1 · P2）
 *
 * 复评原话：「源码 ZIP 不含 `.git` ……因此第三方无法从交付物证明：
 * 该源码 ZIP 的文件树确实等于所声明 commit；该仓库历史确有 N 个提交；Git 历史是否经过凭据扫描。」
 *
 * 本脚本把这三件事变成**可复算的交付物**：
 *   · `mcmeal-compass-history.bundle` —— 可达历史的 git bundle（第三方 `git clone` 即可复算 tree/提交数）；
 *   · `SOURCE-IDENTITY.txt` —— commit / tree id / 提交数 / 各产物 SHA-256 与复算命令；
 *   · `tree-listing.tsv` —— 逐文件 `blob sha1 · size · sha256 · path`，可与其解压后的源码树逐行比对。
 *
 * ⚠️ **只读仓库、只写输出目录**，不改动仓库本身。
 *
 * 用法：
 *   node scripts/source-identity.mjs --out <输出目录> [--ref HEAD]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = resolve(argOf('--out', join(ROOT, 'work', 'source-identity')));
const REF = argOf('--ref', 'HEAD');

/**
 * 版本号**从唯一版本源读取**（package.json → src/version.ts，由 `sync-version.mjs` 保证一致）。
 * 此处曾硬写 `mcmeal-compass-src-v3.7.2.zip`——那正是本项目的老病：
 * 文档里的版本/路径与实况背离。v3.7.3 复评 P3-2 一并修正。
 */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const gitBuf = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase();

mkdirSync(OUT, { recursive: true });

// ① 仓库身份
const commit = git('rev-parse', REF);
const tree = git('rev-parse', `${REF}^{tree}`);
const commitCount = Number(git('rev-list', '--count', REF));
const shortCommit = commit.slice(0, 7);

// ② bundle（可达历史）
const bundlePath = join(OUT, 'mcmeal-compass-history.bundle');
try {
  // 先删旧件，避免 bundle 追加语义导致体积膨胀
  execFileSync('git', ['bundle', 'create', bundlePath, '--all'], { cwd: ROOT, stdio: 'pipe' });
} catch (e) {
  // bundle 已存在时会拒绝覆盖
  execFileSync('git', ['bundle', 'create', bundlePath, '--all', '--force'], { cwd: ROOT, stdio: 'pipe' });
  void e;
}
const bundleBuf = readFileSync(bundlePath);
const bundleSha = sha256(bundleBuf);

// ③ 逐文件清单（blob sha1 · size · sha256 · path）
const lsTree = git('ls-tree', '-r', '-l', REF).split('\n').filter((l) => l.length > 0);
const rows = lsTree.map((line) => {
  // 形如：100644 blob <sha1> <size>\t<path>
  const m = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(\d+)\t(.*)$/.exec(line);
  if (!m) return null;
  const [, , , blobSha, size, path] = m;
  const content = gitBuf('cat-file', 'blob', blobSha);
  return { blobSha, size: Number(size), sha256: sha256(content), path };
});
const files = rows.filter((r) => r !== null);
const listing = files.map((r) => `${r.blobSha}\t${r.size}\t${r.sha256}\t${r.path}`).join('\n') + '\n';
const listingPath = join(OUT, 'tree-listing.tsv');
writeFileSync(listingPath, listing, 'utf8');
const listingSha = sha256(readFileSync(listingPath));

const totalBytes = files.reduce((s, r) => s + r.size, 0);

const identity = `McMeal Compass · 源码身份材料（复评 P2）
================================================================
生成时刻（本机本地时区） : ${new Date().toISOString()}
仓库 commit            : ${commit}
commit（短）           : ${shortCommit}
tree id                : ${tree}
提交总数（可达 HEAD）  : ${commitCount}
受控文件数             : ${files.length}
受控内容总字节         : ${totalBytes}

产物与指纹
----------------------------------------------------------------
mcmeal-compass-history.bundle  SHA-256  ${bundleSha}
                               大小     ${bundleBuf.length} 字节
tree-listing.tsv               SHA-256  ${listingSha}
                               行数     ${files.length}

第三方复算步骤（全部只读）
----------------------------------------------------------------
1) git clone mcmeal-compass-history.bundle repo && cd repo
2) git rev-parse HEAD                 # 应等于 ${commit}
3) git rev-parse HEAD^{tree}          # 应等于 ${tree}
4) git rev-list --count HEAD          # 应等于 ${commitCount}
5) 解压 mcmeal-compass-src-v${VERSION}.zip 后，逐文件核对 SHA-256 与 tree-listing.tsv 的第四列；
6) 历史凭据扫描：见 source/history-secrets-scan.json
   （扫描**输入**为该 bundle 克隆出的仓库，故 history.scanned=true 可复算）

⚠️ 说明：commit 与提交数为**构建端记录**；本材料的作用是让第三方能**独立复算**，
   而非要求其采信叙述。若 clone 后三者不符，即说明源码包与所声明提交不一致。
`;

writeFileSync(join(OUT, 'SOURCE-IDENTITY.txt'), identity, 'utf8');

console.log(`✓ 源码身份材料已生成于 ${OUT}`);
console.log(`  commit=${shortCommit} tree=${tree.slice(0, 12)}… 提交数=${commitCount} 文件数=${files.length}`);
console.log(`  bundle SHA-256=${bundleSha}`);
console.log(`  清单 SHA-256=${listingSha}`);
void statSync;
