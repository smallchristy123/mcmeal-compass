/**
 * MCP 协议兼容矩阵 · 集成测试（外部评审 P0-2 的处置）
 *
 * 与既有的「mock 单个函数」不同，这里**真起一个本地 HTTP 服务**，
 * 让客户端走完整的请求链（组头 → 发请求 → 解响应 → 校验 id），覆盖四组：
 *   ① JSON 直返（legacy 握手 + 会话回传 + notifications/initialized）
 *   ② SSE（text/event-stream）响应
 *   ③ 错误路径：401 不重试 / 429 有界重试 / 5xx 可重试
 *   ④ 版本不匹配：服务端回 -32022，客户端应给出 UNSUPPORTED_PROTOCOL_VERSION
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import { McpClient, McpError, protocolEraOf } from '../src/mcp-client.ts';

const TOKEN = 'TESTONLY-token-for-protocol-0123456789';

interface Recorded {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface Harness {
  server: Server;
  url: string;
  seen: Recorded[];
  /** 每收到一个请求调用一次，返回 { status, body?, sse? } */
  setHandler: (h: (seen: Recorded, index: number) => Response) => void;
}

interface Response {
  status?: number;
  /** JSON 响应体 */
  body?: unknown;
  /** 以 SSE 形式返回（会包成 data: 行） */
  sse?: boolean;
  /** 额外响应头 */
  headers?: Record<string, string>;
}

async function startHarness(): Promise<Harness> {
  const seen: Recorded[] = [];
  let handler: (seen: Recorded, index: number) => Response = () => ({ status: 200, body: {} });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => {
      raw += String(c);
    });
    req.on('end', () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* 通知等空体 */
      }
      const rec: Recorded = { method: req.method ?? '', headers: req.headers, body: parsed };
      seen.push(rec);

      const out = handler(rec, seen.length - 1);
      const status = out.status ?? 200;
      const headers: Record<string, string> = { ...(out.headers ?? {}) };

      if (out.sse) {
        headers['Content-Type'] = 'text/event-stream';
        res.writeHead(status, headers);
        // 真 SSE：先来一条心跳/注释，再来正式消息——客户端应能跳过非 JSON 事件
        res.write(': ping\n\n');
        res.write(`data: ${JSON.stringify(out.body)}\n\n`);
        res.end();
        return;
      }

      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      res.writeHead(status, headers);
      res.end(JSON.stringify(out.body ?? {}));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    server,
    url: `http://127.0.0.1:${port}/`,
    seen,
    setHandler: (h) => {
      handler = h;
    },
  };
}

/** 造一个成功的 JSON-RPC 响应（回显请求 id） */
const okResult = (rec: Recorded, result: unknown): Response => ({
  status: 200,
  body: { jsonrpc: '2.0', id: (rec.body['id'] as number) ?? 1, result },
});

const toolText = (data: unknown) =>
  `## Original Response\n\n${JSON.stringify({ success: true, code: 200, data })}`;

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(() => {
  h.server.close();
});

describe('协议兼容 · era 判定', () => {
  test('2026-07-28 及以后 = modern；2025-11-25 及更早 = legacy', () => {
    assert.equal(protocolEraOf('2025-06-18'), 'legacy');
    assert.equal(protocolEraOf('2025-11-25'), 'legacy');
    assert.equal(protocolEraOf('2026-07-28'), 'modern');
    assert.equal(protocolEraOf('2027-01-01'), 'modern');
  });
});

describe('协议兼容 · ① JSON 直返 + legacy 握手与会话回传', () => {
  test('握手 → notifications/initialized → tools/call；会话 id 被回传', async () => {
    h.seen.length = 0;
    h.setHandler((rec) => {
      if (rec.body['method'] === 'initialize') {
        return {
          ...okResult(rec, { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '9.9' } }),
          headers: { 'Mcp-Session-Id': 'sess-abc-123' },
        };
      }
      if (rec.body['method'] === 'notifications/initialized') {
        return { status: 202, body: {} };
      }
      return okResult(rec, { content: [{ text: toolText({ hit: 1 }) }] });
    });

    const c = new McpClient({ url: h.url, token: TOKEN, sleepImpl: async () => {} });
    const info = await c.initialize();
    assert.equal(info.era, 'legacy');
    assert.equal(info.serverName, 'fake');

    const data = (await c.callTool('query-meals', { storeCode: '3450024' })) as { hit: number };
    assert.equal(data.hit, 1);

    // 三次请求：initialize / notifications/initialized / tools/call
    const methods = h.seen.map((s) => String(s.body['method']));
    assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call']);

    // 会话 id 必须回传到后续请求
    const call = h.seen[2]!;
    assert.equal(call.headers['mcp-session-id'], 'sess-abc-123');
    // 初始化通知**不带 id**（JSON-RPC 通知语义）
    assert.equal('id' in h.seen[1]!.body, false);
    // 每次请求都带鉴权
    for (const s of h.seen) assert.equal(s.headers['authorization'], `Bearer ${TOKEN}`);
  });
});

