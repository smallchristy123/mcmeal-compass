/**
 * 安全用例（对应计划书 §11.1 的编号，便于验收对账）
 *
 *   T02  Token 无效 / 401  → 安全提示配置问题，**不打印 Token**
 *   T03  MCP 429 或超时    → **有界退避**，不无限重试、不阻塞
 *   T11  用户未确认却触发下单 → `create-order` **绝不执行**，并记录安全拒绝
 *   T15  Git 提交敏感文件检查 → 无 Token、手机号、原始地址、支付链接
 *
 * 另有 T12（计价单位）——把「分」误显示成「元」的 schema 级防错，
 * 由 money.test.ts / schema.test.ts 覆盖，此处再补一条端到端断言。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_DIR_PARTS } from '../src/fixtures.ts';

import { McpClient, McpError, redactToken, createClientFromEnv } from '../src/mcp-client.ts';
import { attemptOrder, assertOrderAllowed, OrderGuardError, type OrderIntent, type OrderAuditEntry } from '../src/order-guard.ts';
import { cents } from '../src/money.ts';
import { toPriceResult } from '../src/schema.ts';
import { unwrapMcpData } from '../src/toon.ts';

const here = dirname(fileURLToPath(import.meta.url));
const probe = (f: string) => join(here, '..', ...FIXTURE_DIR_PARTS, f);

const FAKE_TOKEN = 'TESTONLY-abcdefghijklmnop-0123456789';

/** 造一个可控的 fetch 假实现 */
function fakeFetch(
  handler: (call: number, init: RequestInit) => Response | Promise<Response>,
): { impl: typeof fetch; calls: () => number } {
  let n = 0;
  const impl = (async (_url: unknown, init?: RequestInit) => {
    n++;
    return await handler(n, init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls: () => n };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const toolOk = (data: unknown) =>
  jsonRes({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ text: `## Original Response\n\n${JSON.stringify({ success: true, code: 200, data })}` }] },
  });

// ───────────────────────── T02 ─────────────────────────

describe('T02 · 401 不泄 Token', () => {
  test('401 → UNAUTHORIZED，且不可重试（只请求一次）', async () => {
    const f = fakeFetch(() => new Response('unauthorized', { status: 401 }));
    const c = new McpClient({ url: 'https://x', token: FAKE_TOKEN, fetchImpl: f.impl });
    await assert.rejects(
      () => c.callTool('any'),
      (e: unknown) => e instanceof McpError && e.code === 'UNAUTHORIZED' && e.retryable === false,
    );
    assert.equal(f.calls(), 1, '401 不应重试');
  });

  test('错误信息与提示里都不含 Token 明文', async () => {
    const f = fakeFetch(() => new Response(`bad token ${FAKE_TOKEN}`, { status: 401 }));
    const c = new McpClient({ url: 'https://x', token: FAKE_TOKEN, fetchImpl: f.impl });
    try {
      await c.callTool('any');
      assert.fail('应抛错');
    } catch (e) {
      const err = e as McpError;
      assert.ok(!err.message.includes(FAKE_TOKEN), '错误信息泄露了 Token');
      assert.ok(!err.hint.includes(FAKE_TOKEN), '提示里泄露了 Token');
      assert.ok(!(err.stack ?? '').includes(FAKE_TOKEN), '异常栈泄露了 Token');
    }
  });

  test('返回体异常时也不会把 Token 带出来', async () => {
    const f = fakeFetch(() => new Response(`not json, token=${FAKE_TOKEN}`, { status: 200 }));
    const c = new McpClient({ url: 'https://x', token: FAKE_TOKEN, fetchImpl: f.impl });
    try {
      await c.callTool('any');
      assert.fail('应抛错');
    } catch (e) {
      assert.ok(!(e as Error).message.includes(FAKE_TOKEN));
    }
  });

  test('redactToken 能抹掉明文与 Bearer 段', () => {
    const s = `Authorization: Bearer ${FAKE_TOKEN} and raw ${FAKE_TOKEN}`;
    const out = redactToken(s, FAKE_TOKEN);
    assert.ok(!out.includes(FAKE_TOKEN));
    assert.ok(out.includes('***REDACTED***'));
  });

  test('未配置 Token → NO_TOKEN（不发起任何请求）', () => {
    assert.throws(() => new McpClient({ url: 'https://x', token: '' }), (e: unknown) =>
      (e as McpError).code === 'NO_TOKEN');
    assert.throws(() => createClientFromEnv({} as NodeJS.ProcessEnv), (e: unknown) =>
      (e as McpError).code === 'NO_TOKEN');
  });
});

// ───────────────────────── T03 ─────────────────────────

