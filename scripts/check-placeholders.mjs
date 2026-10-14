/**
 * 占位文字 / 时间戳合规检查（v3.6.5）
 *
 * 缘由：v3.6.4 复评指出 `MCP_INTEGRATION.md` 在已有真实实测之后**仍留着未实测的占位字样**，
 * 会让读者误以为该接口尚未验证；同一轮还指出归档日志里写了个**非法时间戳**。
 * 这两类"文档债"不痛不痒，却会一再被复评揪出来——故做成**机器可查**的一道门：
 * 凡占位字样或非法时间戳，要么删除、要么写进白名单并注明缘由与**解除条件**。
 *
 * 用法：
 *   node scripts/check-placeholders.mjs                     # 扫仓库受版本控制的文本文件
 *   node scripts/check-placeholders.mjs --dir <path>        # 额外递归扫某个目录（如待打包的包根）
 *   node scripts/check-placeholders.mjs --json <out.json>   # 另存 JSON 报告
 *
 * 退出码：0 = clean；1 = 有 findings。
 *
 * 注：本文件自身**刻意不出现**任何被检字样——模式由字符串拼接构造，以免自检自伤。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'work', 'fixtures']);
const TEXT_EXT = /\.(md|txt|json|jsonl|log|ts|mjs|cjs|js|ya?ml|html?|csv)$/i;

/** 由片段拼造正则，避免本文件出现被检字样 */
const M = (...parts) => new RegExp(parts.join(''));

/** 占位字样（新增模式时请一并写明「为什么它算占位」） */
const PATTERNS = [
  { id: 'unverified-placeholder', re: M('待', '实测'), why: '未实测类占位——若已实测必须删除' },
  { id: 'tofill-placeholder', re: M('【待', '补】|【待', '填】'), why: '待补/待填类占位' },
  { id: 'tbd', re: M('\\b', 'T', 'B', 'D', '\\b'), why: '待定标记（三字母缩写占位）' },
  { id: 'lorem', re: M('lorem', ' ', 'ipsum'), why: '模板残留填充文本' },
];

/** 形如 ISO 的时间串；逐个 `Date.parse`，不可解析即为非法 */
const ISO_LIKE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{1,2}[0-9A-Za-z:.+\-]*/g;
const badTimestamps = (line) => (line.match(ISO_LIKE) ?? []).filter((m) => Number.isNaN(Date.parse(m)));

/**
 * 白名单：确属**正当保留**者——须写明缘由与**解除条件**。
 * 不在白名单内者一律视为待修。
 */
const ALLOW = [
  {
    file: 'scripts/review-samples.ts',
    patternIds: ['tofill-placeholder'],
    why: '此处是该字样是**待填样本表的列名常量**（表头），属设计而非文档欠债——人填表全靠这些列名。',
    lift: '若日后改用不带该字样的列名，本条白名单即应删除。',
  },
];

/** 按**文件名**放行（用于包根扫描：样本表表头天生带该字样） */
const ALLOW_BY_BASENAME = [
  {
    re: /^human-review-samples-.*\.csv$/,
    patternIds: ['tofill-placeholder'],
    why: '待填样本表的**列名即表头**，属设计（人填表靠这些列名），且随包分发以便复核。',
    lift: '若日后改用不带该字样的列名，本条白名单即应删除。',
  },
  {
    re: /^.*placeholders?-check.*\.json$/i,
    patternIds: ['unverified-placeholder', 'tofill-placeholder', 'tbd', 'lorem', 'bad-timestamp'],
    why: '**本检查器自身的机器可读报告**（无论文件名前缀与变体）——按设计要引用它所检出的字符串（含白名单项的摘录）作为凭据。',
    lift: '不需解除——除非报告改为不记录摘录。',
  },
  {
    re: /^review-samples\.ts$/,
    patternIds: ['tofill-placeholder'],
    why: '待填样本表的**列名常量**所在源码（随内层源码包分发，且包内无 `.git` 故路径白名单不生效）。',
    lift: '若日后改用不带该字样的列名，本条白名单即应删除。',
  },
  {
    re: /^git-history-patch\.txt$/,
    patternIds: ['unverified-placeholder', 'tofill-placeholder', 'tbd', 'lorem', 'bad-timestamp'],
    why: '**git 全历史补丁原文**，按定义逐字含各次提交的行（包括后来被改掉的旧字样与旧时间串），供第三方独立重扫。',
    lift: '不需解除——除非不再随包分发该证据文件。',
  },
];

