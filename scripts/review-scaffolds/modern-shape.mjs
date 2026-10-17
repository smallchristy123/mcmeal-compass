/**
 * modern-shape 真实接口验证（复评必办项）。
 *
 * MCP 的 `modern` 形态自协议版本 `2026-07-28` 起：**无 legacy 握手**，
 * 每请求带 `_meta` 与路由头。本项目默认走 legacy（`2025-06-18`，实测端点接受）。
 *
 * 本探针回答一个问题：**真实端点 `mcp.mcd.cn` 是否也接受 modern 形态？**
 *   · 接受 → 记录协商结论与首次业务调用结果；
 *   · 不接受 → 如实记录错误（错误码/消息），供文档写明「当前以 legacy 为准」。
 *
 * 用法（需 MCD_MCP_TOKEN）：
 *   MCD_MCP_TOKEN=... node work/probes-online/modern-shape.mjs
 */
import { McpClient } from '../../src/mcp-client.ts';

const token = process.env['MCD_MCP_TOKEN'] ?? '';
if (!token) {
  console.error('缺环境变量 MCD_MCP_TOKEN');
  process.exit(2);
}

const ENDPOINT = 'https://mcp.mcd.cn';
const out = { runId: `modern-shape-probe-${new Date().toISOString()}`, endpoint: ENDPOINT, attempts: [] };

/** 逐个协议版本试：握手 + 一次真实业务调用（门店搜索，只读） */
const tryVersion = async (protocolVersion) => {
  const rec = { protocolVersion, initialize: null, searchStores: null };
  const client = new McpClient({
    url: ENDPOINT,
    token,
    protocolVersion,
    clientName: 'mcmeal-compass-modern-probe',
    clientVersion: '0.1.0',
    timeoutMs: 20000,
    maxRetries: 0,
  });
  try {
    const info = await client.initialize();
    rec.initialize = { ok: true, era: info.era, serverVersion: info.version ?? null, negotiation: info.protocolNegotiation ?? null };
  } catch (e) {
    rec.initialize = { ok: false, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) };
    out.attempts.push(rec);
    return;
  }
  try {
    const stores = await client.searchStores({ city: '重庆市', keyword: '观音桥' });
    rec.searchStores = { ok: true, count: stores.length, first: stores[0] ? { storeCode: stores[0].storeCode, storeName: stores[0].storeName } : null };
  } catch (e) {
    rec.searchStores = { ok: false, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) };
  }
  out.attempts.push(rec);
};

await tryVersion('2025-06-18'); // 现役基准（legacy）
await tryVersion('2026-07-28'); // modern 起点

out.conclusion = (() => {
  const modern = out.attempts.find((a) => a.protocolVersion === '2026-07-28');
  if (modern?.initialize?.ok && modern?.searchStores?.ok) return 'modern 可用（端点接受 2026-07-28）';
  if (modern?.initialize?.ok) return 'modern 握手/探测通过，但业务调用未成功';
  return 'modern 不被端点接受（当前以 legacy 2025-06-18 为准）';
})();

console.log(JSON.stringify(out, null, 2));
