/**
 * 版本身份一致性（复评 v3.7.1 · P2）
 *
 * 复评原话：「`package.json` 已改为 3.7.1，这部分成立；但运行路径没有使用这个版本……
 * 建议建立唯一版本源，并由测试捕获 initialize 与 modern `_meta` 的真实请求体，
 * 断言 `clientInfo.version === '3.7.1'`。」
 *
 * 本文件就盯三件事：
 *   ① `src/version.ts` 与 `package.json` 不漂移（漂移由 `npm run verify:version` 与门禁拦下）；
 *   ② **legacy 握手**实际发出的 `initialize` 报文里，`clientInfo.version` 就是当前版本；
 *   ③ **modern 路径**实际发出的 `tools/call` 报文里，`params._meta[...clientInfo].version` 同值。
 * 另附一条回归守卫：源码与脚本里不得再出现硬写的 `clientVersion: '0.x'`。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from '../src/mcp-client.ts';
import { NAME, VERSION } from '../src/version.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

interface Sent {
  method?: string;
  id?: unknown;
  params?: Record<string, unknown>;
}

/** 假传输层：只记录**实际发出的请求体**，并按最小 JSON-RPC 形态回应 */
const makeFakeFetch = () => {
  const sent: Sent[] = [];
  const impl = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Sent;
    sent.push(body);
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: { serverInfo: { name: 'fake-server', version: '0.0.0' }, protocolVersion: '2025-06-18' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { impl, sent };
};

describe('版本身份 · 唯一版本源', () => {
  test('src/version.ts 与 package.json 完全一致（含包名）', () => {
    assert.equal(VERSION, pkg.version, 'src/version.ts 的 VERSION 必须等于 package.json 的 version');
    assert.equal(NAME, pkg.name, '包名同样由唯一源派生');
    assert.match(VERSION, /^\d+\.\d+\.\d+$/, '版本号应为语义化三段式');
  });
});

describe('版本身份 · 实际发出的请求报告的就是当前版本', () => {
  test('legacy：`initialize` 的 clientInfo.version === VERSION', async () => {
    const { impl, sent } = makeFakeFetch();
    const c = new McpClient({
      url: 'https://example.invalid',
      token: 'FAKE-TOKEN',
      fetchImpl: impl as never,
      sleepImpl: async () => {},
    });
    await c.initialize();

    const init = sent.find((b) => b.method === 'initialize');
    assert.ok(init, '应发出过 initialize');
    const info = (init!.params?.clientInfo ?? {}) as { name?: string; version?: string };
    assert.equal(info.version, VERSION, `客户端对外报的版本必须是 ${VERSION}`);
    assert.equal(info.name, NAME);
  });

  test('modern：`tools/call` 的 _meta clientInfo.version === VERSION', async () => {
    const { impl, sent } = makeFakeFetch();
    const c = new McpClient({
      url: 'https://example.invalid',
      token: 'FAKE-TOKEN',
      protocolVersion: '2026-07-28',
      fetchImpl: impl as never,
      sleepImpl: async () => {},
    });
    // 只关心**已发出的请求体**；响应体不是真实业务形态，解析失败无妨
    try {
      await c.callTool('list-nutrition-foods', {});
    } catch {
      /* 忽略：断言对象是请求，不是响应 */
    }

    const call = sent.find((b) => b.method === 'tools/call');
    assert.ok(call, 'modern 路径应发出 tools/call');
    const meta = (call!.params?.['_meta'] ?? {}) as Record<string, { version?: string; name?: string }>;
    const info = meta['io.modelcontextprotocol/clientInfo'];
    assert.ok(info, '_meta 里应含 clientInfo');
    assert.equal(info!.version, VERSION, `modern 路径对外报的版本也必须是 ${VERSION}`);
  });
});

describe('版本身份 · 防回归：不得再出现硬写的旧版本', () => {
  test('src/ 与 scripts/ 内没有 `clientVersion: \'0.` 这类硬写常量', () => {
    const files: string[] = [];
    for (const dir of ['src', 'scripts']) {
      for (const f of readdirSync(join(ROOT, dir))) {
        if (/\.(ts|mjs)$/.test(f) && f !== 'version.ts') files.push(join(ROOT, dir, f));
      }
    }
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (/clientVersion:\s*'[^']*'/.test(text) || /clientVersion:\s*"[^"]*"/.test(text)) {
        offenders.push(f.replace(ROOT + '\\', '').replace(ROOT + '/', ''));
      }
    }
    assert.deepEqual(offenders, [], `以下文件仍在硬写 clientVersion（应改用版本源）：${offenders.join('、')}`);
  });
});