const args = process.argv.slice(2);
const extraDir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null;

const tracked = (() => {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
})();

const findings = [];
const allowed = [];

const check = (relPath, absPath, inExtra) => {
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return;
  }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const p of PATTERNS) {
      if (!p.re.test(line)) continue;
      const hit = { file: relPath, line: i + 1, pattern: p.id, why: p.why, excerpt: line.trim().slice(0, 120) };
      const base = relPath.split('/').pop() ?? relPath;
      const byName = ALLOW_BY_BASENAME.find((a) => a.re.test(base) && a.patternIds.includes(p.id));
      const wl = !inExtra && ALLOW.find((a) => a.file === relPath && a.patternIds.includes(p.id));
      if (byName) allowed.push({ ...hit, allowReason: byName.why, lift: byName.lift });
      else if (wl) allowed.push({ ...hit, allowReason: wl.why, lift: wl.lift });
      else findings.push(hit);
    }
    for (const bad of badTimestamps(line)) {
      const hit = {
        file: relPath,
        line: i + 1,
        pattern: 'bad-timestamp',
        why: '时间戳不合法（ISO 8601 无法解析）',
        excerpt: bad,
      };
      // ⚠️ 与占位字样走**同一套白名单**——否则原始 git 补丁里的旧时间串会被误拦
      const base2 = relPath.split('/').pop() ?? relPath;
      const byName2 = ALLOW_BY_BASENAME.find((a) => a.re.test(base2) && a.patternIds.includes('bad-timestamp'));
      const wl2 = !inExtra && ALLOW.find((a) => a.file === relPath && a.patternIds.includes('bad-timestamp'));
      if (byName2) allowed.push({ ...hit, allowReason: byName2.why, lift: byName2.lift });
      else if (wl2) allowed.push({ ...hit, allowReason: wl2.why, lift: wl2.lift });
      else findings.push(hit);
    }
  });
};

for (const rel of tracked) {
  if (!TEXT_EXT.test(rel)) continue;
  if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
  check(rel, join(ROOT, rel), false);
}

let extraScanned = 0;
if (extraDir) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(abs);
      } else if (TEXT_EXT.test(name)) {
        extraScanned += 1;
        check(relative(ROOT, abs).split('\\').join('/'), abs, true);
      }
    }
  };
  walk(extraDir);
}

const report = {
  at: new Date().toISOString(),
  trackedFiles: tracked.length,
  extraDir: extraDir ?? null,
  extraScanned,
  patterns: [...PATTERNS.map((p) => p.id), 'bad-timestamp'],
  findings,
  allowed,
  verdict: findings.length === 0 ? 'clean' : 'review-needed',
};
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8');

console.log(
  `[check-placeholders] 已跟踪 ${tracked.length} 文件` +
    (extraDir ? ` + 目录扫描 ${extraScanned} 文件（${extraDir}）` : '') +
    ` → findings=${findings.length} allowed=${allowed.length} verdict=${report.verdict}`,
);
for (const f of findings) console.log(`  ✗ ${f.file}:${f.line} [${f.pattern}] ${f.excerpt}`);
for (const a of allowed) console.log(`  · 白名单 ${a.file}:${a.line} [${a.pattern}] — ${a.allowReason}｜解除：${a.lift}`);

process.exit(findings.length === 0 ? 0 : 1);
