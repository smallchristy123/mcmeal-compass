/**
 * MCP 客户端与门店/菜单适配（T1.3）
 *
 * 实测口径（见 docs/API_PROBE_NOTES.md）：
 *   · 端点：`https://mcp.mcd.cn` —— **根路径**（`/mcp`、`/sse` 等一律 404）
 *   · 协议：2025-06-18；鉴权：`Authorization: Bearer <TOKEN>`
 *   · 返回：`content[0].text` 是「文档说明 + 原始 JSON」混合，JSON 体在 `## Original Response` 之后
 *
 * 协议兼容（外部评审 P0-2 的处置）：
 *   · 本客户端同时支持 **legacy（握手时代，2025-11-25 及更早）** 与 **modern（2026-07-28 起，无握手）** 两种形态；
 *   · 响应同时支持 **JSON** 与 **SSE（`text/event-stream`）** 两条解析路径；
 *   · legacy 路径回传 `Mcp-Session-Id`（若服务端下发）并补发 `notifications/initialized`；
 *   · 遇 `UnsupportedProtocolVersionError`（-32022）会明确指出服务端支持的版本，便于协商；
 *   · 不假设 id 一定对应——收到不匹配的响应即判 BAD_RESPONSE。
 *
 * 三条安全底线：
 *   1. **绝不把 Token 写进任何错误信息、日志或异常栈**（计划书 T02）；
 *   2. **有界退避**——429 / 5xx / 超时 才重试，且重试次数与等待时间都有上限（T03）；
 *   3. **401 不重试**——凭据问题重试一万次也没用，只应提示用户去检查配置。
 */

import { unwrapMcpEnvelope, ToonParseError } from './toon.ts';
import { VERSION } from './version.ts';
import {
  QueryMealsDataSchema,
  toMenuItems,
  toMealDetail,
  toPriceResult,
  type MenuItem,
  type MealDetail,
  type PriceResult,
} from './schema.ts';
import type { Cents } from './money.ts';
import { assertRealOrderingEnabled, OrderGuardError } from './order-guard.ts';

export type McpErrorCode =
  | 'NO_TOKEN'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'SERVER_ERROR'
  | 'BAD_RESPONSE'
  | 'UNSUPPORTED_PROTOCOL_VERSION'
  | 'ORDERING_DISABLED'
  | 'UNKNOWN';

export class McpError extends Error {
  readonly code: McpErrorCode;
  /** 是否值得重试 */
  readonly retryable: boolean;
  readonly status?: number;
  /** 官方**业务错误码**（信封里的 `code`）；业务失败时才有 */
  readonly businessCode?: number;
  /** 给用户看的安全提示（**绝不含 Token**） */
  readonly hint: string;

  constructor(
    code: McpErrorCode,
    message: string,
    init: { retryable?: boolean; status?: number; businessCode?: number; hint?: string } = {},
  ) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.retryable = init.retryable ?? false;
    this.status = init.status;
    if (init.businessCode !== undefined) this.businessCode = init.businessCode;
    this.hint = init.hint ?? DEFAULT_HINTS[code];
  }
}

/**
 * 官方**限流的业务错误码**（实测，2026-10-12 真实压测）。
 *
 * ⚠️ 关键事实：真实端点上的限流**不走 HTTP 429**——305 次请求全部返回 `HTTP 200`，
 * 被限者是 `success=false, code=508`、`message="太火爆了，请稍后再试"`。
 * 因此仅靠 `res.status === 429` 判限流是**判不到的**（客户端既不会退避、也不会止损）。
 */
export const RATE_LIMIT_BUSINESS_CODES: ReadonlySet<number> = new Set([508]);

/** 业务失败信息里出现这些字样，也按限流对待（兜底：官方新增码时的软匹配） */
const RATE_LIMIT_MESSAGE_RE = /(太火爆|稍后再试|请稍候|频率|限流|too\s*many\s*requests|rate\s*limit)/i;

