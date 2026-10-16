/**
 * 决策内核单元测试（T2.1–T2.5）
 *
 * 逐条对账计划书第 6 节的硬要求：
 *   · §6.2 硬约束：数据不达标不进数值榜单；过敏无法验证时**不返回「安全」**
 *   · §6.3 评分：候选集内归一化；**无目标权重重归一化**；**缺项不得填 0**
 *   · §6.2 帕累托前沿
 *   · §6.2/§6.3 预算硬约束与「最接近且明确超出」备选
 *   · §6.4 三卡**真实不同**；不足三项**如实展示**
 *   · §6.5 解释中的 **X/Y 必须由程序计算**，缺数据不许编
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalyzedItem } from '../src/analyze.ts';
import type { NutritionTotals } from '../src/decompose.ts';
import type { Confidence } from '../src/matching.ts';
import { cents, type Cents } from '../src/money.ts';
import {
  applyHardConstraints,
  looksSugary,
  type MealRequest,
} from '../src/constraints.ts';
import { buildScoreContext, scoreItem, effectiveWeights, paretoFront, DEFAULT_WEIGHTS } from '../src/score.ts';
import { confirmPrices, requoteFinal, type Pricer, type PriceAttempt } from '../src/pricing.ts';
import { recommendForMenu } from '../src/recommend.ts';
import { explainPlan, comparePlans } from '../src/explain.ts';
import { toPriceResult } from '../src/schema.ts';

// ─────────────── 造数据的小工具 ───────────────

const nt = (value: number | null, complete = true) => ({
  value,
  complete,
  knownCount: value === null ? 0 : 1,
  totalCount: 1,
});

/** 未显式给出的字段给一个默认非空值；显式传 null 则保持 null */
const or = (x: number | null | undefined, dflt: number): number | null => (x === undefined ? dflt : x);

const totals = (o: {
  kcal?: number | null;
  protein?: number | null;
  fat?: number | null;
  carb?: number | null;
  sodium?: number | null;
}): NutritionTotals => ({
  energyKcal: nt(or(o.kcal, 400)),
  protein: nt(or(o.protein, 20)),
  fat: nt(or(o.fat, 15)),
  carbohydrate: nt(or(o.carb, 40)),
  sodium: nt(or(o.sodium, 600)),
});

const item = (
  code: string,
  name: string,
  priceYuan: number | null,
  n: { kcal?: number | null; protein?: number | null; sodium?: number | null } = {},
  confidence: Confidence = 'B',
  extra: Partial<AnalyzedItem> = {},
): AnalyzedItem => ({
  code,
  name,
  price: priceYuan === null ? null : (cents(priceYuan * 100) as Cents),
  category: '测试',
  kind: 'single',
  totals: totals(n),
  confidence,
  evidence: [{ kind: 'official-single', label: `官方单品营养：${name}` }],
  unmatchedComponents: [],
  notes: [],
  ...extra,
});

const req = (over: Partial<MealRequest> = {}): MealRequest => ({
  budgetCny: 35,
  orderMode: 'pickup',
  storeCode: '3450024',
  preferences: { priority: 'balance' },
  ...over,
});

/**
 * 构造一份**能通过报价对象核对**的成功报价（v3 契约）：
 * 响应的 productList 必须与请求的商品码/数量对得上——否则按「未核实」处理。
 */
const priceResult = (
  yuan: number,
  originalYuan = yuan,
  discountYuan = 0,
  code = 'TEST',
  qty = 1,
) =>
  toPriceResult({
    price: Math.round(yuan * 100),
    originalPrice: Math.round(originalYuan * 100),
    discount: Math.round(discountYuan * 100),
    productList: [
      {
        productCode: code,
        productName: `测试商品${code}`,
        quantity: qty,
        originalSubtotal: Math.round(originalYuan * 100),
        subtotal: Math.round(yuan * 100),
      },
    ],
    takeWayList: [],
  });

