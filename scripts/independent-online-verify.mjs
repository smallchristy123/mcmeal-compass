/**
 * 独立在线复核（v3.6.4）
 *
 * 目的：回应 v3.6.2 复评「建议执行方立即处理」第 2–4 条：
 *   ① **低负载、串行**的独立认证调用（initialize / query-meals / list-nutrition-foods /
 *      必要的 query-meal-detail / 一次价格调用）；
 *   ② 用**本次独立取到的**菜单与营养数据重算 A/B/C/D 分布，并给出 A 级逐项判据；
 *   ③ 独立原始响应、哈希、运行命令、环境说明一并归档。
 *
 * v3.6.4 修复（v3.6.3 复评 P1/P2）：
 *   · **P1 路径**：源码根改为**动态解析**——兼容「仓库 work/probes-online/」与
 *     「交付包根目录」两种布局，故本脚本可直接在**包根目录**运行（不再指向包外源码）；
 *   · **P2 字节数**：`responseBytes` 改用 `Buffer.byteLength(raw, 'utf8')`
 *     （原用 `raw.length` 是**字符数**，含中文时与 UTF-8 字节数不符），并另记 `responseChars`。
 *
 * 用法（**交付包根目录**，或仓库内均可）：
 *   1) unzip mcmeal-compass-src-*.zip -d mcmeal-compass
 *   2) (cd mcmeal-compass && npm install)
 *   3) node independent-online-verify.mjs
 *   （可用 SOURCE_ROOT=<…>/src 指定源码根；INDEPENDENT_OUT 指定输出目录，默认 ./independent-output）
 *
 * 凭据来源（**绝不回显明文**）：
 *   优先 `MCD_MCP_TOKEN`；未设则读本机 MCP 配置（`MCP_CONFIG` 或 `~/.workbuddy/mcp.json`）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── 源码根动态解析（P1 修复）──
const SRC_ROOT = (() => {
  const candidates = [
    process.env['SOURCE_ROOT'],
    join(HERE, 'mcmeal-compass', 'src'), // 交付包根目录：<pkg>/mcmeal-compass/src
    join(HERE, '..', '..', 'src'), // 仓库：work/probes-online/ → ../../src
    join(HERE, '..', 'src'),
    join(process.cwd(), 'mcmeal-compass', 'src'),
  ].filter((p) => typeof p === 'string' && p !== '');
  for (const c of candidates) {
    if (existsSync(join(c, 'mcp-client.ts'))) return resolve(c);
  }
  throw new Error(
    '未找到源码根（src/）。请在**交付包根目录**先把 mcmeal-compass-src-*.zip 解压到 mcmeal-compass/、' +
      '在该目录内 npm install，然后重试；也可用 SOURCE_ROOT=<…>/src 显式指定。',
  );
})();
const fromSrc = (rel) => pathToFileURL(join(SRC_ROOT, rel)).href;

const { McpClient } = await import(fromSrc('mcp-client.ts'));
const { extractOriginalResponse, parseToon, unwrapMcpEnvelope } = await import(fromSrc('toon.ts'));
const { QueryMealsDataSchema, RawMealDetailSchema, toMealDetail, toMenuItems, toNutritionRows } =
  await import(fromSrc('schema.ts'));
const { NutritionMatcher } = await import(fromSrc('matching.ts'));
const { DEFAULT_ALIASES } = await import(fromSrc('aliases.ts'));
const { analyzeMenu, looksLikeCombo } = await import(fromSrc('analyze.ts'));
const { localIsoNow } = await import(fromSrc('freshness.ts'));

const ENDPOINT = 'https://mcp.mcd.cn';
const STORE = process.env['INDEPENDENT_STORE'] ?? '3450021';
/** 第二阶段（套餐展开）串行调用之间的间隔（毫秒）——低负载 */
const DELAY_MS = Number(process.env['INDEPENDENT_DELAY_MS'] ?? 120);
const OUT_DIR = process.env['INDEPENDENT_OUT'] ?? 'independent-output';
const RAW_DIR = join(OUT_DIR, 'raw');

