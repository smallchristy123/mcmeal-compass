/**
 * v3 复审新增探针 R11–R13 的**回归测试**（2026-10-12）
 *
 * 来源：外部复审《McMeal Compass V3 高要求复审报告》新增的三项阻断项，
 * 探针脚本 `mcmeal-v3-additional-probes-2026-10-12.mjs`（R11/R12/R13）。
 *
 * 迁移原则与 R1–R10 相同：**要求只可迁移、不可删改**。
 * 另覆盖复审提出的两个次要项：最终复核后重算回执、回执字段拆分。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalyzedItem, DataSourceReceipt } from '../src/analyze.ts';
import { analyzeMenu } from '../src/analyze.ts';
import type { NutritionTotals } from '../src/decompose.ts';
import { cents, type Cents } from '../src/money.ts';
import { NutritionMatcher } from '../src/matching.ts';
import type { MealDetail, MenuItem } from '../src/schema.ts';
import { toPriceResult } from '../src/schema.ts';
import type { MealRequest } from '../src/constraints.ts';
import type { Pricer, PriceAttempt } from '../src/pricing.ts';
import { recommendForMenu } from '../src/recommend.ts';

// ─────────────── 造数据 ───────────────

const nt = (value: number | null) => ({ value, complete: true, knownCount: 1, totalCount: 1 });

const totals = (kcal: number, protein: number): NutritionTotals => ({
  energyKcal: nt(kcal),
  protein: nt(protein),
  fat: nt(15),
  carbohydrate: nt(40),
  sodium: nt(600),
});

const item = (code: string, priceYuan: number, protein: number): AnalyzedItem => ({
  code,
  name: code,
  price: cents(Math.round(priceYuan * 100)) as Cents,
  category: '主餐',
  kind: 'single',
  confidence: 'B',
  totals: totals(400, protein),
  evidence: [],
  unmatchedComponents: [],
  notes: [],
});

const req = (preferences: Partial<MealRequest['preferences']> = {}): MealRequest => ({
  budgetCny: 35,
  orderMode: 'pickup',
  storeCode: 'T',
  preferences: { priority: 'balance', ...preferences },
});

const okAttempt = (it: AnalyzedItem, priceYuan: number): PriceAttempt => ({
  quote: toPriceResult({
    price: Math.round(priceYuan * 100),
    productList: [
      {
        productCode: it.code,
        productName: it.name,
        quantity: 1,
        subtotal: Math.round(priceYuan * 100),
      },
    ],
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

/** 复核失败：按给定错误码返回失败收据（TIMEOUT / BAD_RESPONSE …） */
const failAttempt = (code: string): PriceAttempt => ({
  quote: null,
  receipt: {
    tool: 'calculate-price',
    argsSummary: 'items=[A×1]',
    at: new Date().toISOString(),
    ok: false,
    attempt: 1,
    errorCode: code,
    errorMessage: `模拟失败（${code}）`,
    durationMs: 0,
  },
});

// ─────────────── R11 · 首选元数据必须跟着实际方案 ───────────────

describe('R11 · 最终淘汰后首选元数据必须重算', () => {
  test('首选（budget）被复核撤下 → primaryKey 降级为实际第 1 张，且文案不含已失效的偏好标签', async () => {
    const a = item('A', 10, 20);
    const b = item('B', 20, 40);
    let calls = 0;
    const pricer: Pricer = async (it) => {
      calls++;
      // 初次：A=¥10、B=¥20；最终复核：A 涨到 ¥40（超预算被撤）、B 不变
      return okAttempt(it, calls === 1 ? 10 : it.code === 'A' ? 40 : 20);
    };
    const { recommendation } = await recommendForMenu(
      [a, b],
      req({ priority: 'budget' }),
      pricer,
    );

    assert.equal(recommendation.primaryKey, 'protein', '首选应降级到实际第 1 张');
    assert.equal(recommendation.plans[0]!.key, recommendation.primaryKey, '第一张卡必须等于 primaryKey');
    assert.ok(recommendation.primaryNote.includes('降级'), '首选说明必须交代降级');
    assert.ok(
      !recommendation.primaryNote.includes('即按该偏好选出'),
      '不得再声称"按该偏好选出"',
    );
    assert.ok(recommendation.shortfallNote, '撤下方案后必须给出 shortfall 说明');
    assert.ok(
      recommendation.notes.some((n) => n.includes('首选降级')),
      '推导过程须留下降级记录',
    );
  });

  test('非首选被撤下 → primaryKey 保持不变，且仍等于第一张卡', async () => {
    const a = item('A', 10, 20);
    const b = item('B', 20, 40);
    let calls = 0;
    const pricer: Pricer = async (it) => {
      calls++;
      // 复核时把 protein 那张（B）抬到超预算
      return okAttempt(it, calls === 1 ? (it.code === 'A' ? 10 : 20) : it.code === 'B' ? 99 : 10);
    };
    const { recommendation } = await recommendForMenu([a, b], req({ priority: 'budget' }), pricer);
    assert.equal(recommendation.primaryKey, 'budget');
    assert.equal(recommendation.plans[0]!.key, 'budget');
  });

  test('全部方案被撤下 → plans 为空，且不保留任何「首选」字样', async () => {
    const a = item('A', 20, 20);
    const pricer: Pricer = async (it, request) =>
      request?.stage === 'final' ? okAttempt(it, 99) : okAttempt(it, 20);
    const { recommendation } = await recommendForMenu([a], req({ priority: 'budget' }), pricer);
    assert.equal(recommendation.plans.length, 0);
    assert.ok(recommendation.primaryNote.includes('已无可用方案'));
  });
});