const DEFAULT_HINTS: Record<McpErrorCode, string> = {
  NO_TOKEN: '尚未配置 MCP Token，请先到 open.mcd.cn 申请并填入本地配置（勿外发）。',
  UNAUTHORIZED: '凭据无效或已过期。请检查本地配置中的 Token 是否正确（**无需、也不要把它发给我**）。',
  RATE_LIMITED:
    '调用过于频繁，官方已限流（实测形态：HTTP 200 + 业务 code=508「太火爆了，请稍后再试」）。已做退避重试，请稍候再试。',
  TIMEOUT: '请求超时。请检查网络与代理设置后重试。',
  NETWORK: '网络不可达。若在受限网络环境下，请检查代理是否可用。',
  SERVER_ERROR: '官方服务返回异常。可稍后重试；若持续失败，请检查官方状态。',
  BAD_RESPONSE: '官方返回结构异常（可能已变更）。已记录原始响应以便排查。',
  UNSUPPORTED_PROTOCOL_VERSION:
    '服务端不支持本客户端所用的协议版本。请按错误信息中列出的受支持版本调整（见 README「协议兼容」一节）。',
  ORDERING_DISABLED:
    '本版本未接入真实下单（create-order），下单能力已显式关闭；请勿据此以为可以下单。',
  UNKNOWN: '未知错误。',
};

/** 把文本里可能出现的 Token 抹掉——错误信息一律先过这一道 */
export function redactToken(text: string, token?: string): string {
  let out = text;
  if (token && token.length >= 8) {
    out = out.split(token).join('***REDACTED***');
    // 也抹掉 Bearer 后面的那一段
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1***REDACTED***');
  }
  return out;
}

export interface McpClientOptions {
  url: string;
  token: string;
  /** 单次请求超时（毫秒），默认 20000 */
  timeoutMs?: number;
  /** 最大重试次数（有界），默认 2 */
  maxRetries?: number;
  /** 退避基数（毫秒），默认 400；等待 = base * 2^n，并设上限 */
  backoffBaseMs?: number;
  /** 退避上限（毫秒），默认 4000 */
  backoffMaxMs?: number;
  /** 便于测试注入 */
  fetchImpl?: typeof fetch;
  /** 便于测试跳过真实等待 */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * 协议版本。默认 `2025-06-18`（legacy 握手时代）。
   * 传 `2026-07-28` 或更晚的版本即走 **modern** 形态（无握手，每请求带 `_meta` 与路由头）。
   */
  protocolVersion?: string;
  /** 客户端标识（写入 clientInfo） */
  clientName?: string;
  /** 客户端版本号 */
  clientVersion?: string;
}

/** 协议时代：legacy = 握手时代（2025-11-25 及更早）；modern = 2026-07-28 起（无握手） */
export type ProtocolEra = 'legacy' | 'modern';

/** 依据版本号判断协议时代（见 MCP 规范 lifecycle：modern 自 2026-07-28 起） */
export function protocolEraOf(version: string): ProtocolEra {
  return version >= '2026-07-28' ? 'modern' : 'legacy';
}

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: number;
  result?: { content?: { text?: string }[]; tools?: unknown[] };
  error?: { code?: number; message?: string };
}

/** 默认协议版本：实测 `mcp.mcd.cn` 接受 legacy 握手路径（2025-06-18） */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 兼容层：`callTool` 返回的**已经是业务 data**。
 *
 * 为什么需要它：v3 的 R8 分层验证把 `callTool` 的返回契约从「外层信封」改成「已拆包的 data」，
 * 但有**两个调用点漏同步**——门店搜索仍写 `data?.data`（门店数组被再拆一次 ⇒ 恒为空列表），
 * 营养表仍写 `as { data?: string }`（⇒ 报「缺 data 字段」）。**在线模式因此整条不可用**，
 * 而离线夹具永远跑不到这条路径（不经过 McpClient）——这正是「真实端点证据」才能暴露的缺陷。
 *
 * 判据刻意保守：**只有形如官方信封**（键全落在 success/code/message/datetime/traceId/data 内）
 * 才取内层 `data`，避免把「业务对象自带的 data 字段」误拆。
 */
export function unwrapToolData<T = unknown>(value: unknown): T {
  if (typeof value === 'string' || Array.isArray(value)) return value as T;
  if (value !== null && typeof value === 'object') {
    const env = value as Record<string, unknown>;
    const ENVELOPE_KEYS = new Set(['success', 'code', 'message', 'datetime', 'traceId', 'data']);
    if ('data' in env && Object.keys(env).every((k) => ENVELOPE_KEYS.has(k))) {
      return env['data'] as T;
    }
  }
  return value as T;
}