// ── 凭据解析（不回显） ──
const token = (() => {
  const env = process.env['MCD_MCP_TOKEN'];
  if (env) return { value: env, source: '环境变量 MCD_MCP_TOKEN' };
  const cfg = process.env['MCP_CONFIG'] ?? join(homedir(), '.workbuddy', 'mcp.json');
  const j = JSON.parse(readFileSync(cfg, 'utf8'));
  const auth = j?.mcpServers?.['mcd-mcp']?.headers?.Authorization ?? '';
  const v = String(auth).split(' ').slice(1).join(' ');
  if (!v) throw new Error('未找到可用的 MCP 凭据（环境变量与 mcp.json 均为空）');
  return { value: v, source: `本机 MCP 配置（${cfg}）` };
})();

const sha = (s) => createHash('sha256').update(s).digest('hex').toUpperCase();
/** UTF-8 字节数（P2 修复；区别于字符数） */
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP 层观测（客户端不外露 headers/status） ──
const httpLog = [];
const fetchImpl = async (url, init) => {
  const method = (() => {
    try {
      return JSON.parse(String(init?.body ?? '{}')).method ?? '?';
    } catch {
      return '?';
    }
  })();
  const res = await globalThis.fetch(url, init);
  const headers = {};
  for (const [k, v] of res.headers.entries()) headers[k] = v;
  httpLog.push({ at: localIsoNow(), status: res.status, method, headers });
  return res;
};

// 版本**唯一源**：package.json（复评 P2——本脚本此前硬写 0.1.0，会被当成旧版）
const PKG_VERSION = (() => {
  const dirs = [resolve(SRC_ROOT, '..'), resolve(SRC_ROOT, '..', '..'), process.cwd()];
  for (const d of dirs) {
    const p = join(d, 'package.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version;
  }
  return 'unknown';
})();

/** `src/version.ts` 里由 `scripts/sync-version.mjs` 生成的版本常量（用于自校验两者一致） */
const SRC_VERSION = (() => {
  const p = join(SRC_ROOT, 'version.ts');
  if (!existsSync(p)) return null;
  const m = /VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(p, 'utf8'));
  return m ? m[1] : null;
})();

const client = new McpClient({
  url: ENDPOINT,
  token: token.value,
  clientName: 'mcmeal-compass-independent-verify',
  clientVersion: PKG_VERSION,
  timeoutMs: 20000,
  /** 串行、低负载：不做重试，让真实结果如实呈现（限流就记限流） */
  maxRetries: 0,
  fetchImpl,
});

/** 参数脱敏：只保留业务字段（无凭据、无个人信息） */
const redactArgs = (args) => {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (/token|secret|auth|password/i.test(k)) continue;
    out[k] = v;
  }
  return out;
};

mkdirSync(RAW_DIR, { recursive: true });
const startedAt = localIsoNow();

const out = {
  runId: `independent-online-verify-${startedAt}`,
  at: startedAt,
  scriptVersion: 'v3.6.4（P1 路径动态解析 + P2 UTF-8 字节数）',
  /**
   * 本次运行**对外报给服务端的客户端版本**（复评 v3.7.1 · P2）。
   * 与 `package.json` 同源，故本文件可用来核对"运行路径确实用的是当前版本"，
   * 而不是只改了一个 `package.json` 的数字。
   */
  clientVersion: PKG_VERSION,
  purpose:
    'v3.6.2 复评建议：低负载串行的独立认证调用 + 用独立数据重算 A/B/C/D 分布 + 原始响应/哈希/命令归档',
  endpoint: ENDPOINT,
  storeCode: STORE,
  credential: { source: token.source, note: '明文凭据仅在进程环境/进程内传递，**未写入本文件**' },
  resolvedSourceRoot: SRC_ROOT,
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cwd: process.cwd(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
  },
  command: `node ${process.argv[1] ?? 'independent-online-verify.mjs'}   # INDEPENDENT_STORE=${STORE} INDEPENDENT_DELAY_MS=${DELAY_MS}`,
  protocol: null,
  calls: [],
  data: null,
  distribution: null,
  aLevelJustification: [],
  nonALevelSample: [],
  selfChecks: [],
};

const calls = [];
let seq = 0;

