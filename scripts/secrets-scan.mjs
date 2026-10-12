/**
 * secrets scan —— 凭据扫描（复评必办项）
 *
 * 扫两处：
 *   ① **现役工作树**（含未跟踪文件，跳过 node_modules/.git/dist/coverage 与本地副本目录 work/）；
 *   ② **git 全历史**（`git log --all -p` 的全部补丁行——覆盖任何「曾经提交过」的内容）。
 *
 * 判据（高置信凭据形态）：
 *   · `Authorization: Bearer <token>` 形态（长度 ≥16）
 *   · OpenAI 风格 `sk-...`／AWS `AKIA...`／私钥头 `-----BEGIN ... PRIVATE KEY-----`
 *   · `token|secret|password|api_key` 后紧跟长度 ≥16 的字面量
 *
 * **白名单**（记为 allowed，不计入 findings）：
 *   · 占位符（`${...}`、`你的…`、`YOUR_…`、`<...>`、`xxx`）
 *   · 官方响应里的 `traceId` / `datetime` / sha256 摘要字段（32–64 位十六进制，**不是**凭据）
 *   · 本仓库自身的约定：`MCD_MCP_TOKEN` 只以环境变量名出现
 *
 * 用法：
 *   node scripts/secrets-scan.mjs [--json <out.json>] [--no-fail]
 * 退出码：发现 findings → 1（可用 --no-fail 强制 0）
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'work']);

const RULES = [
  { id: 'bearer-token', re: /Bearer\s+[A-Za-z0-9\-_.=+/]{16,}/g },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    id: 'assigned-secret',
    re: /\b(?:api[_-]?key|secret|token|passwd|password)\s*[:=]\s*["'`][A-Za-z0-9\-_./+]{16,}["'`]/gi,
  },
];

/** 该命中是否属白名单（占位符 / 测试假值 / 官方响应摘要字段） */
const allowReason = (line, path, match) => {
  if (/\$\{|你的|YOUR_|<[^>]{2,}>|xxx|XXXX|PLACEHOLDER|placeholder/i.test(line)) return '占位符';
  // 测试专用假值（TESTONLY / DUMMY / FAKE / EXAMPLE / SAMPLE）
  if (/(TESTONLY|TEST_|_TEST|DUMMY|FAKE|EXAMPLE|SAMPLE)/i.test(match)) return '测试用假值（非真实凭据）';
  if (/traceId|datetime|sha256|sha-?1|md5|hash/i.test(line)) return '官方响应摘要字段';
  if (/mcp-config\.example\.json/.test(path) && /MCD_MCP_TOKEN/.test(line)) return '示例配置的环境变量引用';
  // 32/64 位纯十六进制且上下文无 token/key 关键字 → 摘要而非凭据
  if (/^[0-9a-f]{32}$/i.test(match) || /^[0-9a-f]{64}$/i.test(match)) return '疑似摘要（非凭据）';
  return null;
};

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push({ path: p, rel: relative(ROOT, p).split(sep).join('/') });
  }
  return out;
};

const findings = [];
const allowed = [];
let scannedFiles = 0;
let scannedBytes = 0;

const scanText = (text, where, path) => {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const reason = allowReason(line, path, m[0]);
        const rec = {
          where,
          path,
          line: i + 1,
          rule: rule.id,
          excerpt: line.trim().slice(0, 160),
        };
        if (reason === null) findings.push(rec);
        else allowed.push({ ...rec, reason });
      }
    }
  }
};

// ① 工作树
const files = walk(ROOT);
for (const f of files) {
  let st;
  try {
    st = statSync(f.path);
  } catch {
    continue;
  }
  if (st.size > 8 * 1024 * 1024) continue; // 跳过超大文件（夹具等），另行按需细查
  let text;
  try {
    text = readFileSync(f.path, 'utf8');
  } catch {
    continue;
  }
  scannedFiles++;
  scannedBytes += text.length;
  scanText(text, 'worktree', f.rel);
}

// ② git 全历史（所有补丁行）
//
// ⚠️ Windows/沙箱环境下，Node 子进程 spawn git 可能间歇性 `EBUSY`
//    （实测：连 `git --version` 都会失败，而同一个 shell 里直接跑 git 正常）。
//    故提供**稳妥且可复现**的路径：先由 shell 导出补丁，再让本脚本读文件——
//      git log --all -p --no-color --unified=0 > history-patch.txt
//      node scripts/secrets-scan.mjs --history-file history-patch.txt
//    未给 --history-file 时才尝试自己 spawn（在支持的环境下依然可用）。
const histIdx = process.argv.indexOf('--history-file');
const historyFile = histIdx >= 0 ? process.argv[histIdx + 1] : null;

