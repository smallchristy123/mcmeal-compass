/**
 * 真实限流样本取证（v3.6.1 复评「仍未闭环三项」之第 1 项）。
 *
 * 目标：在**真实端点**上触发一次官方限流（HTTP 429），并留下可核对的原始证据。
 *
 * 设计要点（有节制）：
 *   · 用 McpClient 的真实协议路径（legacy 握手 + 会话 id），请求 `calculate-price`（业务真实调用）；
 *   · `maxRetries = 0` —— 否则客户端的有界退避会把 429 吞掉，观测不到；
 *   · 注入 `fetchImpl` 包装器，**记录每个响应的 HTTP 状态与响应头**（客户端本身不外露 headers）；
 *   · 并发梯度 12 → 24 → 40，**一见 429 立即停止**（不再无谓多打）；
 *   · 同时统计「触发前 60 秒内实际发出的请求数」，作为**实测阈值**证据。
 *
 * 用法（需 MCD_MCP_TOKEN）：
 *   MCD_MCP_TOKEN=... node work/probes-online/ratelimit-probe.mjs
 */
import { createHash } from 'node:crypto';
import { McpClient } from '../../src/mcp-client.ts';

const token = process.env['MCD_MCP_TOKEN'] ?? '';
if (!token) {
  console.error('缺环境变量 MCD_MCP_TOKEN');
  process.exit(2);
}

const ENDPOINT = 'https://mcp.mcd.cn';
const STORE = process.env['PROBE_STORE'] ?? '3450024';
/** 硬上限：即便未触发也到此为止（避免无节制打端点） */
const TOTAL_CAP = Number(process.env['PROBE_CAP'] ?? 1500);
/** 总体墙钟上限（秒） */
const WALL_CAP_S = Number(process.env['PROBE_WALL_S'] ?? 150);
/** 每档并发放几波（可用 PROBE_WAVES 配合串行档做精确归因） */
const WAVES = Number(process.env['PROBE_WAVES'] ?? 4);
/** 并发梯度（PROBE_LADDER=1 可做**串行**对照，用于精确归因重试次数） */
const LADDER = (process.env['PROBE_LADDER'] ?? '12,24,40')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// ── HTTP 层观测（记录状态、method 与响应头；客户端不外露 headers，故在此包装）──
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
  httpLog.push({ at: new Date().toISOString(), status: res.status, method, headers });
  return res;
};

/** 客户端重试次数（默认 0：让 508 立刻浮出；设 2 可观测真实重试/退避） */
const MAX_RETRIES = Number(process.env['PROBE_MAX_RETRIES'] ?? 0);

const client = new McpClient({
  url: ENDPOINT,
  token,
  clientName: 'mcmeal-compass-ratelimit-probe',
  clientVersion: '0.1.0',
  timeoutMs: 15000,
  maxRetries: MAX_RETRIES,
  fetchImpl,
});

const startedAt = Date.now();
const out = {
  runId: `online-ratelimit-probe-${new Date().toISOString()}`,
  at: new Date().toISOString(),
  endpoint: ENDPOINT,
  storeCode: STORE,
  protocol: null,
  documentedLimit: '每 Token 每分钟最多 600 次请求，超限返回 429（来源：MCP_INTEGRATION.md §1）',
  plan: {
    concurrencyLadder: LADDER,
    totalCap: TOTAL_CAP,
    wallCapSeconds: WALL_CAP_S,
    maxRetries: MAX_RETRIES,
  },
  warmup: null,
  requests: [], // 每请求：序号/并发档/开始/耗时/结果
  httpStatusCounts: {}, // 汇总
  rateLimitHit: null,
  summary: null,
};

const info = await client.initialize();
/** 握手阶段的 HTTP 次数（initialize + notifications/initialized），用于把「重试额外次数」算准 */
const handshakeHttpCalls = httpLog.length;
out.protocol = {
  requested: '2025-06-18',
  era: info.era,
  serverVersion: info.version ?? null,
  negotiation: info.protocolNegotiation ?? 'n/a',
};

let seq = 0;
const record = (row) => {
  out.requests.push(row);
  const key = String(row.httpStatus ?? (row.ok ? 200 : 'ERR'));
  out.httpStatusCounts[key] = (out.httpStatusCounts[key] ?? 0) + 1;
};