/** 一次**串行**工具调用，并如实留痕 */
const doCall = async (tool, args) => {
  const i = ++seq;
  const at = localIsoNow();
  const t0 = Date.now();
  const before = httpLog.length;
  let raw = null;
  let err = null;
  try {
    raw = await client.callToolRaw(tool, args);
  } catch (e) {
    err = e;
  }
  const http = httpLog[before] ?? null;
  const rec = {
    seq: i,
    tool,
    args: redactArgs(args),
    observedAt: at,
    durationMs: Date.now() - t0,
    httpStatus: http?.status ?? null,
    ok: raw !== null,
    responseChars: raw === null ? null : raw.length,
    /** UTF-8 字节数（P2 修复；此前误用字符数） */
    responseBytes: raw === null ? null : bytesOf(raw),
    responseSha256: raw === null ? null : sha(raw),
    envelope: null,
    serverDatetime: null,
    traceId: null,
    mcpError: err
      ? {
          code: String(err.code ?? 'UNKNOWN'),
          businessCode: err.businessCode ?? null,
          retryable: err.retryable ?? null,
          message: String(err.message ?? err).slice(0, 240),
        }
      : null,
  };
  if (raw !== null) {
    try {
      const env = extractOriginalResponse(raw);
      rec.envelope = env ? { success: env.success, code: env.code, message: env.message } : null;
      rec.serverDatetime = env?.datetime ?? null;
      rec.traceId = env?.traceId ?? null;
    } catch {
      /* 原文不是信封（如 SSE 包裹）——如实留 null */
    }
    writeFileSync(join(RAW_DIR, `${String(i).padStart(2, '0')}-${tool}.txt`), raw, 'utf8');
  }
  calls.push(rec);
  return { raw, err, rec };
};

// ── 阶段 1：低负载串行入口调用 ──
const info = await client.initialize();
out.protocol = {
  requested: '2025-06-18',
  era: info.era,
  serverVersion: info.version ?? null,
  negotiation: info.protocolNegotiation ?? 'n/a',
};

const menuRes = await doCall('query-meals', { storeCode: STORE, orderType: 1, beType: 1 });
await sleep(DELAY_MS);
const nutRes = await doCall('list-nutrition-foods', {});

const menuItems = menuRes.raw
  ? toMenuItems(QueryMealsDataSchema.parse(unwrapMcpEnvelope(menuRes.raw).data)).items
  : [];
const nutritionRows = nutRes.raw
  ? toNutritionRows(parseToon(unwrapMcpEnvelope(nutRes.raw).data)).rows
  : [];

// 第一个套餐（用于 query-meal-detail 探针）+ 第一个单品（用于计价探针）
const comboItem = menuItems
  .filter((i) => looksLikeCombo(i.name))
  .sort((a, b) => (a.currentPrice ?? 0) - (b.currentPrice ?? 0))[0];
const singleItem = menuItems.filter((i) => !looksLikeCombo(i.name) && i.currentPrice !== null)[0];

await sleep(DELAY_MS);
const detailRes = comboItem
  ? await doCall('query-meal-detail', { storeCode: STORE, orderType: 1, beType: 1, code: comboItem.code })
  : null;
await sleep(DELAY_MS);
if (singleItem) {
  await doCall('calculate-price', {
    storeCode: STORE,
    orderType: 1,
    beType: 1,
    items: [{ productCode: singleItem.code, quantity: 1 }],
  });
}

// ── 阶段 2：串行取齐套餐详情（低负载；用于展开后重算分布） ──
const comboCodes = menuItems.filter((i) => looksLikeCombo(i.name)).map((i) => i.code);
const details = new Map();
if (detailRes?.raw && comboItem) {
  try {
    details.set(comboItem.code, toMealDetail(RawMealDetailSchema.parse(unwrapMcpEnvelope(detailRes.raw).data)));
  } catch {
    /* 解析失败则留空，由分析层如实降级 */
  }
}
for (const code of comboCodes) {
  if (details.has(code)) continue;
  await sleep(DELAY_MS);
  const r = await doCall('query-meal-detail', { storeCode: STORE, orderType: 1, beType: 1, code });
  if (r.raw) {
    try {
      details.set(code, toMealDetail(RawMealDetailSchema.parse(unwrapMcpEnvelope(r.raw).data)));
    } catch {
      /* 单个失败不影响其余 */
    }
  }
}