// ─────────────── R12 · 复核失败不得渲染成「已核」 ───────────────

describe('R12 · 最终复核失败不得保留 official 来源与「已核」措辞', () => {
  for (const code of ['TIMEOUT', 'BAD_RESPONSE', 'SERVER_ERROR']) {
    test(`复核失败（${code}）→ 来源降级、verified=false、文案不含「已核」`, async () => {
      const pricer: Pricer = async (it, request) =>
        request?.stage === 'final' ? failAttempt(code) : okAttempt(it, 20);
      const { recommendation } = await recommendForMenu([item('A', 20, 20)], req(), pricer);
      const plan = recommendation.plans[0]!;
      assert.notEqual(plan.priced.priceSource, 'official', '不得保留 official');
      assert.equal(plan.priced.verified, false);
      const priceStatement = plan.explanation.statements[1] ?? '';
      assert.ok(!priceStatement.includes('已核'), `失败时不得写「已核」：${priceStatement}`);
      assert.ok(priceStatement.includes('未核实'), '必须明确写「未核实」');
      assert.ok(
        plan.priced.notes.some((n) => n.includes('未核实')),
        '候选备注也须标注未核实',
      );
    });
  }

  test('复核抛错（无错误码）同样降级，不得沿用「已核」', async () => {
    const pricer: Pricer = async (it, request) => {
      if (request?.stage === 'final') throw new Error('网络中断');
      return okAttempt(it, 20);
    };
    const { recommendation } = await recommendForMenu([item('A', 20, 20)], req(), pricer);
    const plan = recommendation.plans[0]!;
    assert.notEqual(plan.priced.priceSource, 'official');
    assert.equal(plan.priced.verified, false);
    assert.ok(!(plan.explanation.statements[1] ?? '').includes('已核'));
  });

  test('复核成功 → 仍正确写「已核」（正向不误伤）', async () => {
    const pricer: Pricer = async (it) => okAttempt(it, 20);
    const { recommendation } = await recommendForMenu([item('A', 20, 20)], req(), pricer);
    const plan = recommendation.plans[0]!;
    assert.equal(plan.priced.priceSource, 'official');
    assert.equal(plan.priced.verified, true);
    assert.ok((plan.explanation.statements[1] ?? '').includes('已核'));
  });
});

// ─────────────── R13 · 详情失败必须留下真实失败收据 ───────────────