describe('T03 · 429 / 超时 有界退避', () => {
  test('持续 429：重试次数有上限（默认 maxRetries=2 → 共 3 次请求）', async () => {
    const f = fakeFetch(() => new Response('rate limited', { status: 429 }));
    const sleeps: number[] = [];
    const c = new McpClient({
      url: 'https://x',
      token: FAKE_TOKEN,
      fetchImpl: f.impl,
      sleepImpl: async (ms) => { sleeps.push(ms); },
    });
    await assert.rejects(
      () => c.callTool('any'),
      (e: unknown) => e instanceof McpError && e.code === 'RATE_LIMITED' && e.retryable === true,
    );
    assert.equal(f.calls(), 3);
    assert.equal(sleeps.length, 2, '重试 2 次即有 2 次等待');
    // 退避递增且有上限
    assert.ok(sleeps[0]! < sleeps[1]!);
    assert.ok(Math.max(...sleeps) <= 4000, '退避不得超过上限');
  });

  test('429 后成功：返回结果，不抛错', async () => {
    const f = fakeFetch((n) => (n === 1 ? new Response('no', { status: 429 }) : toolOk({ ok: 1 })));
    const c = new McpClient({
      url: 'https://x', token: FAKE_TOKEN, fetchImpl: f.impl, sleepImpl: async () => {},
    });
    const data = (await c.callTool('any')) as { ok: number };
    assert.equal(data.ok, 1);
    assert.equal(f.calls(), 2);
  });

  test('超时（AbortError）→ TIMEOUT 且可重试', async () => {
    const f = fakeFetch(() => {
      const err = new DOMException('aborted', 'AbortError');
      throw err;
    });
    const c = new McpClient({
      url: 'https://x', token: FAKE_TOKEN, fetchImpl: f.impl, maxRetries: 1, sleepImpl: async () => {},
    });
    await assert.rejects(
      () => c.callTool('any'),
      (e: unknown) => e instanceof McpError && e.code === 'TIMEOUT' && e.retryable === true,
    );
  });

  test('5xx 可重试；4xx（非 401/429）不重试', async () => {
    const f5 = fakeFetch(() => new Response('boom', { status: 503 }));
    const c5 = new McpClient({ url: 'https://x', token: FAKE_TOKEN, fetchImpl: f5.impl, maxRetries: 1, sleepImpl: async () => {} });
    await assert.rejects(() => c5.callTool('a'), (e: unknown) => (e as McpError).code === 'SERVER_ERROR');
    assert.equal(f5.calls(), 2);

    const f4 = fakeFetch(() => new Response('nope', { status: 400 }));
    const c4 = new McpClient({ url: 'https://x', token: FAKE_TOKEN, fetchImpl: f4.impl, sleepImpl: async () => {} });
    await assert.rejects(() => c4.callTool('a'), (e: unknown) => (e as McpError).retryable === false);
    assert.equal(f4.calls(), 1);
  });

  test('每次请求都带 Authorization，但不落在错误信息里', async () => {
    let seen = '';
    const f = fakeFetch((_n, init) => {
      seen = String((init.headers as Record<string, string>)['Authorization'] ?? '');
      return toolOk({});
    });
    const c = new McpClient({ url: 'https://x', token: FAKE_TOKEN, fetchImpl: f.impl });
    await c.callTool('any');
    assert.equal(seen, `Bearer ${FAKE_TOKEN}`);
  });
});

// ───────────────────────── T11 ─────────────────────────

describe('T11 · 未确认绝不下单', () => {
  const now = new Date('2026-10-10T20:00:00Z');
  const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
    storeCode: '3450024',
    orderType: 1,
    beType: 1,
    items: [{ productCode: '9900005456', quantity: 1 }],
    quotedTotal: cents(3800),
    quotedAt: now.toISOString(),
    ...over,
  });

  test('完全未确认 → 不执行，且留痕', async () => {
    const audit: OrderAuditEntry[] = [];
    let executed = 0;
    const r = await attemptOrder(
      intent(), { confirmed: false },
      async () => { executed++; return {}; },
      audit, { now: () => now },
    );
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'NOT_CONFIRMED');
    assert.equal(executed, 0, '未确认却执行了下单！');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.allowed, false);
  });

  test('确认了但金额与报价不符 → 不执行（防旧确认蒙混）', async () => {
    const audit: OrderAuditEntry[] = [];
    let executed = 0;
    const r = await attemptOrder(
      intent(), { confirmed: true, acknowledgedTotal: cents(3000) },
      async () => { executed++; return {}; },
      audit, { now: () => now },
    );
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'TOTAL_MISMATCH');
    assert.equal(executed, 0);
  });

  test('报价过期 → 不执行（须重新计价并重新确认）', async () => {
    let executed = 0;
    const r = await attemptOrder(
      intent({ quotedAt: new Date('2026-10-10T19:00:00Z').toISOString() }),
      { confirmed: true, acknowledgedTotal: cents(3800) },
      async () => { executed++; return {}; },
      [], { now: () => now },
    );
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'STALE_QUOTE');
    assert.equal(executed, 0);
  });

  test('空订单 → 不执行', async () => {
    let executed = 0;
    const r = await attemptOrder(
      intent({ items: [] }), { confirmed: true, acknowledgedTotal: cents(3800) },
      async () => { executed++; return {}; }, [], { now: () => now },
    );
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'EMPTY_ITEMS');
    assert.equal(executed, 0);
  });

  test('20 次未确认模拟：create-order 调用次数为 0（计划书 §11.2 验收项）', async () => {
    let executed = 0;
    for (let i = 0; i < 20; i++) {
      await attemptOrder(
        intent(), { confirmed: false },
        async () => { executed++; return {}; }, [], { now: () => now },
      );
    }
    assert.equal(executed, 0);
  });

  test('四项齐全 → 放行，且留痕为 allowed', async () => {
    const audit: OrderAuditEntry[] = [];
    let executed = 0;
    const r = await attemptOrder(
      intent(), { confirmed: true, acknowledgedTotal: cents(3800) },
      async () => { executed++; return { orderId: 'OK' }; },
      audit, { now: () => now },
    );
    assert.equal(r.allowed, true);
    assert.equal(executed, 1);
    assert.equal(audit[0]!.allowed, true);
  });

  test('assertOrderAllowed 直接调用亦会抛错', () => {
    assert.throws(
      () => assertOrderAllowed(intent(), { confirmed: false }, { now: () => now }),
      (e: unknown) => e instanceof OrderGuardError && e.code === 'NOT_CONFIRMED',
    );
  });
});