/** 单次真实计价请求；返回结果，不抛。 */
const oneRequest = async (conc) => {
  const i = ++seq;
  const t0 = new Date().toISOString();
  const s = Date.now();
  const httpBefore = httpLog.length;
  try {
    await client.callToolRaw('calculate-price', {
      storeCode: STORE,
      orderType: 1,
      beType: 1,
      items: [{ productCode: '1440', quantity: 1 }],
    });
    const http = httpLog[httpBefore] ?? null;
    return {
      i,
      conc,
      at: t0,
      durationMs: Date.now() - s,
      ok: true,
      httpStatus: http?.status ?? 200,
      // ⚠️ 并发下这是「本请求在途期间共享日志的增长量」，**不能**单独归因到本请求（仅 conc=1 时精确）
      httpCallsSeenWhileInFlight: httpLog.length - httpBefore,
    };
  } catch (e) {
    const http = httpLog[httpBefore] ?? null;
    return {
      i,
      conc,
      at: t0,
      durationMs: Date.now() - s,
      ok: false,
      httpStatus: http?.status ?? null,
      httpCallsSeenWhileInFlight: httpLog.length - httpBefore,
      code: e?.code ?? null,
      businessCode: e?.businessCode ?? null,
      message: String(e?.message ?? e).slice(0, 300),
      retryable: e?.retryable ?? null,
      status: e?.status ?? null,
      hint: e?.hint ?? null,
    };
  }
};

/** 触发前 60 秒内的请求数（实测阈值证据） */
const inLast60s = (rows) => {
  const t = Date.now();
  return rows.filter((r) => t - Date.parse(r.at) <= 60_000).length;
};

// ── 预热：确认通路健康（1 次）──
out.warmup = await oneRequest(1);
record({ ...out.warmup, phase: 'warmup' });

let hit = null;
outer: for (const conc of LADDER) {
  // 每档放 WAVES 波，每波 conc 个并发
  for (let wave = 0; wave < WAVES; wave++) {
    const batch = await Promise.all(Array.from({ length: conc }, () => oneRequest(conc)));
    // ⚠️ 必须**先全部入账、再判中断**：否则中断那一批里排在后面的请求
    //    已发出却未记录，会让「tools/call 总数 − 业务调用数」虚高（曾被误读成"重试"）。
    for (const r of batch) record(r);
    const bad = batch.find((r) => !r.ok && (r.code === 'RATE_LIMITED' || r.status === 429));
    if (bad) {
      hit = bad;
      break outer;
    }
    if (seq >= TOTAL_CAP || (Date.now() - startedAt) / 1000 >= WALL_CAP_S) break outer;
  }
}

// ── 汇总 ──
const failed = out.requests.filter((r) => !r.ok);
out.rateLimitHit = hit
  ? {
      observed: true,
      at: hit.at,
      seq: hit.i,
      concurrencyAtHit: hit.conc,
      httpStatus: hit.httpStatus,
      clientCode: hit.code,
      clientStatus: hit.status,
      retryable: hit.retryable,
      message: hit.message,
      hint: hit.hint,
      requestsInLast60sAtHit: inLast60s(out.requests),
      requestsTotalAtHit: out.requests.length,
      // 该 429 响应的原始响应头（限流头若存在，这里就能看到）
      rateLimitHeaders: (() => {
        const entry = [...httpLog].reverse().find((h) => h.status === 429);
        return entry ? entry.headers : null;
      })(),
    }
  : { observed: false, note: '在本次上限内未触发 429（未达阈值）' };

/** 按 method 归因的 HTTP 计数（并发下唯一可靠的归因口径） */
const httpByMethod = {};
for (const h of httpLog) httpByMethod[h.method] = (httpByMethod[h.method] ?? 0) + 1;
const businessHttpCalls = httpByMethod['tools/call'] ?? 0;

out.summary = {
  totalRequests: out.requests.length,
  /** 真实发出的 HTTP 次数（含握手） */
  totalHttpCalls: httpLog.length,
  /** 按 method 归因 */
  httpByMethod,
  /**
   * 因**重试**而额外发出的 `tools/call` 次数 = 实际 tools/call 次数 − 业务调用次数。
   * （握手只发 initialize + notifications/initialized，不含 tools/call，故无需扣除。）
   * 业务层的限流重试与 HTTP 层的重试都会计入此数。
   */
  retryExtraHttpCalls: businessHttpCalls - out.requests.length,
  /** 归因说明：单请求的 httpCallsSeenWhileInFlight 在并发下不可单独归因，勿用于重试计数 */
  attributionNote:
    '重试计数以「tools/call 总次数 − 业务调用次数」为准；单请求字段仅 conc=1 时精确。',
  ok: out.requests.length - failed.length,
  failed: failed.length,
  elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
  peakRequestsIn60s: Math.max(
    ...out.requests.map((_, idx) => inLast60s(out.requests.slice(0, idx + 1))),
    out.requests.length,
  ),
  httpStatusCounts: out.httpStatusCounts,
  firstFailure: failed[0] ?? null,
  distinctFailureCodes: [...new Set(failed.map((r) => `${r.httpStatus}/${r.code}`))],
};

// ── 证据自校验哈希（对 requests 数组做摘要，防事后改动）──
out.evidenceHash = createHash('sha256')
  .update(JSON.stringify(out.requests))
  .digest('hex')
  .toUpperCase();

console.log(JSON.stringify(out, null, 2));
