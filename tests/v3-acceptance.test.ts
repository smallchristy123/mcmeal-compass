/**
 * v3 验收要求（**迁入项目测试**，2026-10-12）
 *
 * 来源：外部评审 v2 独立反例脚本 + 第三方复核脚手架
 * `mcmeal-v3-acceptance-harness.mjs` 的 R1–R10 行为要求。
 *
 * 迁移原则（评审原文允许）：
 *   · 要求**只可迁移、不可删改**——实现重构后这些断言仍应成立；
 *   · 断言的是**用户可观察的行为**（结果、数量、口径），不绑定内部函数名。
 *
 * 另含 v3 新增的工程项断言：版本协商三态、新鲜度时区/未来边界、采集写入保护。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalyzedItem } from '../src/analyze.ts';
import type { NutritionTotals } from '../src/decompose.ts';
import { cents, type Cents } from '../src/money.ts';
import { assessSugary, classifySugary, type MealRequest } from '../src/constraints.ts';
import { confirmPrices, requoteFinal, type Pricer, type PriceAttempt } from '../src/pricing.ts';
import { recommendForMenu } from '../src/recommend.ts';
import { runOfflineForTest } from '../src/cli.ts';
import { McpClient } from '../src/mcp-client.ts';
import { toPriceResult } from '../src/schema.ts';
import { freshnessOf, parseCapturedAt } from '../src/freshness.ts';
import { forbiddenWrite } from '../src/capture-guard.ts';
import { REPO_ROOT } from '../src/fixtures.ts';

// ─────────────── 造数据 ───────────────

const nt = (value: number | null) => ({ value, complete: true, knownCount: 1, totalCount: 1 });

const totals = (kcal: number, protein: number): NutritionTotals => ({
  energyKcal: nt(kcal),
  protein: nt(protein),
  fat: nt(15),
  carbohydrate: nt(40),
  sodium: nt(600),
});

const item = (code: string, priceYuan: number, protein: number, extra: Partial<AnalyzedItem> = {}): AnalyzedItem => ({
  code,
  name: code,
  price: cents(Math.round(priceYuan * 100)) as Cents,
  category: 'test',
  kind: 'single',
  confidence: 'B',
  totals: totals(400, protein),
  evidence: [],
  unmatchedComponents: [],
  notes: [],
  ...extra,
});

const req = (preferences: Partial<MealRequest['preferences']> = {}): MealRequest => ({
  budgetCny: 35,
  orderMode: 'pickup',
  storeCode: 'TEST',
  preferences: { priority: 'balance', ...preferences },
});

const quote = (
  it: AnalyzedItem,
  priceYuan: number,
  extra: { productList?: { productCode: string; productName: string; quantity: number; subtotal: number }[] } = {},
): PriceAttempt => ({
  quote: toPriceResult({
    price: Math.round(priceYuan * 100),
    productList:
      extra.productList ??
      [{ productCode: it.code, productName: it.name, quantity: 1, subtotal: Math.round(priceYuan * 100) }],
    takeWayList: [],
  }),
  receipt: {
    tool: 'calculate-price',
    argsSummary: `items=[${it.code}×1]`,
    at: new Date().toISOString(),
    ok: true,
    attempt: 1,
    durationMs: 0,
  },
});

// ─────────────── R1 · 硬条件不可绕过 ───────────────

describe('R1 · 折扣回补必须仍守住最低蛋白（其余硬条件同理）', () => {
  test('唯一候选蛋白不达标、即使官方价更低，也不得生成推荐', async () => {
    const { recommendation } = await recommendForMenu(
      [item('low-protein', 40, 1)],
      req({ minimumProteinGrams: 25 }),
      async (it) => quote(it, 20),
    );
    assert.equal(recommendation.plans.length, 0, '1g 蛋白不得满足 25g 下限');
  });

  test('价格下降 / 回补 / 报价失败 / 组成变化，均不改变「非价格条件先验」', async () => {
    const cheaper = await recommendForMenu(
      [item('A', 40, 1), item('B', 10, 30)],
      req({ minimumProteinGrams: 25, avoidSugaryDrinks: true }),
      async (it) => quote(it, 5), // 全部压到 ¥5：价格条件全过，但 A 仍应被非价格条件挡下
    );
    assert.deepEqual(
      cheaper.recommendation.plans.map((p) => p.priced.item.code).filter((c) => c === 'A'),
      [],
      '低价不得让低蛋白方案冒出来',
    );
  });
});

// ─────────────── R2 · 避糖按实际组件判定 ───────────────

describe('R2 · 避糖必须检查已匹配的套餐组件', () => {
  test('离线避糖：含普通可乐的套餐不得出现在方案里', async () => {
    const out = await runOfflineForTest({ budget: 35, avoidSugary: true, json: true });
    const d = JSON.parse(out) as {
      recommendation: { plans: { priced: { item: { code: string; evidence: { label: string }[] } } }[] };
    };
    for (const p of d.recommendation.plans) {
      const labels = p.priced.item.evidence.map((e) => e.label).join('｜');
      assert.ok(!labels.includes('可乐中杯'), `避糖后仍推荐了含普通可乐的套餐：${labels}`);
    }
  });

  test('三态判定：明确含糖 / 明确无糖 / 成分未知', () => {
    assert.equal(classifySugary('可乐中杯'), 'sugary');
    assert.equal(classifySugary('零度可乐'), 'sugar-free');
    assert.equal(classifySugary('雪碧纤维+'), 'sugar-free');
    assert.equal(classifySugary('巨无霸'), 'unknown');

    // 组件级：已匹配的普通可乐 → 判为含糖
    const combo = item('C1', 30, 20, {
      kind: 'combo',
      components: [
        { roundName: '主食', choiceCode: 'x', choiceName: '巨无霸', nutritionName: '巨无霸', nutritionMatched: true, method: 'exact', quantity: 1 },
        { roundName: '饮料', choiceCode: 'y', choiceName: '可乐中杯', nutritionName: '可乐中杯', nutritionMatched: true, method: 'exact', quantity: 1 },
      ],
    });
    assert.equal(assessSugary(combo).sugary, true);

    // 零糖组件不得被误杀
    const zero = item('C2', 30, 20, {
      kind: 'combo',
      components: [
        { roundName: '主食', choiceCode: 'x', choiceName: '巨无霸', nutritionName: '巨无霸', nutritionMatched: true, method: 'exact', quantity: 1 },
        { roundName: '饮料', choiceCode: 'z', choiceName: '零度可乐', nutritionName: '零度可乐', nutritionMatched: true, method: 'exact', quantity: 1 },
      ],
    });
    assert.equal(assessSugary(zero).sugary, false, '明确无糖不得被误判为含糖');

    // 成分未核实的饮品组件 → 不宣称满足避糖
    const unknownDrink = item('C3', 30, 20, {
      kind: 'combo',
      components: [
        { roundName: '饮料', choiceCode: 'w', choiceName: '某某气泡饮', nutritionName: null, nutritionMatched: false, method: 'unmatched', quantity: 1 },
      ],
    });
    assert.equal(assessSugary(unknownDrink).unverified, true);
    assert.equal(assessSugary(unknownDrink).sugary, true);
  });
});

// ─────────────── R3/R4 · 最终复核真的执行、且不丢组件 ───────────────

describe('R3/R4 · 最终复核必须真执行、且完整传递组成', () => {
  test('R3：推荐必须真的执行它所声称的最终复核', async () => {
    let calls = 0;
    await recommendForMenu([item('A', 20, 25)], req(), async (it) => quote(it, ++calls === 1 ? 20 : 40));
    assert.ok(calls >= 2, `只调用了 ${calls} 次——最终复核没有接入主流程`);
  });

  test('R3：复核变价后不得继续以旧价出现（¥20 → ¥40，预算 ¥35）', async () => {
    let calls = 0;
    const { recommendation } = await recommendForMenu(
      [item('A', 20, 25)],
      req(),
      async (it) => quote(it, ++calls === 1 ? 20 : 40),
    );
    assert.equal(
      recommendation.plans.filter((p) => p.priced.effectivePrice === cents(2000)).length,
      0,
      '复核后超预算，不得仍作为「预算内 ¥20」方案展示',
    );
    assert.ok(
      recommendation.notes.some((n) => n.includes('最终复核')),
      '必须留下复核痕迹',
    );
  });

  test('R4：最终复核保留全部组件与数量，并写入收据与指纹', async () => {
    const candidate = (await confirmPrices([item('meal', 20, 25)], cents(3500), async (it) => quote(it, 20))).within[0]!;
    let received: { code: string } | undefined;
    const result = await requoteFinal(
      candidate,
      async (it) => {
        received = it;
        return quote(it, 20);
      },
      [
        { productCode: 'A', quantity: 2 },
        { productCode: 'B', quantity: 3 },
      ],
    );
    assert.match(result.receipt.argsSummary, /A×2,B×3/, '收据必须体现完整清单');
    assert.equal(result.receipt.stage, 'final');
    assert.ok(result.receipt.requestFingerprint, '必须带组成指纹（进缓存标识）');
    assert.equal(received?.code, 'meal');
    assert.deepEqual(result.request.items.map((i) => `${i.productCode}×${i.quantity}`), ['A×2', 'B×3']);
  });
});

// ─────────────── R5 · 评分跟随实际采用的价 ───────────────

describe('R5 · 价格评分必须跟随「实际采用的官方价」', () => {
  test('菜单价顺序与官方价相反时，价格分随实付变化', async () => {
    const { recommendation } = await recommendForMenu(
      [item('A', 10, 20), item('B', 20, 20)],
      req(),
      async (it) => quote(it, it.code === 'A' ? 30 : 5),
    );
    const budget = recommendation.plans.find((p) => p.key === 'budget')!;
    assert.equal(budget.priced.item.code, 'B');
    assert.equal(budget.score.budgetScore, 1, '官方价最便宜者应得最高价格分');
  });
});

// ─────────────── R6/R7 · 回执与溯源不得虚报 ───────────────

describe('R6/R7 · 离线回执与溯源必须如实', () => {
  test('R6：完全离线 ⇒ 回执报「0 次真实官方请求」', async () => {
    const d = JSON.parse(await runOfflineForTest({ budget: 35, avoidSugary: true, json: true })) as {
      recommendation: { notes: string[]; plans: { priced: { receipt: { attempt: number } } }[] };
    };
    const note = d.recommendation.notes.find((s) => s.includes('本次共发起'));
    assert.ok(note, '回执必须给出请求统计');
    assert.match(note, /本次共发起 0 次/, `离线不得虚报请求次数：${note}`);
    assert.ok(
      d.recommendation.plans.every((p) => p.priced.receipt.attempt === 0),
      '离线收据的 attempt 应为 0（未发起）',
    );
  });

  test('R7：离线溯源不得把夹具加载写成一次成功的真实调用', async () => {
    const d = JSON.parse(await runOfflineForTest({ budget: 35, json: true })) as {
      recommendation: { plans: { explanation: { toolCallTrace: { tool: string; ok: boolean; channel?: string }[] } }[] };
    };
    const traces = d.recommendation.plans.flatMap((p) =>
      p.explanation.toolCallTrace.filter((t) => ['query-meals', 'query-meal-detail'].includes(t.tool)),
    );
    assert.ok(traces.length > 0, '离线也应有取数轨迹（标明来源）');
    assert.ok(!traces.some((t) => t.ok === true), '夹具加载不得被写成成功调用');
    assert.ok(traces.every((t) => t.channel === 'offline'), '离线轨迹必须标明渠道');
  });
});

// ─────────────── R8 · 工具/业务错误不得当成功 ───────────────

describe('R8 · MCP 显式失败不得被当作成功价格数据', () => {
  const clientWith = (payload: unknown) =>
    new McpClient({
      url: 'http://local.invalid',
      token: 'DUMMY_REVIEW_TOKEN',
      maxRetries: 0,
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init?.body as string) as { id: number };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: payload }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });

  const args = { storeCode: 'TEST', orderType: 1 as const, beType: 1 as const, items: [{ productCode: 'A', quantity: 1 }] };

  test('工具 isError=true ⇒ 抛错（不得返回零元报价）', async () => {
    const client = clientWith({
      isError: true,
      content: [
        { type: 'text', text: JSON.stringify({ success: false, code: 500, message: 'boom', data: { price: 0, productList: [] } }) },
      ],
    });
    await assert.rejects(() => client.calculatePrice(args));
  });

  test('业务 success=false ⇒ 抛错', async () => {
    const client = clientWith({
      content: [
        { type: 'text', text: JSON.stringify({ success: false, code: 500, message: 'boom', data: { price: 0, productList: [] } }) },
      ],
    });
    await assert.rejects(() => client.calculatePrice(args));
  });

  test('正常响应仍可解析（不误伤）', async () => {
    const client = clientWith({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, code: 200, data: { price: 3800, productList: [{ productCode: 'A', productName: 'A', quantity: 1, subtotal: 3800 }] } }),
        },
      ],
    });
    const p = await client.calculatePrice(args);
    assert.equal(p.price, 3800);
  });
});

// ─────────────── R9 · 空清单 0 元不得核实非空购物篮 ───────────────

describe('R9 · 报价对象必须核对（合法 0 元仍支持）', () => {
  test('空清单 ¥0 不得把非空购物篮标为「已核实」', async () => {
    const r = await confirmPrices([item('A', 20, 20)], cents(3500), async (it) =>
      quote(it, 0, { productList: [] }),
    );
    assert.ok(!r.within.some((p) => p.verified), '空响应不得作为已核实依据');
  });

  test('对象对得上的 ¥0（赠品/全额优惠）仍被采纳为已核实', async () => {
    const r = await confirmPrices([item('A', 20, 20)], cents(3500), async (it) => quote(it, 0));
    const p = r.within[0]!;
    assert.equal(p.verified, true);
    assert.equal(p.effectivePrice, 0);
  });

  test('响应商品码与请求不符 ⇒ 标为未核实', async () => {
    const r = await confirmPrices([item('A', 20, 20)], cents(3500), async () => ({
      quote: toPriceResult({
        price: 2000,
        productList: [{ productCode: 'OTHER', productName: 'OTHER', quantity: 1, subtotal: 2000 }],
        takeWayList: [],
      }),
      receipt: { tool: 'calculate-price', argsSummary: 'items=[A×1]', at: new Date().toISOString(), ok: true, attempt: 1, durationMs: 0 },
    }));
    assert.equal(r.within[0]!.verified, false, '商品码不符不得算已核实');
  });
});

// ─────────────── R10 · priority 必须真正生效 ───────────────

describe('R10 · priority 必须改变首选（≥3 组反向输入）', () => {
  const groups: AnalyzedItem[][] = [
    [item('cheap', 10, 10), item('highP', 30, 40), item('mid', 20, 25)],
    [item('c1', 8, 6), item('p1', 32, 33), item('m1', 18, 18)],
    [item('c2', 12, 12), item('p2', 25, 45), item('m2', 22, 22)],
  ];

  for (const [idx, items] of groups.entries()) {
    test(`第 ${idx + 1} 组：budget 与 protein 首要方案不同`, async () => {
      const pricer: Pricer = async (it) => quote(it, (it.price ?? 0) / 100);
      const rb = await recommendForMenu(items, req({ priority: 'budget' }), pricer);
      const rp = await recommendForMenu(items, req({ priority: 'protein' }), pricer);
      const first = (r: typeof rb) => r.recommendation.plans[0]!.priced.item.code;
      assert.notEqual(first(rb), first(rp), 'priority 未改变首选排序');
      assert.equal(rb.recommendation.plans[0]!.key, 'budget');
      assert.equal(rp.recommendation.plans[0]!.key, 'protein');
      assert.equal(rb.recommendation.primaryKey, 'budget');
    });
  }

  test('balance 也要有自己的首选，且理由不含未核实的「实付最低」', async () => {
    const items = groups[0]!;
    const { recommendation } = await recommendForMenu(items, req({ priority: 'balance' }), async (it) =>
      ({ quote: null, receipt: { tool: 'calculate-price', argsSummary: `items=[${it.code}×1]`, at: new Date().toISOString(), ok: false, attempt: 1, errorCode: 'TIMEOUT', durationMs: 0 } }),
    );
    assert.equal(recommendation.plans[0]!.key, 'balance');
    const budgetPlan = recommendation.plans.find((p) => p.key === 'budget');
    if (budgetPlan) {
      assert.ok(!budgetPlan.reason.includes('实付最低'), '未核实不得声称实付最低');
      assert.ok(budgetPlan.reason.includes('未核实') || budgetPlan.reason.includes('菜单价'));
    }
  });
});

// ─────────────── 工程项：版本协商 / 新鲜度 / 采集保护 ───────────────

describe('工程项 · 协议版本协商三态', () => {
  const initClient = (serverVersion: string | undefined) =>
    new McpClient({
      url: 'http://local.invalid',
      token: 'DUMMY_REVIEW_TOKEN',
      maxRetries: 0,
      sleepImpl: async () => {},
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init?.body as string) as { id?: number; method?: string };
        if (request.method === 'notifications/initialized' || request.id === undefined) {
          return new Response('', { status: 202 });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              serverInfo: { name: 'fake', version: '1.0' },
              ...(serverVersion === undefined ? {} : { protocolVersion: serverVersion }),
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });

  test('服务端回同一版本 → agreed', async () => {
    const info = await initClient('2025-06-18').initialize();
    assert.equal(info.protocolNegotiation, 'agreed');
  });

  test('服务端回不同版本 → server-different（如实记录，不静默改口径）', async () => {
    const info = await initClient('2025-03-26').initialize();
    assert.equal(info.protocolNegotiation, 'server-different');
    assert.equal(info.serverProtocolVersion, '2025-03-26');
  });

  test('服务端未回版本 → not-returned', async () => {
    const info = await initClient(undefined).initialize();
    assert.equal(info.protocolNegotiation, 'not-returned');
  });
});

describe('工程项 · 新鲜度（时区与未来边界）', () => {
  test('无时区的时间戳按 +08:00 解读，并标记 timezoneAssumed', () => {
    const parsed = parseCapturedAt('2026-10-10 20:08:57');
    assert.equal(parsed.timezoneAssumed, true);
    assert.equal(parsed.normalized, '2026-10-10T20:08:57+08:00');
  });

  test('在时效内判 fresh；超时判 stale', () => {
    const now = new Date('2026-10-10T12:30:00Z'); // = 20:30 +08:00
    assert.equal(freshnessOf('2026-10-10 20:08:57', 'menu', { now }).status, 'fresh');
    assert.equal(freshnessOf('2026-10-10 18:00:00', 'menu', { now }).status, 'stale');
  });

  test('未来时间戳 ⇒ unknown（不当成"更新鲜"）', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const f = freshnessOf('2026-10-10 23:00:00', 'menu', { now });
    assert.equal(f.status, 'unknown');
    assert.ok(f.note.includes('未来'));
  });
});

describe('工程项 · 采集写入保护（大小写与前缀绕过）', () => {
  test('fixtures* 及其大小写变体一律拒绝', () => {
    assert.ok(forbiddenWrite('fixtures/baseline-x', REPO_ROOT));
    assert.ok(forbiddenWrite('Fixtures/baseline-x', REPO_ROOT), 'Windows 大小写变体必须一并拦下');
    assert.ok(forbiddenWrite('FIXTURES', REPO_ROOT));
    assert.ok(forbiddenWrite('Fixtures-extra', REPO_ROOT), '同为受保护目录（normalize 后一致）');
  });

  test('仓库外的路径一律拒绝', () => {
    assert.ok(forbiddenWrite('C:/Windows/Temp/capture', REPO_ROOT));
  });

  test('work/captures 允许写入', () => {
    assert.equal(forbiddenWrite('work/captures/20261012-1200-00-abc-3450024', REPO_ROOT), null);
  });
});