export class McpClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly protocolVersion: string;
  private readonly era: ProtocolEra;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private seq = 0;
  private initialized = false;
  /** legacy 时代由服务端下发的会话 id；modern 时代恒为 null */
  private sessionId: string | null = null;
  /** 握手时服务端声明的协议版本（若有） */
  private serverProtocolVersion: string | undefined;
  /** 版本协商结论（如实记录，便于回执与自检） */
  private protocolNegotiation: 'agreed' | 'server-different' | 'not-returned' = 'not-returned';

  constructor(options: McpClientOptions) {
    if (!options.url) throw new McpError('BAD_RESPONSE', 'MCP 服务地址为空');
    if (!options.token) throw new McpError('NO_TOKEN', 'MCP Token 为空');
    this.url = options.url;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.backoffBaseMs = options.backoffBaseMs ?? 400;
    this.backoffMaxMs = options.backoffMaxMs ?? 4_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleepImpl ?? defaultSleep;
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.era = protocolEraOf(this.protocolVersion);
    this.clientName = options.clientName ?? 'mcmeal-compass';
    // 版本唯一源：src/version.ts（由 package.json 生成，见 scripts/sync-version.mjs）
    this.clientVersion = options.clientVersion ?? VERSION;
  }

  /** 当前协议口径（供自检与文档引用）——**含版本协商结论**，不留模糊表述 */
  describeProtocol(): {
    protocolVersion: string;
    era: ProtocolEra;
    session: boolean;
    serverProtocolVersion?: string;
    protocolNegotiation: 'agreed' | 'server-different' | 'not-returned';
  } {
    return {
      protocolVersion: this.protocolVersion,
      era: this.era,
      session: this.sessionId !== null,
      ...(this.serverProtocolVersion === undefined ? {} : { serverProtocolVersion: this.serverProtocolVersion }),
      protocolNegotiation: this.protocolNegotiation,
    };
  }

  /** 把任意错误转成 McpError，并**保证信息里没有 Token** */
  private toMcpError(e: unknown): McpError {
    if (e instanceof McpError) return e;
    if (e instanceof DOMException && e.name === 'AbortError') {
      // 超时多为瞬时抖动，值得有界重试
      return new McpError('TIMEOUT', '请求超时', { retryable: true });
    }
    const raw = e instanceof Error ? e.message : String(e);
    return new McpError('NETWORK', redactToken(raw, this.token), { retryable: true });
  }

  /** 组装请求头：按协议时代决定是否带路由头/会话头 */
  private buildHeaders(method: string, mcpName?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // 两条路径都要能接：JSON 直返 与 SSE 流
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
    };
    if (this.era === 'modern') {
      // 2026-07-28 起：每请求自描述，网关可按头路由（Mcp-Method / Mcp-Name）
      headers['MCP-Protocol-Version'] = this.protocolVersion;
      headers['Mcp-Method'] = method;
      if (mcpName) headers['Mcp-Name'] = mcpName;
    }
    if (this.era === 'legacy' && this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }
    return headers;
  }

  /** 组装请求体：modern 时代把版本/身份/能力放进 `_meta` */
  private buildBody(method: string, params: unknown): Record<string, unknown> {
    const body: Record<string, unknown> = { jsonrpc: '2.0', id: ++this.seq, method };
    if (params !== undefined) body.params = params;
    if (this.era === 'modern') {
      const base = (params ?? {}) as Record<string, unknown>;
      body.params = {
        ...base,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': this.protocolVersion,
          'io.modelcontextprotocol/clientInfo': { name: this.clientName, version: this.clientVersion },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      };
    }
    return body;
  }

  /**
   * 解析响应体：同时支持 **JSON** 与 **SSE（text/event-stream）**。
   * SSE 形如：
   *   event: message
   *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
   */
  private parsePayload(text: string, contentType: string, sentId: number): JsonRpcEnvelope {
    if (contentType.includes('text/event-stream')) {
      const candidates: JsonRpcEnvelope[] = [];
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        try {
          candidates.push(JSON.parse(payload) as JsonRpcEnvelope);
        } catch {
          /* 非 JSON 的 SSE 事件（如注释/心跳）一律跳过 */
        }
      }
      if (candidates.length === 0) {
        throw new McpError(
          'BAD_RESPONSE',
          `SSE 响应里没有可解析的 JSON-RPC 消息：${redactToken(text.slice(0, 200), this.token)}`,
        );
      }
      const hit = candidates.find((c) => c.id === sentId) ?? candidates.find((c) => c.result !== undefined || c.error !== undefined) ?? candidates[0]!;
      return hit;
    }

    try {
      return JSON.parse(text) as JsonRpcEnvelope;
    } catch {
      throw new McpError('BAD_RESPONSE', `返回不是合法 JSON：${redactToken(text.slice(0, 200), this.token)}`);
    }
  }

  /** 单次 JSON-RPC 调用（不含重试） */
  private async rpcOnce(method: string, params?: unknown, mcpName?: string): Promise<unknown> {
    const sentId = this.seq + 1;
    const body = this.buildBody(method, params);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.buildHeaders(method, mcpName),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // legacy：服务端可能下发会话 id，后续请求必须回传，否则会被判「无此会话」
      const session = res.headers?.get?.('mcp-session-id');
      if (session) this.sessionId = session;

      if (res.status === 401 || res.status === 403) {
        throw new McpError('UNAUTHORIZED', `鉴权失败（HTTP ${res.status}）`, { status: res.status });
      }
      if (res.status === 429) {
        throw new McpError('RATE_LIMITED', '触发官方限流（HTTP 429）', {
          retryable: true,
          status: res.status,
        });
      }
      if (res.status >= 500) {
        throw new McpError('SERVER_ERROR', `官方服务异常（HTTP ${res.status}）`, {
          retryable: true,
          status: res.status,
        });
      }
      if (!res.ok) {
        // 4xx：可能是「协议版本不匹配」的现代错误体，先读正文再定级
        const errText = await res.text().catch(() => '');
        const envelope = (() => {
          try {
            return JSON.parse(errText) as JsonRpcEnvelope;
          } catch {
            return null;
          }
        })();
        if (envelope?.error?.code === -32022) {
          const supported = JSON.stringify((envelope.error as { data?: unknown }).data ?? {});
          throw new McpError(
            'UNSUPPORTED_PROTOCOL_VERSION',
            `服务端不支持协议版本 ${this.protocolVersion}（-32022）。服务端信息：${redactToken(supported, this.token)}`,
          );
        }
        throw new McpError('UNKNOWN', `请求失败（HTTP ${res.status}）`, { status: res.status });
      }

      const text = await res.text();
      const envelope = this.parsePayload(text, res.headers?.get?.('content-type') ?? '', sentId);

      // id 校验：拿到的响应必须对得上本次请求，否则视为结构异常（避免串包）
      if (envelope.id !== sentId) {
        throw new McpError(
          'BAD_RESPONSE',
          `响应 id（${String(envelope.id)}）与请求 id（${sentId}）不匹配，判为结构异常`,
        );
      }
      if (envelope.error) {
        if (envelope.error.code === -32022) {
          throw new McpError(
            'UNSUPPORTED_PROTOCOL_VERSION',
            `服务端不支持协议版本 ${this.protocolVersion}（-32022）`,
          );
        }
        throw new McpError(
          'SERVER_ERROR',
          `JSON-RPC 错误：${redactToken(envelope.error.message ?? String(envelope.error.code), this.token)}`,
        );
      }
      return envelope.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 发一条通知（无 id、不等结果）——legacy 握手后要发 notifications/initialized */
  private async notify(method: string, params?: unknown): Promise<void> {
    const headers = this.buildHeaders(method);
    headers['Content-Type'] = 'application/json';
    try {
      await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
      });
    } catch {
      /* 通知失败不应阻断主流程；服务端若不强制要求初始化通知，忽略即可 */
    }
  }

  /** 带**有界退避**的 JSON-RPC 调用 */
  private async rpc(method: string, params?: unknown, mcpName?: string): Promise<unknown> {
    let lastErr: McpError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.rpcOnce(method, params, mcpName);
      } catch (e) {
        const err = this.toMcpError(e);
        lastErr = err;
        if (!err.retryable || attempt === this.maxRetries) throw err;
        const wait = Math.min(this.backoffBaseMs * 2 ** attempt, this.backoffMaxMs);
        await this.sleep(wait);
      }
    }
    throw lastErr ?? new McpError('UNKNOWN', '未知失败');
  }

  /** 握手（legacy）/ 能力探测（modern）；同实例只做一次 */
  async initialize(): Promise<{
    serverName?: string;
    version?: string;
    era: ProtocolEra;
    protocolVersion: string;
    /** 服务端在 `initialize` 结果里回的协议版本（未回则缺省） */
    serverProtocolVersion?: string;
    /** 版本协商结论：一致 / 服务端给了不同版本 / 服务端未回版本 */
    protocolNegotiation: 'agreed' | 'server-different' | 'not-returned';
  }> {
    if (this.initialized) {
      return { era: this.era, protocolVersion: this.protocolVersion, protocolNegotiation: this.protocolNegotiation };
    }

    if (this.era === 'modern') {
      // modern 无握手：可直接用 server/discover 探能力；服务端不支持则忽略（不影响后续调用）
      let serverName: string | undefined;
      let version: string | undefined;
      try {
        const info = (await this.rpc('server/discover', {})) as
          | { serverInfo?: { name?: string; version?: string } }
          | undefined;
        serverName = info?.serverInfo?.name;
        version = info?.serverInfo?.version;
      } catch {
        /* discover 是可选优化；不支持就直接发业务请求 */
      }
      this.initialized = true;
      this.protocolNegotiation = 'not-returned';
      return { ...(serverName === undefined ? {} : { serverName }), ...(version === undefined ? {} : { version }), era: this.era, protocolVersion: this.protocolVersion, protocolNegotiation: this.protocolNegotiation };
    }

    const result = (await this.rpc('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    })) as
      | { serverInfo?: { name?: string; version?: string }; protocolVersion?: string }
      | undefined;

    // ── 版本协商（v3 整改）──
    // 此前 legacy 握手**从不检查**服务端回的 protocolVersion，回执却写着「版本协商」。
    // 现在三态如实记录：一致 / 服务端给了不同版本（记录下来，不静默改口径）/ 未回版本。
    // 「不支持」这一态由 rpcOnce 的 -32022 分支负责（UNSUPPORTED_PROTOCOL_VERSION）。
    const serverProtocolVersion =
      typeof result?.protocolVersion === 'string' && result.protocolVersion.trim() !== ''
        ? result.protocolVersion
        : undefined;
    this.protocolNegotiation =
      serverProtocolVersion === undefined
        ? 'not-returned'
        : serverProtocolVersion === this.protocolVersion
          ? 'agreed'
          : 'server-different';
    this.serverProtocolVersion = serverProtocolVersion;

    // legacy 契约：握手后须发 notifications/initialized（服务端可能强制要求）
    await this.notify('notifications/initialized');
    this.initialized = true;
    return {
      serverName: result?.serverInfo?.name,
      version: result?.serverInfo?.version,
      era: this.era,
      protocolVersion: this.protocolVersion,
      ...(serverProtocolVersion === undefined ? {} : { serverProtocolVersion }),
      protocolNegotiation: this.protocolNegotiation,
    };
  }

  /**
   * 调用工具并**过完四层校验**（HTTP → JSON-RPC → 工具 `isError` → 业务 `success`/`code`），
   * 返回 `{ text, data }`。
   *
   * ⚠️ v3.6.2：**业务层限流必须在这一层有界重试**。
   * 实测限流是 `HTTP 200 + 业务 code=508`——它在 `rpc()` 的 HTTP 层看来是"成功"，
   * 故 HTTP 层的重试循环**永远看不到它**。若只把它标成 `retryable` 而不在此处置，
   * 「已做退避重试」就只是句空话（一次也不会重试）。
   */
  private async callToolEnvelope(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; data: unknown }> {
    let lastErr: McpError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const text = await this.callToolText(name, args);
      try {
        return { text, data: unwrapMcpEnvelope(text).data };
      } catch (e) {
        if (e instanceof ToonParseError && e.code === 'BUSINESS_FAILURE') {
          lastErr = this.toBusinessFailure(name, e);
        } else {
          throw new McpError(
            'BAD_RESPONSE',
            `工具 ${name} 返回无法解析：${redactToken(e instanceof Error ? e.message : String(e), this.token)}`,
          );
        }
      }
      if (!lastErr.retryable || attempt === this.maxRetries) throw lastErr;
      await this.sleep(Math.min(this.backoffBaseMs * 2 ** attempt, this.backoffMaxMs));
    }
    throw lastErr ?? new McpError('UNKNOWN', '未知失败');
  }

  /** 调用工具并返回**原始工具文本**（供夹具采集：既要原文，也要过同一套错误校验） */
  async callToolRaw(name: string, args: Record<string, unknown> = {}): Promise<string> {
    // 业务层校验照样跑（含限流重试）：采集时若官方返回业务失败，应当**立刻暴露**，
    // 而不是把错误存成夹具。
    return (await this.callToolEnvelope(name, args)).text;
  }

  /**
   * 业务失败的**分级**（R8 分层验证的最后一层；v3.6.2 补）。
   *
   * 实测（2026-10-12 真实压测）：**限流不走 HTTP 429**——305 次响应全为 `HTTP 200`，
   * 被限者是 `success=false, code=508`、`message="太火爆了，请稍后再试"`。
   * 故这里把「业务码或文案命中限流特征」的失败**升格为 `RATE_LIMITED`（retryable）**。
   * 不这么做，它会被当成 `SERVER_ERROR`（不可重试）——**既不会退避重试，也不会触发计价止损**，
   * 而计价层 `isRateLimited()` 的「限流即停」策略会永远落空。
   */
  private toBusinessFailure(name: string, e: ToonParseError): McpError {
    const msg = redactToken(e.message, this.token);
    const bc = e.businessCode;
    const looksRateLimited =
      (bc !== undefined && RATE_LIMIT_BUSINESS_CODES.has(bc)) || RATE_LIMIT_MESSAGE_RE.test(msg);
    if (looksRateLimited) {
      return new McpError(
        'RATE_LIMITED',
        `工具 ${name} 触发官方限流（业务 code=${String(bc ?? '?')}；HTTP 200）——${msg}`,
        { retryable: true, ...(bc === undefined ? {} : { businessCode: bc }) },
      );
    }
    return new McpError('SERVER_ERROR', `工具 ${name} ${msg}`, {
      ...(bc === undefined ? {} : { businessCode: bc }),
    });
  }

  /** 取工具文本（含工具级 isError 校验），不做业务层拆包 */
  private async callToolText(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.rpc('tools/call', { name, arguments: args }, name)) as
      | { content?: { text?: string }[]; isError?: boolean }
      | undefined;

    // ① 工具级失败：JSON-RPC 成功 ≠ 业务成功
    if (result?.isError === true) {
      throw new McpError('SERVER_ERROR', `工具 ${name} 返回 isError=true（工具执行失败）`);
    }

    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new McpError('BAD_RESPONSE', `工具 ${name} 的返回里没有 content[0].text`);
    }
    return text;
  }

  /**
   * 调用工具，返回**已拆包的业务 data**。
   *
   * ⚠️ 分层验证（评审 R8）：HTTP 状态 → JSON-RPC 错误 → **工具 `isError`** → **业务 `success`/`code`**
   * → 价格字段与报价对象核对（后者在 pricing 层）。
   * 任一层失败都**不得**被当作成功数据——尤其不能让「显式失败」变成「官方已核实 0 元」。
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // 业务层校验（含限流的有界重试）统一收口在 callToolEnvelope
    return (await this.callToolEnvelope(name, args)).data;
  }

  /** 工具清单（用于自检连通性与能力） */
  async listTools(): Promise<string[]> {
    const result = (await this.rpc('tools/list', {})) as { tools?: { name?: string }[] } | undefined;
    return (result?.tools ?? []).map((t) => t.name ?? '').filter(Boolean);
  }

  // ───────────── 业务封装 ─────────────

  /** 门店搜索（需城市 + 关键词） */
  async searchStores(params: { city: string; keyword: string; beType?: 1 | 5; searchType?: 1 | 2 }): Promise<
    { storeCode: string; storeName: string; address?: string; beCode?: string }[]
  > {
    // ⚠️ `callTool` 已拆包：返回值**就是门店数组**。
    // 旧代码写 `data?.data`，属双重拆包 ⇒ 门店列表恒为空（真实端点实测「未找到门店」的根因）。
    const data = unwrapToolData(
      await this.callTool('query-nearby-stores', {
        beType: params.beType ?? 1,
        searchType: params.searchType ?? 2,
        city: params.city,
        keyword: params.keyword,
      }),
    );
    const list = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    // **fail-closed**：门店码缺失时**宁可报错**，绝不把 undefined 悄悄变成空串——
    // 空串会一路传下去变成「查了一个不存在的门店」，比直接失败更难排查。
    return list.map((s, i) => {
      const code = s['storeCode'];
      const name = s['storeName'];
      if (typeof code !== 'string' || code.trim() === '') {
        throw new McpError('BAD_RESPONSE', `门店列表第 ${i + 1} 项缺少 storeCode，已中止（不猜测门店）`);
      }
      if (typeof name !== 'string' || name.trim() === '') {
        throw new McpError('BAD_RESPONSE', `门店 ${code} 缺少 storeName，已中止（不猜测名称）`);
      }
      return {
        storeCode: code,
        storeName: name,
        ...(s['address'] === undefined ? {} : { address: String(s['address']) }),
        ...(s['beCode'] === undefined ? {} : { beCode: String(s['beCode']) }),
      };
    });
  }

  /** 取门店菜单（转成统一 MenuItem[]） */
  async getMenu(params: {
    storeCode: string;
    orderType: 1 | 2;
    beType: 1 | 2 | 5 | 6;
    beCode?: string;
  }): Promise<{ items: MenuItem[]; missing: string[] }> {
    const args: Record<string, unknown> = {
      storeCode: params.storeCode,
      orderType: params.orderType,
      beType: params.beType,
    };
    // 到店自取（beType=1）**不得传 beCode**（实测：传了会报错）
    if (params.beCode && params.beType !== 1) args['beCode'] = params.beCode;

    const data = await this.callTool('query-meals', args);
    return toMenuItems(QueryMealsDataSchema.parse(data));
  }

  /** 取套餐详情 */
  async getMealDetail(params: {
    storeCode: string;
    orderType: 1 | 2;
    beType: 1 | 2 | 5 | 6;
    code: string;
    beCode?: string;
  }): Promise<MealDetail> {
    const args: Record<string, unknown> = {
      storeCode: params.storeCode,
      orderType: params.orderType,
      beType: params.beType,
      code: params.code,
    };
    if (params.beCode && params.beType !== 1) args['beCode'] = params.beCode;
    return toMealDetail(await this.callTool('query-meal-detail', args));
  }

  /**
   * 官方计价。
   * ⚠️ 字段名必须是 **`productCode`**（不是 `code`）——传错会**静默返回空单 + 全 0**（实测踩过）。
   */
  async calculatePrice(params: {
    storeCode: string;
    orderType: 1 | 2;
    beType: 1 | 2 | 5 | 6;
    /**
     * 顶层商品行。套餐行可带 `roundList`（官方「套餐子项」）表达**实际组成**——
     * `round` 传**轮次 id 的字符串**（传轮次名会被服务端拒为 500，实测）。
     */
    items: {
      productCode: string;
      quantity: number;
      roundList?: readonly { round: string; comboItemList: { code: string; quantity: number }[] }[];
    }[];
    beCode?: string;
  }): Promise<PriceResult> {
    const args: Record<string, unknown> = {
      storeCode: params.storeCode,
      orderType: params.orderType,
      beType: params.beType,
      // ⚠️ 逐字段重建时**必须带上 roundList**：v3.7.0 这里把组成丢了，
      // 于是「替换后价格重算」只是空话（复评 P1）。
      items: params.items.map((i) => ({
        productCode: i.productCode,
        quantity: i.quantity,
        ...(i.roundList && i.roundList.length > 0 ? { roundList: i.roundList } : {}),
      })),
    };
    if (params.beCode && params.beType !== 1) args['beCode'] = params.beCode;
    return toPriceResult(await this.callTool('calculate-price', args));
  }

  /**
   * 真实下单 —— **本版本未实现，且被显式关闭**。
   *
   * 保留这个方法是为了让「不能下单」这件事**在代码里可验证**，
   * 而不是只写在 README 里（外部评审 P0-4：不能让使用者以为下单链路已经可用）。
   * 要开启，须先补齐：请求幂等键、订单状态机（DRAFT→PRICED→USER_REVIEW→USER_CONFIRMED→SUBMITTING→SUCCEEDED/FAILED）、
   * 报价二次校验、重复提交防护，然后移除这里的守卫。
   *
   * @throws {OrderGuardError} 恒抛 ORDERING_DISABLED
   */
  async createOrder(_args: Record<string, unknown>): Promise<never> {
    assertRealOrderingEnabled();
    throw new OrderGuardError('ORDERING_DISABLED', 'unreachable');
  }
}

/**
 * 从环境/本地配置构造客户端。
 * 只读环境变量，**不读取也不打印任何 Token 明文**。
 */
export function createClientFromEnv(env: NodeJS.ProcessEnv = process.env): McpClient {
  const token = env['MCD_MCP_TOKEN'] ?? '';
  const url = env['MCD_MCP_URL'] ?? 'https://mcp.mcd.cn';
  return new McpClient({ url, token });
}

/** 金额格式化辅助（供上层复用，避免各处重复写 ÷100） */
export type { Cents };
