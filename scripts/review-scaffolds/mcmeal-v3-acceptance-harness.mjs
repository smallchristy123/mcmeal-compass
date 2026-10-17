// McMeal Compass · v3 验收脚手架（第三方独立复验用）
// 作者：甘雨（独立复核方，未参与整改）
// 生成：2026-10-12
//
// 用途：执行方提交 v3 修复后，由独立方一键复验「已承诺的功能是否真的兑现」。
// 原则：
//   1. 只编码「用户可观察的行为要求」——不绑定实现细节，实现重构后仍应成立；
//   2. 不得为「取得通过」而删改本文件中的行为要求（可迁移进项目测试，但要求不可丢）；
//   3. R10 涉及一个「二择一的产品契约」，见该条注释：改动契约时须同步改此检查，并在文档说明。
//
// 用法：node mcmeal-v3-acceptance-harness.mjs <extracted-project-directory>
// 特性：不读取凭据、不请求真实端点、不下单、不写入项目；仅注入本地 fetch 与离线夹具。
//
// 说明：R1–R9 忠实转述《mcmeal-v2-independent-checks.mjs》所定义的要求（评审方允许迁移到测试），
//       R10 为本次新增（原脚本未覆盖的 --priority 行为要求）。

import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(process.argv[2] ?? '.');
const mod = (p) => import(pathToFileURL(join(root, 'src', p)).href);

const { recommendForMenu } = await mod('recommend.ts');
const { confirmPrices, requoteFinal } = await mod('pricing.ts');
const { toPriceResult } = await mod('schema.ts');
const { runOfflineForTest } = await mod('cli.ts');
const { McpClient } = await mod('mcp-client.ts');

const rows = [];
const nt = (value) => ({ value, complete: true, knownCount: 1, totalCount: 1 });
const item = (code, price, protein = 20) => ({
  code, name: code, price, category: 'test', kind: 'single', confidence: 'B',
  totals: { energyKcal: nt(400), protein: nt(protein), fat: nt(15), carbohydrate: nt(40), sodium: nt(600) },
  evidence: [], unmatchedComponents: [], notes: [],
});
const req = (preferences) => ({ budgetCny: 35, orderMode: 'pickup', storeCode: 'TEST', preferences: { priority: 'balance', ...preferences } });
const quote = (it, price, extras = {}) => ({
  quote: toPriceResult({ price, productList: [{ productCode: it.code, productName: it.name, quantity: 1, subtotal: price }], ...extras }),
  receipt: { tool: 'calculate-price', argsSummary: `items=[${it.code}×1]`, at: new Date().toISOString(), ok: true, attempt: 1, durationMs: 0 },
});

async function check(id, title, fn) {
  let observation;
  try { await fn((x) => { observation = x; }); rows.push({ id, title, status: 'PASS', observation }); }
  catch (e) { rows.push({ id, title, status: 'FAIL', observation, error: e.message }); }
}

// ── R1 折扣回补必须仍守住最低蛋白（其余硬条件同理） ──
await check('R1', 'discount fallback must retain minimum protein', async (record) => {
  const result = await recommendForMenu([item('low-protein', 4000, 1)], req({ minimumProteinGrams: 25 }), async (it) => quote(it, 2000));
  record(result.recommendation.plans.map((p) => ({ name: p.priced.item.name, protein: p.priced.item.totals.protein.value, price: p.priced.effectivePrice })));
  assert.equal(result.recommendation.plans.length, 0, '1g protein must not satisfy a 25g minimum');
});

// ── R2 避糖筛选必须检查已匹配的套餐组件 ──
await check('R2', 'avoid-sugary must inspect matched combo components', async (record) => {
  const result = JSON.parse(await runOfflineForTest({ budget: 35, avoidSugary: true, json: true }));
  const bad = result.recommendation.plans.filter((p) => p.priced.item.evidence.some((e) => e.label.includes('可乐中杯')));
  record(bad.map((p) => ({ code: p.priced.item.code, name: p.priced.item.name, evidence: p.priced.item.evidence })));
  assert.equal(bad.length, 0, 'known regular-cola combo remains recommended');
});

// ── R3 推荐必须真的执行它所声称的最终复核 ──
await check('R3', 'recommendation must execute its claimed final requote', async (record) => {
  let calls = 0;
  const result = await recommendForMenu([item('A', 2000)], req(), async (it) => quote(it, ++calls === 1 ? 2000 : 4000));
  record({ calls, displayedPrices: result.recommendation.plans.map((p) => p.priced.effectivePrice) });
  assert.ok(calls >= 2, 'only initial quote runs; final price change is never observed');
});

// ── R4 最终复核必须保留全部组件与数量 ──
await check('R4', 'final requote must preserve all components and quantities', async (record) => {
  const candidate = (await confirmPrices([item('meal', 2000)], 3500, async (it) => quote(it, 2000))).within[0];
  let received;
  const result = await requoteFinal(candidate, async (it) => { received = it; return quote(it, 2000); }, [{ productCode: 'A', quantity: 2 }, { productCode: 'B', quantity: 3 }]);
  record({ requested: [{ productCode: 'A', quantity: 2 }, { productCode: 'B', quantity: 3 }], receivedCode: received?.code, receipt: result.receipt.argsSummary });
  assert.match(result.receipt.argsSummary, /A×2,B×3/, 'current interface drops second component and quantities');
});

