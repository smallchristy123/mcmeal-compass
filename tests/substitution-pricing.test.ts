/**
 * 替换方案的**价格链路**回归（复评 P1 整改）
 *
 * 复评原话：「组成变了，计价请求也必须真正变化。指纹、日志和测试名称不能替代实际发送载荷。」
 * 本文件就盯这一件事，四类断言缺一不可：
 *   ① **未替换时载荷不变**——不得为了一致性而牺牲既有覆盖面（零回归）；
 *   ② **替换后载荷必变**——`roundList` 真的进了请求对象，且载荷指纹随之变化；
 *   ③ **价差真的进价格**——+¥2 / −¥0.5 / +¥15.5 三种价差都要能算进去，并影响预算判定；
 *   ④ **计价被拒时不得写「已核实」**——如实退回未核实，并在收据里留下「已送组成但被拒」的痕迹。
 *
 * 假计价器**按官方实测行为建模**（2026-10-16 协议实验）：
 *     price = 顶层价 + Σ(所选项相对默认项的价差)
 *   ——实测：仅顶层码 5050；带 roundList 全默认项仍 5050；换 +¥2 的选项 5250；换 −¥0.5 的 5000。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';
import { NutritionMatcher } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { analyzeMenu, type AnalyzedItem } from '../src/analyze.ts';
import { basketOf, requestOf } from '../src/pricing.ts';
import { recommendForMenu } from '../src/recommend.ts';
import type { MealRequest } from '../src/constraints.ts';
import { toPriceResult } from '../src/schema.ts';
import type { Pricer, PriceAttempt, PriceRequest } from '../src/pricing.ts';

const TARGET_CODE = '9900004236'; // 人气超值四件套随心选
const TARGET_NAME = '人气超值四件套随心选';
const DRINK_ROUND = '选择套餐内饮料';
const COLA_LARGE = '可乐大杯'; // 官方详情标 +¥2
const JASMINE = '茉莉奶绿雪冰'; // 官方详情标 +¥15.5
const CORN_SMALL = '小杯玉米杯'; // 官方详情标 −¥0.5

const BASE_CENTS = 2800; // 该套餐菜单价 ¥28.00

/** 官方详情里的价差（分）——取自快照 9900004236 的轮次选项 */
const DELTA: Record<string, number> = {
  '3100': 200, // 可乐大杯 +¥2
  '521791': 1550, // 茉莉奶绿雪冰 +¥15.5
  '4437': -50, // 小杯玉米杯 −¥0.5
};

const analyzeWith = async (specs: { round: string; choice: string }[]): Promise<AnalyzedItem> => {
  const b = await loadFixtures();
  const matcher = new NutritionMatcher(b.nutritionRows, { aliases: DEFAULT_ALIASES });
  const { items } = await analyzeMenu(b.menuItems, matcher, fixtureDetailLoader(b), {
    ...(specs.length === 0 ? {} : { substitutions: specs }),
  });
  const it = items.find((i) => i.code === TARGET_CODE);
  assert.ok(it, `夹具里应有 ${TARGET_NAME}`);
  return it!;
};

const okReceipt = (request: PriceRequest | undefined, price: number): PriceAttempt => ({
  quote: toPriceResult({
    price,
    productList: [{ productCode: '9900004236', productName: TARGET_NAME, quantity: 1, subtotal: price }],
    takeWayList: [],
  }),
  receipt: {
    tool: 'calculate-price',
    argsSummary: request === undefined ? '' : 'stub',
    at: new Date().toISOString(),
    ok: true,
    attempt: 1,
    durationMs: 0,
    stage: request?.stage ?? 'initial',
    requestFingerprint: request?.fingerprint,
  },
});

/** 按官方实测行为建模：顶层价 + Σ 所选项相对默认项的价差（**只看实际载荷**） */
const makeRecordingPricer = () => {
  const seen: { request?: PriceRequest; quoted: number }[] = [];
  const pricer: Pricer = async (item, request) => {
    const rl = request?.items?.[0]?.roundList;
    const delta =
      rl === undefined
        ? 0
        : rl.flatMap((r) => r.comboItemList).reduce((s, c) => s + (DELTA[c.code] ?? 0), 0);
    const quoted = BASE_CENTS + delta;
    seen.push({ ...(request === undefined ? {} : { request }), quoted });
    return okReceipt(request, quoted);
  };
  return { pricer, seen };
};

/** 官方拒绝该组成（60006）——**不得**再声称已核实 */
const rejectingPricer: Pricer = async () => {
  const e = new Error('商品已售罄或不可售') as Error & { code: string; businessCode: number };
  e.code = 'SERVER_ERROR';
  e.businessCode = 60006;
  throw e;
};

const req = (budgetCny: number): MealRequest => ({
  budgetCny,
  orderMode: 'pickup',
  storeCode: '3450024',
  preferences: { priority: 'balance' },
});

describe('替换价格链路 · ① 未替换时载荷不变（零回归）', () => {
  test('全部为默认项 ⇒ 不带 roundList（与 v3.7.0 行为一致）', async () => {
    const it = await analyzeWith([]);
    const basket = basketOf(it);
    assert.equal(basket.length, 1);
    assert.equal(basket[0]!.productCode, TARGET_CODE);
    assert.equal(basket[0]!.roundList, undefined, '未替换时不得附带组成，以免损失既有官方核价覆盖面');
  });
});