describe('R13 · 套餐详情的收据必须来自实际调用点', () => {
  const menuItem: MenuItem = {
    code: 'C',
    name: '测试套餐',
    image: null,
    currentPrice: cents(1000) as Cents,
    originalPrice: null,
    canWithOrder: true,
    discountType: null,
    tags: [],
    category: '套餐',
  };

  const detail = (): MealDetail => ({
    code: 'C',
    name: '测试套餐',
    rounds: [
      {
        id: 1,
        name: '主食',
        quantity: 1,
        minQuantity: 1,
        maxQuantity: 1,
        choices: [
          {
            code: 'c1',
            name: '巨无霸',
            quantity: 1,
            maxQuantity: 1,
            isDefault: true,
            diffPrice: null,
            supportModify: false,
          },
        ],
      },
    ],
  });

  const run = async (loader: (code: string) => Promise<MealDetail | null>, calls: { n: number }) => {
    const r = await analyzeMenu([menuItem], new NutritionMatcher([]), async (code) => {
      calls.n++;
      return loader(code);
    }, { source: { channel: 'live', at: '2026-10-12T00:00:00Z' } });
    const trace: DataSourceReceipt[] = r.items[0]?.sourceTrace ?? [];
    return trace.filter((t) => t.tool === 'query-meal-detail');
  };

  test('成功展开 → 一条 ok=true 的成功收据，且数量与调用次数相符', async () => {
    const calls = { n: 0 };
    const recs = await run(async () => detail(), calls);
    assert.equal(recs.length, 1, '收据数量必须与实际调用次数相符');
    assert.equal(calls.n, 1);
    assert.equal(recs[0]!.ok, true);
    assert.equal(recs[0]!.stage, 'combo-detail');
    assert.ok(recs[0]!.argsSummary.includes('code=C'), '须留下实际餐品 code');
    assert.ok(recs[0]!.requestId, '须有可关联的 requestId');
  });

  test('空详情 → 可区分的失败状态（EMPTY_DETAIL），不是成功', async () => {
    const calls = { n: 0 };
    const recs = await run(async () => null, calls);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.ok, false);
    assert.equal(recs[0]!.errorCode, 'EMPTY_DETAIL');
  });

  test('加载抛错（TIMEOUT）→ 写入失败收据，含错误码与说明', async () => {
    const calls = { n: 0 };
    const recs = await run(async () => {
      throw new Error('TIMEOUT');
    }, calls);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.ok, false);
    assert.equal(recs[0]!.errorCode, 'DETAIL_LOAD_FAILED');
    assert.ok((recs[0]!.errorMessage ?? '').includes('TIMEOUT'));
  });

  test('解析错误（带 code）→ 原样保留错误码，便于定位', async () => {
    const calls = { n: 0 };
    const recs = await run(async () => {
      const e = new Error('返回结构异常') as Error & { code: string };
      e.code = 'BAD_RESPONSE';
      throw e;
    }, calls);
    assert.equal(recs[0]!.errorCode, 'BAD_RESPONSE');
  });

  test('离线来源的成功展开也不得记成 ok=true（不得伪装成真实调用）', async () => {
    const r = await analyzeMenu([menuItem], new NutritionMatcher([]), async () => detail(), {
      source: { channel: 'offline', at: '2026-10-12T00:00:00Z', snapshotId: 'baseline-test' },
    });
    const rec = (r.items[0]?.sourceTrace ?? []).find((t) => t.tool === 'query-meal-detail')!;
    assert.equal(rec.ok, false);
    assert.equal(rec.channel, 'offline');
    assert.equal(rec.errorCode, 'OFFLINE_FIXTURE');
    assert.equal(rec.snapshotId, 'baseline-test');
  });
});

// ─────────────── 次要项 · 回执重算与字段拆分 ───────────────

describe('复审次要项 · 回执重算与字段拆分', () => {
  test('最终复核的请求计入回执（不再低报）', async () => {
    const pricer: Pricer = async (it) => okAttempt(it, 20);
    const { recommendation } = await recommendForMenu([item('A', 20, 20)], req(), pricer);
    const note = recommendation.notes.find((n) => n.includes('本次共发起'));
    assert.ok(note, '必须给出请求统计');
    // 初次 1 次 + 最终复核 1 次
    assert.match(note!, /本次共发起 2 次/, `最终复核应计入：${note}`);
    assert.match(note!, /成功 2/);
  });

  test('离线未发起 ≠ 失败：拆成独立字段', async () => {
    const offlinePricer: Pricer = async (it, request) => ({
      quote: null,
      receipt: {
        tool: 'calculate-price',
        argsSummary: `items=[${it.code}×1]`,
        at: new Date().toISOString(),
        ok: false,
        attempt: 0,
        errorCode: 'OFFLINE',
        durationMs: 0,
        channel: 'offline',
        stage: request?.stage ?? 'initial',
      },
    });
    const { pricing } = await recommendForMenu(
      [item('A', 20, 25), item('B', 10, 25)],
      req(),
      offlinePricer,
    );
    assert.equal(pricing.summary.liveAttempts, 0);
    assert.equal(pricing.summary.attemptedFailures, 0, '未发起不得计入失败');
    assert.ok(pricing.summary.offlineNotInitiated >= 2);
    assert.match(pricing.summary.note, /未发起不等于失败/);
  });
});