/** 成功报价 + 结构化收据（计价器的新契约：结果与收据一起返回） */
const okAttempt = (yuan: number, originalYuan = yuan, discountYuan = 0, code = 'TEST'): PriceAttempt => ({
  quote: priceResult(yuan, originalYuan, discountYuan, code),
  receipt: {
    tool: 'calculate-price',
    argsSummary: `items=[${code}×1]`,
    at: new Date().toISOString(),
    ok: true,
    attempt: 1,
    durationMs: 1,
    responseHash: 'testhash0001',
  },
});

/** 失败报价：**如实**标 ok:false，而不是抛错或返回 null 让上层猜 */
const failAttempt = (code = 'TIMEOUT'): PriceAttempt => ({
  quote: null,
  receipt: {
    tool: 'calculate-price',
    argsSummary: 'items=[TEST×1]',
    at: new Date().toISOString(),
    ok: false,
    attempt: 1,
    errorCode: code,
    errorMessage: `模拟失败（${code}）`,
    durationMs: 1,
  },
});

// ─────────────── T2.1 硬约束 ───────────────

describe('T2.1 · 硬约束与结构可行性', () => {
  test('数据不达标（C/D 级）不进数值榜单，但被单独记录', () => {
    const r = applyHardConstraints(
      [
        item('A', '合格堡', 25, { kcal: 500, protein: 25 }),
        item('B', '部分可知堡', 25, { kcal: 500, protein: 25 }, 'C'),
        item('C', '未收录堡', 25, {}, 'D'),
      ],
      req(),
    );
    assert.equal(r.accepted.length, 1);
    assert.equal(r.accepted[0]!.code, 'A');
    assert.equal(r.dataInsufficient.length, 2);
    assert.equal(r.rejected.length, 2);
    assert.ok(r.rejected.every((x) => x.reason === 'data-insufficient'));
  });

  test('A/B 级但关键营养缺项 → 仍判数据不足', () => {
    const r = applyHardConstraints([item('A', '缺蛋白堡', 20, { kcal: 500, protein: null }, 'B')], req());
    assert.equal(r.accepted.length, 0);
    assert.equal(r.dataInsufficient.length, 1);
  });

  test('超预算被拒，且说明金额', () => {
    const r = applyHardConstraints([item('A', '贵堡', 50, { kcal: 500, protein: 25 })], req({ budgetCny: 35 }));
    assert.equal(r.accepted.length, 0);
    assert.equal(r.rejected[0]!.reason, 'over-budget');
    assert.ok(r.rejected[0]!.detail.includes('50.00'));
  });

  test('最低蛋白下限生效，且缺数据者不被当作「达标」', () => {
    const r = applyHardConstraints(
      [
        item('A', '低蛋白', 20, { kcal: 300, protein: 5 }),
        item('B', '高蛋白', 20, { kcal: 400, protein: 30 }),
      ],
      req({ preferences: { priority: 'protein', minimumProteinGrams: 20 } }),
    );
    assert.deepEqual(r.accepted.map((i) => i.code), ['B']);
    assert.equal(r.rejected[0]!.reason, 'below-min-protein');
  });

  test('避开含糖饮料：名称与套餐组件都算', () => {
    assert.equal(looksSugary(item('A', '可乐', 8)), true);
    assert.equal(
      looksSugary(item('B', '某套餐', 30, {}, 'B', { unmatchedComponents: ['选择饮料：雪碧'] })),
      true,
    );
    assert.equal(looksSugary(item('C', '巨无霸', 25)), false);

    const r = applyHardConstraints(
      [item('A', '可乐', 8, { kcal: 150, protein: 0 }), item('B', '巨无霸', 25, { kcal: 513, protein: 27 })],
      req({ preferences: { priority: 'balance', avoidSugaryDrinks: true } }),
    );
    assert.deepEqual(r.accepted.map((i) => i.code), ['B']);
    assert.equal(r.rejected[0]!.reason, 'sugary-drink');
  });

  test('⭐ 声明过敏 → 安全闸开启，notice 明说「无法保证安全」', () => {
    const r = applyHardConstraints(
      [item('A', '巨无霸', 25, { kcal: 513, protein: 27 })],
      req({ safety: { allergyDeclared: true } }),
    );
    assert.equal(r.safetyBlocked, true);
    assert.ok(r.safetyNotice);
    assert.ok(r.safetyNotice!.includes('无法保证'));
    assert.ok(r.safetyNotice!.includes('不构成安全结论'));
    // 但候选仍可展示（用于了解营养构成），只是不许声称安全
    assert.equal(r.accepted.length, 1);
  });

  test('未声明过敏 → 安全闸不触发', () => {
    const r = applyHardConstraints([item('A', '巨无霸', 25, { kcal: 513, protein: 27 })], req());
    assert.equal(r.safetyBlocked, false);
    assert.equal(r.safetyNotice, null);
  });
});