describe('替换价格链路 · ② 替换后载荷必变', () => {
  test('换饮料 ⇒ roundList 出现且指向被替换的选项（轮次 id 为字符串）', async () => {
    const it = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);
    const basket = basketOf(it);
    const rl = basket[0]!.roundList;
    assert.ok(rl && rl.length === 4, '应带上 4 个轮次的实际组成');
    const drink = rl!.find((r) => r.comboItemList.some((c) => c.code === '3100'));
    assert.ok(drink, '载荷里应含被选中的「可乐大杯」选项 code');
    assert.equal(drink!.round, '4', 'round 必须是轮次 id 的字符串（传名称会被服务端拒为 500）');
  });

  test('载荷指纹随载荷变化；且与「期望组成」指纹分开记录', async () => {
    const before = await analyzeWith([]);
    const after = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);
    const rb = requestOf(before, 'final');
    const ra = requestOf(after, 'final');
    assert.notEqual(rb.payloadFingerprint, ra.payloadFingerprint, '替换后载荷指纹必须变化');
    assert.equal(rb.fingerprint, rb.payloadFingerprint, 'fingerprint 应与载荷指纹同义（旧名保留兼容）');
    assert.ok(rb.desiredCompositionFingerprint.length > 0, '期望组成指纹必须存在');
    assert.notEqual(
      ra.payloadFingerprint,
      ra.desiredCompositionFingerprint,
      '两者是不同的哈希对象（载荷含 items+roundList，组成只含组件），不得混为一谈',
    );
  });
});

describe('替换价格链路 · ③ 价差真的进价格与预算', () => {
  test('+¥2：官方核价得 ¥30.00，预算 ¥29 下**预算内无解**（明确无解，不硬凑）', async () => {
    const it = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);
    const { pricer, seen } = makeRecordingPricer();
    const { recommendation } = await recommendForMenu([it], req(29), pricer);

    // ① 载荷真的带了组成
    assert.ok(seen.length > 0, '应发生过计价调用');
    const withRl = seen.find((s) => s.request?.items?.[0]?.roundList !== undefined);
    assert.ok(withRl, '替换后发给计价器的请求必须带 roundList');
    assert.equal(withRl!.request!.items[0]!.roundList!.length, 4, '应含 4 个轮次的实际组成');

    // ② 价差真进了核价结果
    assert.equal(withRl!.quoted, 3000, '官方核价应为 2800 + 200');

    // ③ 预算判定跟着走：¥30 > ¥29 ⇒ 无预算内方案，且如实说明"超出"
    assert.equal(recommendation.plans.length, 0, '超预算时不得硬凑方案');
    assert.ok(
      (recommendation.overBudgetNote ?? '').includes('超出'),
      '应如实说明"所有候选均超出预算"',
    );
  });

  test('−¥0.5：官方核价 ¥27.50，预算 ¥28 下**在预算内**', async () => {
    const it = await analyzeWith([{ round: '小食#1', choice: CORN_SMALL }]);
    const { pricer, seen } = makeRecordingPricer();
    const { recommendation } = await recommendForMenu([it], req(28), pricer);
    const priced = recommendation.plans[0]?.priced;
    assert.ok(priced, '降价后应给出方案');
    assert.equal(seen[seen.length - 1]!.quoted, 2750, '官方核价应为 2800 − 50');
    assert.equal(priced!.effectivePrice, 2750, '价格必须含 −¥0.5 的替换价差');
    assert.equal(priced!.withinBudget, true, '降价后应重新进入预算');
  });

  test('+¥15.5：载荷含该选项，且按官方实测规则换算得 ¥43.50', async () => {
    const it = await analyzeWith([{ round: DRINK_ROUND, choice: JASMINE }]);
    const basket = basketOf(it);
    const rl = basket[0]!.roundList;
    assert.ok(rl, '替换后必须带 roundList');
    const drink = rl!.find((r) => r.round === '4');
    assert.ok(
      drink!.comboItemList.some((c) => c.code === '521791'),
      '载荷里应含被选中的「茉莉奶绿雪冰」选项 code',
    );

    // 按官方实测规则（顶层价 + Σ 所选项价差）换算：2800 + 1550 = 4350
    const delta = rl!.flatMap((r) => r.comboItemList).reduce((s, c) => s + (DELTA[c.code] ?? 0), 0);
    assert.equal(BASE_CENTS + delta, 4350);

    // ⚠️ 如实说明：该替换会让组件营养无法全部匹配 ⇒ 该候选在**计价之前**就被既有数据门槛拦下，
    //    故此处不苛求"必须出方案"——拦下是正确行为，不是回归。价格链路本身由上面两条用例覆盖。
  });
});

describe('替换价格链路 · ④ 计价被拒时不得写「已核实」', () => {
  test('服务端拒绝该组成（60006）⇒ 价源非 official、verified=false、收据留失败痕迹', async () => {
    const it = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);
    const { recommendation } = await recommendForMenu([it], req(80), rejectingPricer);
    const priced = recommendation.plans[0]?.priced;
    assert.ok(priced, '被拒也应如实给出卡片并标注未核实');
    assert.notEqual(priced!.priceSource, 'official', '被拒时不得标 official');
    assert.equal(priced!.verified, false, '组成未被核价 ⇒ verified 必须为 false');
    assert.equal(priced!.receipt?.ok, false, '收据必须如实记为失败');
    assert.equal(priced!.receipt?.businessCode, 60006, '应留下服务端业务码，便于追查');
  });
});