let historyCommits = 0;
let historyLines = 0;
let historyScanned = false;
let historySource = historyFile ?? '(spawn)';

if (historyFile) {
  try {
    const text = readFileSync(historyFile, 'utf8');
    // 默认 `git log -p` 的提交头是 `commit <sha>` 行
    historyCommits = (text.match(/^commit [0-9a-f]{40}/gm) ?? []).length;
    historyLines = text.split('\n').length;
    scanText(text, 'git-history', historyFile);
    historyScanned = true;
  } catch (e) {
    allowed.push({
      where: 'git-history',
      path: historyFile,
      line: 0,
      rule: 'scan-error',
      excerpt: String(e).slice(0, 120),
      reason: '历史文件不可读（**结论仅为「工作树 clean」，不代表历史已扫**）',
    });
  }
}

const GIT_CANDIDATES = [
  process.env['GIT_EXE'],
  'git',
  'git.exe',
  'C:/Program Files/Git/cmd/git.exe',
  'C:/Program Files/Git/bin/git.exe',
  '/mingw64/bin/git.exe',
  'D:/Program/WorkBuddy/resources/vendor/PortableGit/mingw64/bin/git.exe',
  'D:/Program/WorkBuddy/resources/vendor/PortableGit/cmd/git.exe',
].filter(Boolean);

/** Windows 下 `spawnSync git EBUSY`（按无扩展名 spawn 找不到可执行文件）→ 逐个候选探测 */
const resolveGit = () => {
  for (const c of GIT_CANDIDATES) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
};

const gitCmd = historyScanned ? null : resolveGit();
if (!historyScanned && gitCmd === null) {
  allowed.push({
    where: 'git-history',
    path: '-',
    line: 0,
    rule: 'scan-unavailable',
    excerpt: '未找到可用的 git 可执行文件（且未提供 --history-file）',
    reason: '历史扫描不可用（**结论仅为「工作树 clean」，不代表历史已扫**）',
  });
} else if (!historyScanned) {
  const gitArgs = ['log', '--all', '-p', '--no-color', '--unified=0', '--pretty=format:__COMMIT__%H'];
  const run = () =>
    execFileSync(gitCmd, gitArgs, {
      cwd: ROOT,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    });
  try {
    let log;
    try {
      log = run();
    } catch {
      log = run(); // 重试一次（EBUSY 多为瞬时占用）
    }
    historyCommits = (log.match(/__COMMIT__[0-9a-f]{40}/g) ?? []).length;
    historyLines = log.split('\n').length;
    scanText(log, 'git-history', '(all patches)');
    historyScanned = true;
    historySource = gitCmd;
  } catch (e) {
    allowed.push({
      where: 'git-history',
      path: '-',
      line: 0,
      rule: 'scan-error',
      excerpt: String(e).slice(0, 120),
      reason: '历史扫描不可用（**结论仅为「工作树 clean」，不代表历史已扫**）',
    });
  }
}

const report = {
  runId: `secrets-scan-${new Date().toISOString()}`,
  at: new Date().toISOString(),
  scope: {
    worktree: { files: scannedFiles, chars: scannedBytes },
    history: { scanned: historyScanned, commits: historyCommits, lines: historyLines, source: historySource },
    skippedDirs: [...SKIP_DIRS],
  },
  rules: RULES.map((r) => r.id),
  findings,
  allowed,
  // 诚实三态：命中即 review-needed；否则「历史也扫过」才敢说 clean，否则只是 partial
  verdict: findings.length > 0 ? 'review-needed' : historyScanned ? 'clean' : 'partial',
};
report.reportHash = createHash('sha256').update(JSON.stringify({ findings, allowed })).digest('hex').toUpperCase();

const outIdx = process.argv.indexOf('--json');
if (outIdx >= 0 && process.argv[outIdx + 1]) writeFileSync(process.argv[outIdx + 1], JSON.stringify(report, null, 2), 'utf8');

console.log(JSON.stringify(report, null, 2));
console.error(
  `\n[secrets-scan] 工作树 ${scannedFiles} 文件 / 历史 ${historyCommits} 提交 → ` +
    `findings=${findings.length} allowed=${allowed.length} verdict=${report.verdict}`,
);
process.exit(findings.length === 0 || process.argv.includes('--no-fail') ? 0 : 1);
