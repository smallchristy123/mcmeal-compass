/**
 * v3.6.2 · 真实限流形态的回归（来源：2026-10-12 真实端点压测）
 *
 * 实测事实：`mcp.mcd.cn` 的限流**不走 HTTP 429**——
 *   305 次响应全为 `HTTP 200`，被限者是 `success=false, code=508`、
 *   `message="太火爆了，请稍后再试"`（首次出现于并发 12 组、第 38 个请求）。
 *
 * 修前后果：业务失败一律映射为 `SERVER_ERROR`（**不可重试**）⇒
 *   · 客户端不会退避重试；· 计价层 `isRateLimited()` 的「限流即停」**永不触发**。
 *
 * 本文件把这些行为钉死，防回退。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, McpError, RATE_LIMIT_BUSINESS_CODES } from '../src/mcp-client.ts';
import { ToonParseError, unwrapMcpEnvelope } from '../src/toon.ts';

const TOKEN = 'TESTONLY_token_not_a_credential_0001';

/** 官方「业务失败」信封（实测形态） */
const businessFailText = (code: number, message: string): string =>
  `## Original Response\n\n${JSON.stringify({ success: false, code, message, datetime: '2026-10-12 23:51:00', traceId: 't', data: null })}`;

const okText = (data: unknown): string =>
  `## Original Response\n\n${JSON.stringify({ success: true, code: 200, data })}`;

interface Fake {
  client: McpClient;
  /** 被调用的 method 序列 */
  methods: string[];
  /** tools/call 被调用的次数（含重试） */
  toolCalls: number;
}

/** 造一个假端点：握手正常，`tools/call` 一律返回给定文本 */
function makeClient(toolText: string, maxRetries = 0, status = 200): Fake {
  const methods: string[] = [];
  let toolCalls = 0;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string };
    methods.push(body.method);
    if (body.method === 'initialize') {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1.0' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (status !== 200) return new Response('x', { status });
    toolCalls++;
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: toolText }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const client = new McpClient({ url: 'http://fake.local/mcp', token: TOKEN, fetchImpl, maxRetries, sleepImpl: async () => {} });
  return { client, methods, get toolCalls() { return toolCalls; } };
}

describe('v3.6.2 · 业务层暴露限流业务码', () => {
  test('unwrapMcpEnvelope 把业务码带出来（code=508）', () => {
    try {
      unwrapMcpEnvelope(businessFailText(508, '太火爆了，请稍后再试'));
      assert.fail('应当抛错');
    } catch (e) {
      assert.ok(e instanceof ToonParseError);
      assert.equal(e.code, 'BUSINESS_FAILURE');
      assert.equal(e.businessCode, 508);
    }
  });

  test('限流业务码常量含实测值 508', () => {
    assert.ok(RATE_LIMIT_BUSINESS_CODES.has(508));
  });

  test('业务码非数字时不臆造 businessCode', () => {
    try {
      unwrapMcpEnvelope(`## Original Response\n\n${JSON.stringify({ success: false, code: 'oops', message: 'x' })}`);
      assert.fail('应当抛错');
    } catch (e) {
      assert.ok(e instanceof ToonParseError);
      assert.equal(e.businessCode, undefined);
    }
  });
});

describe('v3.6.2 · callTool 把真实限流升格为 RATE_LIMITED（可重试）', () => {
  test('code=508 ⇒ RATE_LIMITED，retryable，携带 businessCode', async () => {
    const f = makeClient(businessFailText(508, '太火爆了，请稍后再试'), 0);
    await f.client.initialize();
    await assert.rejects(
      () => f.client.callTool('calculate-price', {}),
      (e: unknown) => {
        assert.ok(e instanceof McpError);
        assert.equal(e.code, 'RATE_LIMITED');
        assert.equal(e.retryable, true);
        assert.equal(e.businessCode, 508);
        assert.match(e.message, /HTTP 200/); // 实测：限流时 HTTP 仍是 200
        assert.ok(!e.message.includes('Bearer'), '错误信息不得含凭据');
        return true;
      },
    );
  });

  test('RATE_LIMITED 会触发**有界重试**（maxRetries=2 ⇒ tools/call 试 3 次）', async () => {
    const f = makeClient(businessFailText(508, '太火爆了，请稍后再试'), 2);
    await f.client.initialize();
    await assert.rejects(() => f.client.callTool('calculate-price', {}));
    assert.equal(f.toolCalls, 3, '限流可重试 ⇒ 1 次 + 2 次重试');
  });

  test('maxRetries=0 时只试一次（不掩盖失败）', async () => {
    const f = makeClient(businessFailText(508, '太火爆了，请稍后再试'), 0);
    await f.client.initialize();
    await assert.rejects(() => f.client.callTool('calculate-price', {}));
    assert.equal(f.toolCalls, 1);
  });

  test('非限流的业务失败 ⇒ 仍是 SERVER_ERROR（不可重试），只试一次', async () => {
    const f = makeClient(businessFailText(60006, '商品不存在'), 2);
    await f.client.initialize();
    await assert.rejects(
      () => f.client.callTool('calculate-price', {}),
      (e: unknown) => {
        assert.ok(e instanceof McpError);
        assert.equal(e.code, 'SERVER_ERROR');
        assert.equal(e.retryable, false);
        assert.equal(e.businessCode, 60006);
        return true;
      },
    );
    assert.equal(f.toolCalls, 1, '不可重试 ⇒ 不该重复打');
  });

  test('文案兜底：码不认得但文案含「太火爆」⇒ 仍按限流处理', async () => {
    const f = makeClient(businessFailText(9999, '太火爆了，请稍后再试'), 0);
    await f.client.initialize();
    await assert.rejects(
      () => f.client.callTool('calculate-price', {}),
      (e: unknown) => {
        assert.ok(e instanceof McpError);
        assert.equal(e.code, 'RATE_LIMITED');
        assert.equal(e.businessCode, 9999);
        return true;
      },
    );
  });

  test('HTTP 429 的既有判定不回退', async () => {
    const f = makeClient(okText({ ok: 1 }), 0, 429);
    await f.client.initialize();
    await assert.rejects(
      () => f.client.callTool('calculate-price', {}),
      (e: unknown) => {
        assert.ok(e instanceof McpError);
        assert.equal(e.code, 'RATE_LIMITED');
        assert.equal(e.retryable, true);
        return true;
      },
    );
  });

  test('callToolRaw（采集路径）同样按限流分类', async () => {
    const f = makeClient(businessFailText(508, '太火爆了，请稍后再试'), 0);
    await f.client.initialize();
    await assert.rejects(
      () => f.client.callToolRaw('calculate-price', {}),
      (e: unknown) => {
        assert.ok(e instanceof McpError);
        assert.equal(e.code, 'RATE_LIMITED');
        return true;
      },
    );
  });

  test('正常业务响应不受影响（成功路径不误伤）', async () => {
    const f = makeClient(okText({ price: 2350 }), 0);
    await f.client.initialize();
    const data = (await f.client.callTool('calculate-price', {})) as { price: number };
    assert.equal(data.price, 2350);
  });
});