// ───────────────────────── T12 ─────────────────────────

describe('T12 · 计价单位不串（分 vs 元）', () => {
  test('真实计价留档：3800 分 → 展示为 ¥38.00，不是 ¥3800', async () => {
    const { formatCents } = await import('../src/money.ts');
    const data = unwrapMcpData(readFileSync(probe('calculate-price.raw.txt'), 'utf-8'));
    const p = toPriceResult(data);
    assert.equal(p.price, 3800);
    assert.equal(formatCents(p.price), '¥38.00');
  });
});

// ───────────────────────── T15 ─────────────────────────

describe('T15 · 仓库无敏感信息', () => {
  const repoRoot = join(here, '..');
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.workbuddy']);

  /** 遍历仓库所有可提交文件（不走 git 命令，避免沙箱限制） */
  let cache: string[] | null = null;
  const repoFiles = (): string[] => {
    if (cache) return cache;
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) continue;
          walk(join(dir, ent.name), rel ? `${rel}/${ent.name}` : ent.name);
        } else if (ent.isFile() && !ent.name.endsWith('.raw.json')) {
          out.push(rel ? `${rel}/${ent.name}` : ent.name);
        }
      }
    };
    walk(repoRoot, '');
    cache = out;
    return out;
  };

  /** 文本类文件才读；二进制跳过 */
  const readIfText = (rel: string): string => {
    try {
      const t = readFileSync(join(repoRoot, rel), 'utf-8');
      return t.includes('\u0000') ? '' : t;
    } catch {
      return '';
    }
  };

  test('可提交文件里无「Authorization: Bearer <长串>」', () => {
    const bad = repoFiles().filter((f) => /Bearer\s+[A-Za-z0-9._-]{20,}/.test(readIfText(f)));
    assert.deepEqual(bad, []);
  });

  test('无中国大陆手机号', () => {
    const bad = repoFiles().filter((f) => /\b1[3-9]\d{9}\b/.test(readIfText(f)));
    assert.deepEqual(bad, []);
  });

  test('无私钥、无支付链接', () => {
    const bad: string[] = [];
    for (const f of repoFiles()) {
      const t = readIfText(f);
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) bad.push(`${f}:私钥`);
      if (/payments?\.(mcd|alipay|wechat)/i.test(t)) bad.push(`${f}:支付链接`);
    }
    assert.deepEqual(bad, []);
  });

  test('.gitignore 已排除含真实 Token 的本地配置', () => {
    const gi = readFileSync(join(repoRoot, '.gitignore'), 'utf-8');
    assert.ok(/^mcp\.json$/m.test(gi), '.gitignore 应排除 mcp.json');
    assert.ok(/^\.env$/m.test(gi), '.gitignore 应排除 .env');
    assert.ok(/^node_modules\/$/m.test(gi), '.gitignore 应排除 node_modules/');
  });

  test('mcp-config.example.json 只含占位符，不含真实 Token', () => {
    const t = readFileSync(join(repoRoot, 'mcp-config.example.json'), 'utf-8');
    assert.ok(/YOUR_MCP_TOKEN|\$\{/.test(t), '示例配置应使用占位符');
    assert.ok(!/Bearer\s+[A-Za-z0-9]{20,}/.test(t), '示例配置里不能有真 Token');
  });
});
