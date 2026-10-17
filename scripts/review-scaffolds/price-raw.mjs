/**
 * 真实端点原始响应取证（复审「需要补做的验收证据」用）。
 *
 * 目的：
 *   ① 协议证据 —— `calculate-price` 的**真实响应**里是否有 `productList`，
 *      以及它与请求 items 的对应关系？据此判定 `verifyQuoteBasket` 的
 *      「无 productList 即标未核实」这一保守口径是否需放宽。
 *   ② 现代接口成功证据 —— 记录 endpoint / 协议版本 / 协商结论 / 耗时 / 响应哈希。
 *   ③ 失败证据 —— 故意传不存在的商品码，记录端点的失败形态（是否为业务 failure）。
 *
 * 用法（需 MCD_MCP_TOKEN）：
 *   MCD_MCP_TOKEN=... node work/probes-online/price-raw.mjs
 */
import { createHash } from 'node:crypto';
import { McpClient } from '../../src/mcp-client.ts';
import { unwrapMcpEnvelope } from '../../src/toon.ts';

const token = process.env['MCD_MCP_TOKEN'] ?? '';
if (!token) {
  console.error('缺环境变量 MCD_MCP_TOKEN');
  process.exit(2);
}

const ENDPOINT = 'https://mcp.mcd.cn';
const STORE = process.env['PROBE_STORE'] ?? '3450024';

const client = new McpClient({
  url: ENDPOINT,
  token,
  clientName: 'mcmeal-compass-probe',
  clientVersion: '0.1.0',
  timeoutMs: 20000,
});

const info = await client.initialize();
const out = {
  runId: `online-price-probe-${new Date().toISOString()}`,
  at: new Date().toISOString(),
  endpoint: ENDPOINT,
  storeCode: STORE,
  protocol: {
    requested: '2025-06-18',
    era: info.era,
    serverVersion: info.version ?? null,
    negotiation: info.protocolNegotiation ?? 'n/a',
  },
  cases: [],
};

/**
 * 一次真实计价：留原始响应哈希、业务信封要点、是否含 productList 及逐项对应。
 */
const probe = async (label, items) => {
  const started = Date.now();
  const t0 = new Date().toISOString();
  let raw;
  try {
    raw = await client.callToolRaw('calculate-price', {
      storeCode: STORE,
      orderType: 1,
      beType: 1,
      items,
    });
  } catch (e) {
    out.cases.push({
      label,
      request: items,
      at: t0,
      durationMs: Date.now() - started,
      ok: false,
      error: { name: e?.constructor?.name ?? 'Error', message: String(e?.message ?? e), code: e?.code },
    });
    return;
  }

  const responseHash = createHash('sha256').update(raw).digest('hex').toUpperCase();
  let envelope = null;
  let parseError = null;
  try {
    envelope = unwrapMcpEnvelope(raw);
  } catch (e) {
    parseError = String(e?.message ?? e);
  }

  const data = envelope?.data;
  const productList = data && typeof data === 'object' ? data['productList'] : undefined;
  const dataKeys = data && typeof data === 'object' ? Object.keys(data) : [];
  // 响应里的商品与请求是否对得上（verifyQuoteBasket 的判据）
  let basketMatch = null;
  if (Array.isArray(productList)) {
    const got = productList
      .map((p) => `${p?.['productCode'] ?? p?.['code'] ?? '?'}x${p?.['quantity'] ?? '?'}`)
      .sort()
      .join(',');
    const want = items
      .map((i) => `${i.productCode}x${i.quantity}`)
      .sort()
      .join(',');
    basketMatch = got === want;
  }

  out.cases.push({
    label,
    request: items,
    at: t0,
    durationMs: Date.now() - started,
    ok: true,
    responseHash,
    responseBytes: raw.length,
    envelope: envelope
      ? { success: envelope['success'], code: envelope['code'], datetime: envelope['datetime'], traceId: envelope['traceId'] }
      : null,
    dataKeys,
    hasProductList: Array.isArray(productList),
    productList: Array.isArray(productList) ? productList : null,
    productListCount: Array.isArray(productList) ? productList.length : 0,
    basketMatch,
    price: data && typeof data === 'object' ? { price: data['price'], originalPrice: data['originalPrice'], discount: data['discount'] } : null,
    ...(parseError === null ? {} : { parseError }),
    rawExcerpt: raw.length > 1500 ? `${raw.slice(0, 1500)}…(${raw.length} 字节)` : raw,
  });
};

await probe('单品×1（麦辣鸡腿汉堡 1440）', [{ productCode: '1440', quantity: 1 }]);
await probe('套餐×1（精选单人餐三件套 9900004064）', [{ productCode: '9900004064', quantity: 1 }]);
await probe('混合数量（1440×2 + 巨无霸 1100×1）', [
  { productCode: '1440', quantity: 2 },
  { productCode: '1100', quantity: 1 },
]);
await probe('失败用例（不存在的商品码）', [{ productCode: '__NOT_A_PRODUCT__', quantity: 1 }]);

console.log(JSON.stringify(out, null, 2));