// ── R5 价格评分必须跟随「实际采用的官方价」 ──
await check('R5', 'price score must follow effective quoted price', async (record) => {
  const result = await recommendForMenu([item('A', 1000), item('B', 2000)], req(), async (it) => quote(it, it.code === 'A' ? 3000 : 500));
  const budget = result.recommendation.plans.find((p) => p.key === 'budget');
  record(result.recommendation.plans.map((p) => ({ key: p.key, code: p.priced.item.code, menu: p.priced.item.price, effective: p.priced.effectivePrice, budgetScore: p.score.budgetScore })));
  assert.equal(budget.score.budgetScore, 1, 'cheapest official quote receives worst price score');
});

// ── R6 离线回执必须报告「0 次真实官方请求」 ──
await check('R6', 'offline summary must report zero actual official requests', async (record) => {
  const result = JSON.parse(await runOfflineForTest({ budget: 35, avoidSugary: true, json: true }));
  const note = result.recommendation.notes.find((s) => s.includes('本次共发起'));
  record({ note, selectedReceiptAttempts: result.recommendation.plans.map((p) => p.priced.receipt.attempt) });
  assert.match(note, /本次共发起 0 次/, 'offline callback count is mislabeled as official HTTP requests');
});

// ── R7 离线溯源不得虚构成功的真实调用 ──
await check('R7', 'offline provenance must not invent successful live calls', async (record) => {
  const result = JSON.parse(await runOfflineForTest({ budget: 35, json: true }));
  const traces = result.recommendation.plans.flatMap((p) => p.explanation.toolCallTrace).filter((t) => ['query-meals', 'query-meal-detail'].includes(t.tool));
  record(traces);
  assert.ok(!traces.some((t) => t.ok === true), 'fixture loading is presented as a successful query tool invocation');
});

// ── R8 MCP 工具错误不得被当作成功价格数据 ──
await check('R8', 'MCP isError must not be accepted as successful price data', async (record) => {
  const client = new McpClient({
    url: 'http://local.invalid', token: 'DUMMY_REVIEW_TOKEN', maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, code: 500, message: 'simulated failure', data: { price: 0, productList: [] } }) }] } }), { headers: { 'content-type': 'application/json' } });
    },
  });
  let rejected = false, returned;
  try { returned = await client.calculatePrice({ storeCode: 'TEST', orderType: 1, beType: 1, items: [{ productCode: 'A', quantity: 1 }] }); } catch { rejected = true; }
  record({ rejected, returned });
  assert.equal(rejected, true, 'explicit error response was parsed as successful zero-price quote');
});

// ── R9 空清单 0 元不得「核实」非空购物篮（合法 0 元仍须支持） ──
await check('R9', 'empty zero-price response must not verify a nonempty basket', async (record) => {
  const result = await confirmPrices([item('A', 2000)], 3500, async (it) => quote(it, 0, { productList: [] }));
  record(result.within.map((p) => ({ verified: p.verified, price: p.effectivePrice, products: p.quote.productList })));
  assert.ok(!result.within.some((p) => p.verified), 'zero is allowed, but requested basket identity must also be validated');
});

// ── R10 --priority 必须真正改变首选排序（或删/改名该输入并同步产品契约） ──
// 契约二择一（见《v3 最小复验清单》G 项）：
//   甲案：priority 改变首选排序/候选池/展示顺序 —— 本检查期望「不同 priority 首选不同」；
//   乙案：删除或改名该 CLI 输入，使其不再暗示「偏好已生效」—— 此时应把本检查替换为
//         「CLI/帮助中不再存在会误导的 priority 参数」的断言，并在产品契约中说明。
await check('R10', 'priority must change the primary selection (or the input must be removed)', async (record) => {
  const items = [item('cheap', 1000, 10), item('highP', 3000, 40), item('mid', 2000, 25)];
  const pricer = async (it) => quote(it, it.price);
  const rb = await recommendForMenu(items, req({ priority: 'budget' }), pricer);
  const rp = await recommendForMenu(items, req({ priority: 'protein' }), pricer);
  const pick = (d) => d.recommendation.plans[0]?.priced.item.code ?? null;
  record({ budgetFirst: pick(rb), proteinFirst: pick(rp), budgetOrder: rb.recommendation.plans.map((p) => p.priced.item.code), proteinOrder: rp.recommendation.plans.map((p) => p.priced.item.code) });
  assert.notEqual(pick(rb), pick(rp), 'priority did not change the primary plan; wire it into selection, or remove/rename the CLI option and the product promise');
});

const summary = {
  harness: 'mcmeal-v3-acceptance-harness',
  author: 'ganyu-independent-review',
  projectRoot: root,
  runtime: process.version,
  network: 'none; injected fetch only',
  checks: rows.length,
  pass: rows.filter((r) => r.status === 'PASS').length,
  fail: rows.filter((r) => r.status === 'FAIL').length,
  results: rows,
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.fail ? 1 : 0;