// ── 用**独立取到的数据**重算分布 ──
const matcher = new NutritionMatcher(nutritionRows, { aliases: DEFAULT_ALIASES });
const loadDetail = async (code) => details.get(code) ?? null;
const { items: analyzed } = await analyzeMenu(menuItems, matcher, loadDetail, {});

const dist = { A: 0, B: 0, C: 0, D: 0 };
for (const it of analyzed) dist[it.confidence] += 1;

out.data = {
  menuItems: menuItems.length,
  nutritionRows: nutritionRows.length,
  combosDetected: comboCodes.length,
  comboDetailsExpanded: details.size,
  analyzed: analyzed.length,
};
out.distribution = { counts: dist, total: analyzed.length };

// A 级逐项判据（A 必须是：官方单品精确直配 + 营养完整 + 无别名推断）
for (const it of analyzed.filter((i) => i.confidence === 'A')) {
  const m = matcher.match({ code: it.code, name: it.name });
  out.aLevelJustification.push({
    code: it.code,
    name: it.name,
    kind: it.kind,
    matchMethod: m.method,
    confidenceFromMatcher: m.confidence,
    isExactDirect: m.method === 'code-mapping' || m.method === 'exact-name',
    hasInferenceNotes: m.notes.some((n) => /推断|risky|降为/.test(n)),
    evidence: it.evidence.map((e) => e.label).slice(0, 3),
  });
}
// 反例抽查：B/C/D 各取前 3，供第三方核对「为何不升 A」
out.nonALevelSample = ['B', 'C', 'D'].map((lv) => ({
  level: lv,
  sample: analyzed
    .filter((i) => i.confidence === lv)
    .slice(0, 3)
    .map((i) => ({ code: i.code, name: i.name, kind: i.kind, notes: i.notes.slice(0, 2) })),
}));

out.calls = calls;
out.summary = {
  totalCalls: calls.length,
  ok: calls.filter((c) => c.ok).length,
  failed: calls.filter((c) => !c.ok).length,
  httpStatusCounts: calls.reduce((a, c) => {
    const k = String(c.httpStatus ?? 'ERR');
    a[k] = (a[k] ?? 0) + 1;
    return a;
  }, {}),
  rateLimitedHits: calls.filter((c) => c.mcpError?.code === 'RATE_LIMITED').length,
  note: `串行低负载：每次调用间隔 ${DELAY_MS} ms；未重试（maxRetries=0），限流如实记录。`,
};

// ── 自检（把 P1/P2 的修复做成机检断言）──
const rawFileOf = (c) => join(RAW_DIR, `${String(c.seq).padStart(2, '0')}-${c.tool}.txt`);
const withRaw = calls.filter((c) => c.ok);
out.selfChecks = [
  {
    id: 'P1-source-root-resolved',
    pass: SRC_ROOT.length > 0 && existsSync(join(SRC_ROOT, 'mcp-client.ts')),
    note: `源码根动态解析：${SRC_ROOT}`,
  },
  {
    id: 'P2-responseBytes-is-utf8-bytes',
    pass: withRaw.every((c) => c.responseBytes === bytesOf(readFileSync(rawFileOf(c), 'utf8'))),
    note: '每条 responseBytes 必须等于其原始响应文本的 UTF-8 字节数',
  },
  {
    id: 'P2-bytes-differ-from-chars-on-cjk',
    pass: withRaw.some((c) => c.responseBytes !== c.responseChars),
    note: `含中文响应中「字节数 ≠ 字符数」的条数：${withRaw.filter((c) => c.responseBytes !== c.responseChars).length}/${withRaw.length}（证明二者口径确实不同）`,
  },
  {
    // 复评 v3.7.1 · P2：版本身份必须**在运行路径上**生效，而不是只改了 package.json
    id: 'P2-version-source-consistent',
    pass: SRC_VERSION !== null && SRC_VERSION === PKG_VERSION,
    note: `package.json=${PKG_VERSION}｜src/version.ts=${SRC_VERSION ?? '(未找到)'}｜本次对外报的 clientInfo.version=${PKG_VERSION}`,
  },
];
out.evidenceHash = sha(JSON.stringify(calls));

writeFileSync(join(OUT_DIR, 'independent-online-verify.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