describe('协议兼容 · ② SSE 响应', () => {
  test('text/event-stream 也能解析（并跳过非 JSON 心跳）', async () => {
    h.seen.length = 0;
    h.setHandler((rec) => okResult(rec, { content: [{ text: toolText({ via: 'sse' }) }] }));

    const c = new McpClient({ url: h.url, token: TOKEN, sleepImpl: async () => {} });
    // 让服务端以 SSE 形式返回
    h.setHandler((rec) => ({ ...okResult(rec, { content: [{ text: toolText({ via: 'sse' }) }] }), sse: true }));

    const data = (await c.callTool('query-meals', {})) as { via: string };
    assert.equal(data.via, 'sse');
  });

  test('SSE 里全是非 JSON 事件 → BAD_RESPONSE（不静默返回空）', async () => {
    h.setHandler(() => ({ status: 200, sse: true, body: undefined }));
    const c = new McpClient({ url: h.url, token: TOKEN, sleepImpl: async () => {} });
    await assert.rejects(
      () => c.callTool('query-meals', {}),
      (e: unknown) => (e as McpError).code === 'BAD_RESPONSE',
    );
  });
});

describe('协议兼容 · ③ 错误路径', () => {
  test('401 → UNAUTHORIZED，只发一次（不重试）', async () => {
    h.seen.length = 0;
    h.setHandler(() => ({ status: 401, body: {} }));
    const c = new McpClient({ url: h.url, token: TOKEN, sleepImpl: async () => {} });
    await assert.rejects(
      () => c.callTool('query-meals', {}),
      (e: unknown) => (e as McpError).code === 'UNAUTHORIZED',
    );
    assert.equal(h.seen.length, 1);
  });

  test('429 后成功 → 客户端自动退避重试并拿到结果', async () => {
    h.seen.length = 0;
    h.setHandler((rec, i) => (i === 0 ? { status: 429, body: {} } : okResult(rec, { content: [{ text: toolText({ ok: 1 }) }] })));
    const c = new McpClient({ url: h.url, token: TOKEN, sleepImpl: async () => {} });
    const data = (await c.callTool('query-meals', {})) as { ok: number };
    assert.equal(data.ok, 1);
    assert.equal(h.seen.length, 2);
  });

  test('5xx 有界重试后放弃（默认 3 次请求）', async () => {
    h.seen.length = 0;
    h.setHandler(() => ({ status: 503, body: {} }));
    const c = new McpClient({ url: h.url, token: TOKEN, sleepImpl: async () => {} });
    await assert.rejects(
      () => c.callTool('query-meals', {}),
      (e: unknown) => (e as McpError).code === 'SERVER_ERROR',
    );
    assert.equal(h.seen.length, 3);
  });

  test('响应 id 不匹配 → BAD_RESPONSE（防串包）', async () => {
    h.setHandler(() => ({ status: 200, body: { jsonrpc: '2.0', id: 99999, result: {} } }));
    const c = new McpClient({ url: h.url, token: TOKEN, sleepImpl: async () => {} });
    await assert.rejects(
      () => c.callTool('query-meals', {}),
      (e: unknown) => (e as McpError).code === 'BAD_RESPONSE' && (e as Error).message.includes('不匹配'),
    );
  });
});

describe('协议兼容 · ④ 版本不匹配（-32022）', () => {
  test('服务端回 -32022 → UNSUPPORTED_PROTOCOL_VERSION，并带出受支持版本', async () => {
    h.seen.length = 0;
    h.setHandler((rec) => ({
      status: 400,
      body: {
        jsonrpc: '2.0',
        id: (rec.body['id'] as number) ?? 1,
        error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'] } },
      },
    }));
    const c = new McpClient({ url: h.url, token: TOKEN, sleepImpl: async () => {} });
    await assert.rejects(
      () => c.initialize(),
      (e: unknown) =>
        (e as McpError).code === 'UNSUPPORTED_PROTOCOL_VERSION' &&
        (e as Error).message.includes('2026-07-28'),
    );
  });
});

describe('协议兼容 · modern 形态（2026-07-28）', () => {
  test('modern 不发握手，改为每请求带 _meta 与路由头', async () => {
    h.seen.length = 0;
    h.setHandler((rec) => {
      if (rec.body['method'] === 'server/discover') {
        return okResult(rec, { serverInfo: { name: 'fake-modern', version: '1.0' } });
      }
      return okResult(rec, { content: [{ text: toolText({ modern: true }) }] });
    });

    const c = new McpClient({
      url: h.url,
      token: TOKEN,
      protocolVersion: '2026-07-28',
      sleepImpl: async () => {},
    });
    const info = await c.initialize();
    assert.equal(info.era, 'modern');

    const data = (await c.callTool('query-meals', {})) as { modern: boolean };
    assert.equal(data.modern, true);

    // 不应发出 legacy 的 initialize / notifications/initialized
    const methods = h.seen.map((s) => String(s.body['method']));
    assert.ok(!methods.includes('initialize'), `modern 不应发 initialize：${methods.join(',')}`);

    // tools/call 请求必须带协议头与 _meta
    const call = h.seen.find((s) => s.body['method'] === 'tools/call')!;
    assert.equal(call.headers['mcp-protocol-version'], '2026-07-28');
    assert.equal(call.headers['mcp-method'], 'tools/call');
    assert.equal(call.headers['mcp-name'], 'query-meals');
    const params = call.body['params'] as Record<string, unknown>;
    const meta = params['_meta'] as Record<string, unknown>;
    assert.equal(meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    assert.ok(meta['io.modelcontextprotocol/clientInfo']);
  });

  test('modern 时代不假设存在会话头', async () => {
    h.setHandler((rec) => okResult(rec, { content: [{ text: toolText({}) }] }));
    const c = new McpClient({ url: h.url, token: TOKEN, protocolVersion: '2026-07-28', sleepImpl: async () => {} });
    await c.callTool('query-meals', {});
    const call = h.seen[h.seen.length - 1]!;
    assert.equal(call.headers['mcp-session-id'], undefined);
    assert.equal(c.describeProtocol().era, 'modern');
  });
});
