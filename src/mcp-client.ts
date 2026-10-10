/**
 * MCP 客户端与门店/菜单适配（T1.3）
 *
 * 实测口径（见 docs/API_PROBE_NOTES.md）：
 *   · 端点：`https://mcp.mcd.cn` —— **根路径**（`/mcp`、`/sse` 等一律 404）
 *   · 协议：2025-06-18；鉴权：`Authorization: Bearer <TOKEN>`
 *   · 返回：`content[0].text` 是「文档说明 + 原始 JSON」混合，JSON 体在 `## Original Response` 之后
 *
 * 三条安全底线：
 *   1. **绝不把 Token 写进任何错误信息、日志或异常栈**（计划书 T02）；
 *   2. **有界退避**——429 / 5xx / 超时 才重试，且重试次数与等待时间都有上限（T03）；
 *   3. **401 不重试**——凭据问题重试一万次也没用，只应提示用户去检查配置。
 */

import { unwrapMcpData } from './toon.ts';
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

export type McpErrorCode =
  | 'NO_TOKEN'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'SERVER_ERROR'
  | 'BAD_RESPONSE'
  | 'UNKNOWN';

export class McpError extends Error {
  readonly code: McpErrorCode;
  /** 是否值得重试 */
  readonly retryable: boolean;
  readonly status?: number;
  /** 给用户看的安全提示（**绝不含 Token**） */
  readonly hint: string;

  constructor(code: McpErrorCode, message: string, init: { retryable?: boolean; status?: number; hint?: string } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.retryable = init.retryable ?? false;
    this.status = init.status;
    this.hint = init.hint ?? DEFAULT_HINTS[code];
  }
}

const DEFAULT_HINTS: Record<McpErrorCode, string> = {
  NO_TOKEN: '尚未配置 MCP Token，请先到 open.mcd.cn 申请并填入本地配置（勿外发）。',
  UNAUTHORIZED: '凭据无效或已过期。请检查本地配置中的 Token 是否正确（**无需、也不要把它发给我**）。',
  RATE_LIMITED: '调用过于频繁（官方限流 600 次/分）。已做退避重试，请稍候再试。',
  TIMEOUT: '请求超时。请检查网络与代理设置后重试。',
  NETWORK: '网络不可达。若在受限网络环境下，请检查代理是否可用。',
  SERVER_ERROR: '官方服务返回异常。可稍后重试；若持续失败，请检查官方状态。',
  BAD_RESPONSE: '官方返回结构异常（可能已变更）。已记录原始响应以便排查。',
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
}

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: number;
  result?: { content?: { text?: string }[]; tools?: unknown[] };
  error?: { code?: number; message?: string };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class McpClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private seq = 0;
  private initialized = false;

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

  /** 单次 JSON-RPC 调用（不含重试） */
  private async rpcOnce(method: string, params?: unknown): Promise<unknown> {
    const body: Record<string, unknown> = { jsonrpc: '2.0', id: ++this.seq, method };
    if (params !== undefined) body.params = params;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

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
        throw new McpError('UNKNOWN', `请求失败（HTTP ${res.status}）`, { status: res.status });
      }

      const text = await res.text();
      let envelope: JsonRpcEnvelope;
      try {
        envelope = JSON.parse(text) as JsonRpcEnvelope;
      } catch {
        throw new McpError('BAD_RESPONSE', `返回不是合法 JSON：${redactToken(text.slice(0, 200), this.token)}`);
      }
      if (envelope.error) {
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

  /** 带**有界退避**的 JSON-RPC 调用 */
  private async rpc(method: string, params?: unknown): Promise<unknown> {
    let lastErr: McpError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.rpcOnce(method, params);
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

  /** 握手；同实例只做一次 */
  async initialize(): Promise<{ serverName?: string; version?: string }> {
    if (this.initialized) return {};
    const result = (await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcmeal-compass', version: '0.1.0' },
    })) as { serverInfo?: { name?: string; version?: string } } | undefined;
    this.initialized = true;
    return { serverName: result?.serverInfo?.name, version: result?.serverInfo?.version };
  }

  /** 调用工具，返回**已拆包的业务 data** */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = (await this.rpc('tools/call', { name, arguments: args })) as
      | { content?: { text?: string }[] }
      | undefined;
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new McpError('BAD_RESPONSE', `工具 ${name} 的返回里没有 content[0].text`);
    }
    try {
      return unwrapMcpData(text);
    } catch (e) {
      throw new McpError(
        'BAD_RESPONSE',
        `工具 ${name} 返回无法解析：${redactToken(e instanceof Error ? e.message : String(e), this.token)}`,
      );
    }
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
    const data = (await this.callTool('query-nearby-stores', {
      beType: params.beType ?? 1,
      searchType: params.searchType ?? 2,
      city: params.city,
      keyword: params.keyword,
    })) as { data?: unknown } | undefined;
    const list = Array.isArray(data?.data) ? (data!.data as Record<string, unknown>[]) : [];
    return list.map((s) => ({
      storeCode: String(s['storeCode'] ?? ''),
      storeName: String(s['storeName'] ?? ''),
      address: s['address'] === undefined ? undefined : String(s['address']),
      beCode: s['beCode'] === undefined ? undefined : String(s['beCode']),
    }));
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
    items: { productCode: string; quantity: number }[];
    beCode?: string;
  }): Promise<PriceResult> {
    const args: Record<string, unknown> = {
      storeCode: params.storeCode,
      orderType: params.orderType,
      beType: params.beType,
      items: params.items.map((i) => ({ productCode: i.productCode, quantity: i.quantity })),
    };
    if (params.beCode && params.beType !== 1) args['beCode'] = params.beCode;
    return toPriceResult(await this.callTool('calculate-price', args));
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
