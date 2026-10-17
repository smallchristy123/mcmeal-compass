// Additional V3 probes. Run with Node 24+:
// node mcmeal-v3-additional-probes-2026-10-12.mjs <extracted-mcmeal-compass-dir>
// Uses only injected pricers/loaders; no credentials, network, or writes to the project.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2] ?? '.');
const imp = p => import(pathToFileURL(join(root, 'src', p)).href);
const { recommendForMenu } = await imp('recommend.ts');
const { cents } = await imp('money.ts');
const { toPriceResult } = await imp('schema.ts');
const { analyzeMenu } = await imp('analyze.ts');
const { NutritionMatcher } = await imp('matching.ts');
const nt = value => ({ value, complete: true, knownCount: 1, totalCount: 1 });
const item = (code, price, protein) => ({
  code, name: code, price: cents(price * 100), category: '主餐', kind: 'single', confidence: 'B',
  totals: { energyKcal: nt(400), protein: nt(protein), fat: nt(10), carbohydrate: nt(30), sodium: nt(100) },
  evidence: [], unmatchedComponents: [], notes: [],
});
const ok = (it, price) => ({
  quote: toPriceResult({ price: price * 100, productList: [{ productCode: it.code, productName: it.name, quantity: 1, subtotal: price * 100 }], takeWayList: [] }),
  receipt: { tool: 'calculate-price', argsSummary: '', at: new Date().toISOString(), ok: true, attempt: 1, durationMs: 0 },
});
const results = [];

// Probe 1: the preferred budget plan is removed after final repricing.
{
  const a = item('A', 10, 20), b = item('B', 20, 40);
  let calls = 0;
  const pricer = async it => {
    calls++;
    return ok(it, calls === 1 ? 10 : (it.code === 'A' ? 40 : 20));
  };
  const r = await recommendForMenu([a, b], { budgetCny: 35, orderMode: 'pickup', storeCode: 'T', preferences: { priority: 'budget' } }, pricer);
  results.push({ id: 'R11', expected: 'plans[0].key === primaryKey after final-plan removal', observed: { calls, primaryKey: r.recommendation.primaryKey, planKeys: r.recommendation.plans.map(p => p.key), primaryNote: r.recommendation.primaryNote }, pass: r.recommendation.plans.length === 0 || r.recommendation.plans[0]?.key === r.recommendation.primaryKey });
}

// Probe 2: final failure must not retain the initial "official and verified" display.
{
  const a = item('A', 20, 20);
  let calls = 0;
  const pricer = async it => {
    calls++;
    if (calls === 1) return ok(it, 20);
    return { quote: null, receipt: { tool: 'calculate-price', argsSummary: '', at: new Date().toISOString(), ok: false, attempt: 1, errorCode: 'TIMEOUT', durationMs: 0 } };
  };
  const r = await recommendForMenu([a], { budgetCny: 35, orderMode: 'pickup', storeCode: 'T', preferences: { priority: 'budget' } }, pricer);
  const p = r.recommendation.plans[0];
  results.push({ id: 'R12', expected: 'final failure cannot be rendered as official verified price', observed: { calls, priceSource: p?.priced.priceSource, verified: p?.priced.verified, statement: p?.explanation.statements[1] }, pass: !p || (p.priced.priceSource !== 'official' && p.priced.verified === false && !p.explanation.statements[1]?.includes('已核')) });
}

// Probe 3: a failed combo-detail load must leave a failed detail receipt, not a synthetic success.
{
  const menuItem = { code: 'C', name: '测试套餐', currentPrice: 1000, category: '套餐' };
  const r = await analyzeMenu([menuItem], new NutritionMatcher([]), async () => { throw new Error('TIMEOUT'); }, { source: { channel: 'live', at: '2026-10-12T00:00:00Z' } });
  const trace = r.items[0]?.sourceTrace ?? [];
  results.push({ id: 'R13', expected: 'combo detail failure is represented in source trace', observed: trace, pass: trace.some(t => t.tool === 'query-meal-detail' && t.ok === false) });
}

const out = { projectRoot: root, runtime: process.version, network: 'none; injected pricer/loader only', checks: results.length, pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, results };
console.log(JSON.stringify(out, null, 2));
process.exitCode = out.fail ? 1 : 0;