// ─────────────── T2.2 评分 ───────────────

describe('T2.2 · 多目标评分', () => {
  test('候选集内归一化：价格最低得 1，最高得 0', () => {
    const items = [
      item('A', '便宜', 10, { kcal: 300, protein: 10 }),
      item('B', '中价', 20, { kcal: 400, protein: 20 }),
      item('C', '贵货', 30, { kcal: 500, protein: 30 }),
    ];
    const ctx = buildScoreContext(items, req());
    assert.equal(scoreItem(items[0]!, ctx, 'budget').budgetScore, 1);
    assert.equal(scoreItem(items[2]!, ctx, 'budget').budgetScore, 0);
    assert.equal(scoreItem(items[2]!, ctx, 'protein').proteinScore, 1);
  });

  test('⭐ 缺项不得填 0：蛋白质缺失 → 分量为 null，且权重被剔除', () => {
    const items = [item('A', '缺蛋白', 20, { kcal: 300, protein: null })];
    const ctx = buildScoreContext(items, req());
    const s = scoreItem(items[0]!, ctx, 'balance');
    assert.equal(s.proteinScore, null, '蛋白质缺失不得记为 0 分');
    assert.equal(s.weightsUsed.protein, 0);
    assert.ok(s.notes.some((n) => n.includes('不以 0 冒充')));
  });

  test('⭐ 无热量目标 → energyFit 不计，权重重归一化（和仍为 1）', () => {
    const items = [item('A', 'X', 20, { kcal: 400, protein: 20 })];
    const ctx = buildScoreContext(items, req()); // 未给 energyTargetKcal
    const s = scoreItem(items[0]!, ctx, 'balance');
    assert.equal(s.energyFit, null);
    const sum = s.weightsUsed.budget + s.weightsUsed.protein + s.weightsUsed.energyFit;
    assert.ok(Math.abs(sum - 1) < 1e-9, `权重和应为 1，实际 ${sum}`);
    assert.equal(s.weightsUsed.energyFit, 0);
  });

  test('给出热量目标 → energyFit 计入，且权重和为 1', () => {
    const items = [item('A', 'X', 20, { kcal: 700, protein: 20 })];
    const ctx = buildScoreContext(items, req({ preferences: { priority: 'balance', energyTargetKcal: 700 } }));
    const s = scoreItem(items[0]!, ctx, 'balance');
    assert.equal(s.energyFit, 1, '恰好命中目标应为 1');
    const sum = s.weightsUsed.budget + s.weightsUsed.protein + s.weightsUsed.energyFit;
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  test('effectiveWeights：不可用分量剔除后按比例归一化', () => {
    const { weights, notes } = effectiveWeights('balance', { budget: true, protein: true, energyFit: false });
    assert.ok(Math.abs(weights.budget + weights.protein + weights.energyFit - 1) < 1e-9);
    assert.equal(weights.energyFit, 0);
    // 原比例 0.35 : 0.35 → 各 0.5
    assert.ok(Math.abs(weights.budget - 0.5) < 1e-9);
    assert.ok(notes.some((n) => n.includes('重新分配')));
  });

  test('三种模式的默认权重与计划书示例一致', () => {
    assert.deepEqual(DEFAULT_WEIGHTS.budget, { budget: 0.65, protein: 0.25, energyFit: 0.1 });
    assert.deepEqual(DEFAULT_WEIGHTS.protein, { budget: 0.2, protein: 0.65, energyFit: 0.15 });
    assert.deepEqual(DEFAULT_WEIGHTS.balance, { budget: 0.35, protein: 0.35, energyFit: 0.3 });
  });

  test('帕累托前沿：被支配者剔除', () => {
    // A 又便宜蛋白又多 → 支配 B；C 蛋白最高但更贵 → 不被支配
    const A = item('A', 'A', 10, { kcal: 300, protein: 20 });
    const B = item('B', 'B', 20, { kcal: 300, protein: 10 }); // 更贵且蛋白更少 → 被 A 支配
    const C = item('C', 'C', 30, { kcal: 300, protein: 40 });
    const front = paretoFront([A, B, C], (i) => [
      { key: 'price', value: i.price === null ? Number.POSITIVE_INFINITY : i.price / 100, higherIsBetter: false },
      { key: 'protein', value: i.totals.protein.value ?? 0, higherIsBetter: true },
    ]);
    const codes = front.map((i) => i.code).sort();
    assert.deepEqual(codes, ['A', 'C']);
  });
});

// ─────────────── T2.3 计价闭环 ───────────────

describe('T2.3 · 计价闭环与预算约束', () => {
  const budget = cents(3500);

  test('官方计价被采纳，且菜单价与实付不一致时如实标注', async () => {
    const pricer: Pricer = async (it) => okAttempt(32, 38, 6, it.code); // 菜单 35，实付 32
    const r = await confirmPrices([item('A', '堡', 35, { kcal: 500, protein: 25 })], budget, pricer);
    assert.equal(r.within.length, 1);
    const p = r.within[0]!;
    assert.equal(p.priceSource, 'official');
    assert.equal(p.effectivePrice, 3200);
    assert.ok(p.notes.some((n) => n.includes('菜单价') && n.includes('不同')));
  });

  test('官方计价失败 → 回退菜单价，并**明确标注未核实**', async () => {
    const pricer: Pricer = async () => failAttempt('TIMEOUT');
    const r = await confirmPrices([item('A', '堡', 30, { kcal: 500, protein: 25 })], budget, pricer);
    const p = r.within[0]!;
    assert.equal(p.priceSource, 'menu');
    assert.ok(p.notes.some((n) => n.includes('未核实实付')));
  });

  test('超预算被排除在「预算内」之外', async () => {
    const pricer: Pricer = async (it) => okAttempt(40, 40, 0, it.code);
    const r = await confirmPrices([item('A', '贵堡', 40, { kcal: 500, protein: 25 })], budget, pricer);
    assert.equal(r.within.length, 0);
    assert.equal(r.nearestOver?.item.code, 'A');
    assert.equal(r.nearestOver?.overByCents, 500); // ¥40 - ¥35
    assert.ok(r.notes.some((n) => n.includes('超出预算') && n.includes('明确同意')));
  });

  test('全部超预算：给出「最接近」的那个', async () => {
    const pricer: Pricer = async (it) => okAttempt(it.code === 'A' ? 60 : 38, it.code === 'A' ? 60 : 38, 0, it.code);
    const r = await confirmPrices(
      [item('A', '很贵堡', 60, { kcal: 500, protein: 25 }), item('B', '小超堡', 38, { kcal: 400, protein: 20 })],
      budget,
      pricer,
    );
    assert.equal(r.within.length, 0);
    assert.equal(r.nearestOver?.item.code, 'B');
    assert.equal(r.nearestOver?.overByCents, 300);
  });
});

// ─────────────── T2.4 三方案 ───────────────

describe('T2.4 · 三方案生成与去重', () => {
  const makePool = () =>
    [
      item('CHEAP', '最便宜', 12, { kcal: 250, protein: 8 }),
      item('PROT', '高蛋白', 30, { kcal: 600, protein: 40 }),
      item('MID', '中间款', 22, { kcal: 450, protein: 22 }),
      item('MID2', '另一个中间款', 24, { kcal: 480, protein: 24 }),
    ];

  const pricer: Pricer = async (it) => okAttempt((it.price ?? 0) / 100, (it.price ?? 0) / 100, 0, it.code);

  const build = async (items: AnalyzedItem[], r = req()) => {
    const { recommendation } = await recommendForMenu(items, r, pricer);
    return recommendation;
  };

  test('三张卡真实不同（按 code 去重）', async () => {
    const rec = await build(makePool());
    assert.equal(rec.plans.length, 3);
    const codes = rec.plans.map((p) => p.priced.item.code);
    assert.equal(new Set(codes).size, 3, '三张卡不得指向同一商品');
  });

  test('预算优先确实选到最低价；蛋白质优先确实选到最高蛋白', async () => {
    const rec = await build(makePool());
    const byKey = Object.fromEntries(rec.plans.map((p) => [p.key, p]));
    assert.equal(byKey.budget!.priced.item.code, 'CHEAP');
    assert.equal(byKey.protein!.priced.item.code, 'PROT');
    assert.ok(byKey.balance);
  });

  test('⭐ 候选不足 → 如实展示 1–2 项并说明原因（不造齐三项）', async () => {
    const rec = await build([item('ONLY', '唯一候选', 20, { kcal: 400, protein: 20 })]);
    assert.equal(rec.plans.length, 1);
    assert.ok(rec.shortfallNote);
    assert.ok(rec.shortfallNote!.includes('仅给出 1 个方案'));
    assert.ok(rec.shortfallNote!.includes('不人为造齐三项'));
  });

  test('⭐ 预算内无可用候选 → plans 为空，且仍给出「最接近且明确超出」的备选', async () => {
    const rec = await build([item('A', '贵堡', 99, { kcal: 500, protein: 25 })], req({ budgetCny: 35 }));
    assert.equal(rec.plans.length, 0);
    assert.ok(rec.shortfallNote!.includes('没有可用方案'));
    // 「菜单价超预算」那批会被回头做官方计价，挑出最接近者——而不是直接判死
    assert.ok(rec.overBudgetNote, '应给出最接近预算的备选说明');
    assert.ok(rec.overBudgetNote!.includes('最接近'));
    assert.ok(rec.overBudgetNote!.includes('明确同意'));
  });

  test('⭐ 安全提示被传递到最终结果（不得在中途丢失）', async () => {
    const rec = await build(makePool(), req({ safety: { allergyDeclared: true } }));
    assert.ok(rec.safetyNotice);
    assert.ok(rec.safetyNotice!.includes('无法保证'));
  });

  test('方案自带可核对的理由与分量明细', async () => {
    const rec = await build(makePool());
    for (const p of rec.plans) {
      assert.ok(p.reason.length > 0);
      assert.ok(p.score.weightsUsed.budget + p.score.weightsUsed.protein + p.score.weightsUsed.energyFit > 0.99);
      assert.ok(p.explanation.statements.length > 0);
      assert.ok(p.explanation.evidenceIds.length > 0);
    }
  });
});

// ─────────────── T2.5 解释 ───────────────

describe('T2.5 · 证据驱动的解释', () => {
  const mk = (code: string, name: string, yuan: number, protein: number | null, quote = true) => ({
    item: item(code, name, yuan, { kcal: 400, protein }),
    quote: quote ? priceResult(yuan) : null,
    receipt: quote ? okAttempt(yuan).receipt : failAttempt('TIMEOUT').receipt,
    effectivePrice: cents(yuan * 100) as Cents,
    priceSource: (quote ? 'official' : 'menu') as 'official' | 'menu',
    withinBudget: true,
    overByCents: 0,
    notes: [],
    verified: quote,
    unavailable: false,
  });

  test('对比句里的数字由程序算出，可直接核对', () => {
    const a = mk('A', '甲', 30, 30);
    const b = mk('B', '乙', 20, 10);
    const stmts = comparePlans(a, b);
    const joined = stmts.join('\n');
    assert.ok(joined.includes('多 20.0g'), `应含蛋白差 20g：${joined}`);
    assert.ok(joined.includes('多 10.00元'), `应含价格差 10 元：${joined}`);
  });

  test('⭐ 一侧数据缺失 → 明说「无法比较」，绝不估算', () => {
    const a = mk('A', '甲', 30, null);
    const b = mk('B', '乙', 20, 10);
    const stmts = comparePlans(a, b);
    assert.ok(stmts.some((s) => s.includes('无法比较')), stmts.join('\n'));
    assert.ok(!stmts.some((s) => /多 \d+(\.\d+)?g/.test(s)), '缺数据时不得编出差值');
  });

  test('解释含 evidenceIds 与脱敏 toolCallTrace（不含 Token/地址）', () => {
    const priced = mk('A', '甲', 30, 20);
    // 取数执行事实由**取数方**留下；解释层只引用（v3：离线不得写成成功调用）
    priced.item.sourceTrace = [
      {
        tool: 'query-meals',
        channel: 'offline',
        ok: false,
        at: '2026-10-12T01:00:00.000Z',
        argsSummary: 'storeCode=<已脱敏>',
        errorCode: 'OFFLINE_FIXTURE',
        snapshotId: 'baseline-20261010-3450024',
      },
    ];
    const e = explainPlan(priced);
    assert.ok(e.evidenceIds.some((id) => id.startsWith('menu:')));
    assert.ok(e.evidenceIds.some((id) => id.startsWith('price:')));
    const trace = JSON.stringify(e.toolCallTrace);
    assert.ok(trace.includes('query-meals'));
    assert.ok(!/Bearer|token|Token/.test(trace), '轨迹不得含凭据');
    assert.ok(trace.includes('已脱敏'), '门店编码应脱敏');
    assert.equal(
      e.toolCallTrace.find((t) => t.tool === 'query-meals')?.ok,
      false,
      '离线读取不得被写成一次成功的查询调用',
    );
  });

  test('官方计价未取得时，解释如实说明「未核实」', () => {
    const e = explainPlan(mk('A', '甲', 30, 20, false));
    assert.ok(e.statements.some((s) => s.includes('未核实实付')));
    assert.equal(e.toolCallTrace.find((t) => t.tool === 'calculate-price')?.ok, false);
  });
});

// ─────────────── T2.3 补充 · 外部评审 P0-3 的处置 ───────────────

describe('T2.3 补充 · 收据 / 0 元报价 / 有界并发 / 止损', () => {
  const budget = cents(3500);

  test('⭐ 合法的 0 元报价被采纳（0 元 ≠ 没拿到报价）', async () => {
    const pricer: Pricer = async (it) => okAttempt(0, 0, 0, it.code);
    const r = await confirmPrices([item('A', '赠品堡', 20, { kcal: 400, protein: 20 })], budget, pricer);
    const p = r.within[0]!;
    assert.equal(p.priceSource, 'official');
    assert.equal(p.effectivePrice, 0);
    assert.equal(p.verified, true);
    assert.ok(p.notes.some((n) => n.includes('¥0.00') && n.includes('不是')));
  });

  test('官方未给价格（quote=null）→ 才回退菜单价，并标未核实', async () => {
    const pricer: Pricer = async () => failAttempt('BAD_RESPONSE');
    const r = await confirmPrices([item('A', '堡', 20, { kcal: 400, protein: 20 })], budget, pricer);
    const p = r.within[0]!;
    assert.equal(p.priceSource, 'menu');
    assert.equal(p.verified, false);
    assert.equal(p.receipt.ok, false);
    assert.equal(p.receipt.errorCode, 'BAD_RESPONSE');
  });

  test('每次报价都产出结构化收据（含失败），并汇总进 outcome.receipts', async () => {
    const pricer: Pricer = async (it) => (it.code === 'B' ? failAttempt('TIMEOUT') : okAttempt(20, 20, 0, it.code));
    const r = await confirmPrices(
      [item('A', '甲', 20, { kcal: 400, protein: 20 }), item('B', '乙', 22, { kcal: 400, protein: 20 })],
      budget,
      pricer,
    );
    assert.equal(r.receipts.length, 2);
    const failed = r.receipts.find((x) => !x.ok)!;
    assert.equal(failed.errorCode, 'TIMEOUT');
    assert.ok(failed.at.length > 0, '收据必须带时刻');
    assert.match(failed.argsSummary, /items=\[/);
    const oks = r.receipts.find((x) => x.ok)!;
    assert.ok(oks.responseHash, '成功收据应含响应哈希');
  });

  test('请求预算封顶：超出预算的候选标「未发起」并如实降级', async () => {
    const seen: string[] = [];
    const pricer: Pricer = async (it) => {
      seen.push(it.code);
      return okAttempt(10, 10, 0, it.code);
    };
    const many = Array.from({ length: 6 }, (_, i) => item(`C${i}`, `候选${i}`, 10, { kcal: 300, protein: 10 }));
    const r = await confirmPrices(many, budget, pricer, { maxRequests: 2, concurrency: 1 });
    assert.equal(seen.length, 2, '只应发起 2 次请求');
    const skipped = r.receipts.filter((x) => x.errorCode === 'BUDGET_EXCEEDED');
    assert.equal(skipped.length, 4);
    assert.ok(skipped.every((x) => x.attempt === 0), '未发起的收据 attempt 应为 0');
    assert.ok(r.notes.some((n) => n.includes('请求预算上限')));
  });

  test('遇 429 → 停止后续计价（止损），并记明原因', async () => {
    let calls = 0;
    const pricer: Pricer = async () => {
      calls++;
      return failAttempt('RATE_LIMITED');
    };
    const many = Array.from({ length: 5 }, (_, i) => item(`D${i}`, `候选${i}`, 10, { kcal: 300, protein: 10 }));
    const r = await confirmPrices(many, budget, pricer, { concurrency: 1 });
    assert.ok(calls < 5, `应在限流后停止，实际调用了 ${calls} 次`);
    assert.ok(r.notes.some((n) => n.includes('限流')));
    assert.ok(r.notes.some((n) => n.includes('未核实实付')));
  });

  test('并发上限生效（不会一次打满）', async () => {
    let inFlight = 0;
    let peak = 0;
    const pricer: Pricer = async (it) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return okAttempt(10, 10, 0, it.code);
    };
    const many = Array.from({ length: 9 }, (_, i) => item(`E${i}`, `候选${i}`, 10, { kcal: 300, protein: 10 }));
    await confirmPrices(many, budget, pricer, { concurrency: 3 });
    assert.ok(peak <= 3, `并发峰值应 ≤3，实际 ${peak}`);
  });

  test('最终复核：与初次报价不一致时如实指出', async () => {
    const p = {
      item: item('A', '堡', 20, { kcal: 400, protein: 20 }),
      quote: null,
      receipt: failAttempt().receipt,
      effectivePrice: cents(2000) as Cents,
      priceSource: 'menu' as const,
      withinBudget: true,
      overByCents: 0,
      notes: [],
      verified: false,
      unavailable: false,
    };
    const pricer: Pricer = async (it) => okAttempt(22, 22, 0, it.code);
    const r = await requoteFinal(p, pricer);
    assert.equal(r.price, 2200);
    assert.equal(r.consistent, false);
    assert.ok(r.note.includes('以复核价为准'));
  });
});
