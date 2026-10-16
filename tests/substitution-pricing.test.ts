/**
 * 替换方案的**价格链路**回归（复评 P1 整改）
 *
 * 复评原话：「组成变了，计价请求也必须真正变化。指纹、日志和测试名称不能替代实际发送载荷。」
 * 本文件就盯这一件事，四类断言缺一不可：
 *   ① **未替换时载荷不变**——不得为了一致性而牺牲既有覆盖面（零回归）；
 *   ② **替换后载荷必变**——`roundList` 真的进了请求对象，且载荷指纹随之变化；
 *   ③ **价差真的进价格**——+¥2 / −¥0.5 / +¥15.5 三种价差都要能算进去，并影响预算判定；
 *   ④ **计价被拒时不得写「已核实」，且不得用未调整的菜单价过硬预算**——
 *      官方判定不可售（60006）⇒ 移出可行集；可售性未知（超时/限流/对象不匹配）⇒ 用
 *      「菜单价 ＋ 已知价差」的推算价比较；价差不全 ⇒ 价格未知，不进预算内（v3.7.1 复评 P1）。
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
import { adjustedMenuPriceOf, basketOf, requestOf } from '../src/pricing.ts';
import { recommendForMenu } from '../src/recommend.ts';
import type { MealRequest } from '../src/constraints.ts';
import { toPriceResult } from '../src/schema.ts';
import type { Pricer, PriceAttempt, PriceRequest } from '../src/pricing.ts';

const TARGET_CODE = '9900004236'; // 人气超值四件套随心选
const TARGET_NAME = '人气超值四件套随心选';
const DRINK_ROUND = '选择套餐内饮料';
const COLA_LARGE = '可乐大杯'; // 官方详情标 +¥2
const JASMINE = '茉莉奶绿雪冰'; // 官方详情标 +¥15.5
const CORN_SMALL = '小杯玉米杯';

const BASE_CENTS = 2800; // 该套餐菜单价 ¥28.00

/**
 * ⚠️ 真实快照口径（2026-10-16 复核，修正 v3.7.1 的一处**取数错误**）：
 *   `9900004236` 的「小食#1」轮次里，**小杯玉米杯（4437）官方标 ±¥0**——
 *   它在本套餐**不产生价差**；−¥0.5 存在于**别的**套餐（如 `9900005462` 板烧鸡腿堡三件套，
 *   轮次「选择套餐内小食」）。v3.7.1 的测试把 4437 当作 −50 写进了建模，属错误假设，
 *   已在 `docs/DECISION_NOTES.md` 如实记账。故负价差用例现改在 `9900005462` 上做。
 */
const NEG_CODE = '9900005462'; // 板烧鸡腿堡三件套（¥38.50）
const NEG_NAME = '板烧鸡腿堡三件套';
const NEG_SNACK_ROUND = '选择套餐内小食';
const NEG_BASE_CENTS = 3850;

/** 官方详情里的价差（分）——取自快照 9900004236 的轮次选项 */
const DELTA: Record<string, number> = {
  '3100': 200, // 可乐大杯 +¥2
  '521791': 1550, // 茉莉奶绿雪冰 +¥15.5
  '4437': 0, // 小杯玉米杯：在 9900004236 里官方标 ±¥0（不是 −50）
};

const analyzeWith = async (
  specs: { round: string; choice: string }[],
  code = TARGET_CODE,
): Promise<AnalyzedItem> => {
  const b = await loadFixtures();
  const matcher = new NutritionMatcher(b.nutritionRows, { aliases: DEFAULT_ALIASES });
  const { items } = await analyzeMenu(b.menuItems, matcher, fixtureDetailLoader(b), {
    ...(specs.length === 0 ? {} : { substitutions: specs }),
  });
  const it = items.find((i) => i.code === code);
  assert.ok(it, `夹具里应有 ${code}`);
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

/** 官方拒绝该组成（60006）——**不得**再声称已核实，且须移出可行集 */
const rejectingPricer: Pricer = async () => {
  const e = new Error('商品已售罄或不可售') as Error & { code: string; businessCode: number };
  e.code = 'SERVER_ERROR';
  e.businessCode = 60006;
  throw e;
};

/** 造一个「带指定错误码」的计价器（超时/限流等可售性未知的失败） */
const failWith = (code: string, message: string): Pricer => async () => {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  throw e;
};

const timeoutPricer = failWith('TIMEOUT', '官方计价请求超时');
const rateLimitedPricer = failWith('RATE_LIMITED', '触发官方限流（HTTP 429）');

/** 有价格但**报价对象核对不上**（明细里的商品与请求不符）——金额一律不得采纳 */
const mismatchedBasketPricer: Pricer = async (_item, request) => ({
  quote: toPriceResult({
    price: 3000,
    productList: [{ productCode: '9900099999', productName: '别的商品', quantity: 1, subtotal: 3000 }],
    takeWayList: [],
  }),
  receipt: {
    tool: 'calculate-price',
    argsSummary: 'stub',
    at: new Date().toISOString(),
    ok: true,
    attempt: 1,
    durationMs: 0,
    stage: request?.stage ?? 'initial',
    requestFingerprint: request?.fingerprint,
  },
});

/** 初次核价成功（按官方实测规则），**最终复核一律超时**——用于验证降级后仍重算 */
const initialOnlyPricer: Pricer = async (_item, request) => {
  if (request?.stage === 'final') {
    const e = new Error('最终复核请求超时') as Error & { code: string };
    e.code = 'TIMEOUT';
    throw e;
  }
  const rl = request?.items?.[0]?.roundList;
  const delta =
    rl === undefined
      ? 0
      : rl.flatMap((r) => r.comboItemList).reduce((s, c) => s + (DELTA[c.code] ?? 0), 0);
  return okReceipt(request, BASE_CENTS + delta);
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

  test('官方标 ±¥0 的选项 ⇒ **不得凭空加减**（9900004236 的「小杯玉米杯」实为 ±¥0）', async () => {
    const it = await analyzeWith([{ round: '小食#1', choice: CORN_SMALL }]);
    const adj = adjustedMenuPriceOf(it);
    assert.ok(adj, '价差已取得（为 0）⇒ 应能推算');
    assert.equal(adj!.adjustment, 0, '该选项在本套餐官方标 ±¥0 ⇒ 调整额必须为 0');
    assert.equal(adj!.cents, BASE_CENTS, '调整后菜单价仍为 ¥28.00');
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

describe('替换价格链路 · ④ 计价失败后的预算与可售性（v3.7.1 复评 P1）', () => {
  test('服务端判定不可售（60006）⇒ 移出可行集：不作方案、也不作备选', async () => {
    const it = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);
    const { recommendation, pricing } = await recommendForMenu([it], req(80), rejectingPricer);

    // 预算 ¥80 ≫ 菜单价 ¥28：**不是因为超预算才没方案**，而是因为「买不到」
    assert.equal(recommendation.plans.length, 0, '官方判定不可售者不得保留为可购买方案');
    assert.equal(pricing.within.length, 0, '不得进入预算内池');
    assert.equal(pricing.nearestOver, null, '也不得充当「最接近预算」的备选');
    assert.equal(recommendation.overBudgetNote, null, '更不得说成"所有候选均超出预算"——那不是超预算');
    const ex = recommendation.excluded.find((e) => e.name === TARGET_NAME);
    assert.ok(ex, '必须如实单列被移出的候选');
    assert.equal(ex!.kind, 'unavailable');
    assert.ok(ex!.detail.includes('60006'), '单列说明里应留下业务码，便于追查');
  });
});

describe('替换价格链路 · ⑤ 官方失败时的降级口径（复评 P1 必测项）', () => {
  test('+¥2、菜单 ¥28、预算 ¥29、官方超时 ⇒ 用调整后菜单价 ¥30.00，**不得进入预算内**', async () => {
    const it = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);
    const { recommendation, pricing } = await recommendForMenu([it], req(29), timeoutPricer);

    assert.equal(recommendation.plans.length, 0, '已知价差已使金额超预算 ⇒ 不得当预算内方案');
    assert.equal(pricing.within.length, 0);
    // 关键反例：绝不能再拿未调整的 ¥28.00（2800）去过 ¥29.00 的闸门
    const alt = pricing.nearestOver;
    assert.ok(alt, '应给出「最接近预算」的备选（金额为推算值）');
    assert.equal(alt!.effectivePrice, 3000, '金额必须是 2800 + 200，而不是 2800');
    assert.equal(alt!.priceSource, 'menu-adjusted-unverified');
    assert.equal(alt!.verified, false, '推算值不得标为已核实');
    assert.ok(
      (alt!.priceBasis ?? '').includes('可乐大杯'),
      '必须写明金额依据（菜单价 ＋ 哪一笔价差）',
    );
  });

  test('−¥0.5、菜单 ¥38.50、预算 ¥38、官方超时且价差完整 ⇒ 可按 ¥38.00 的推算价比较', async () => {
    // 用**真实存在负价差**的套餐（9900005462 板烧鸡腿堡三件套，小食轮次官方标 −¥0.5）
    const it = await analyzeWith([{ round: NEG_SNACK_ROUND, choice: CORN_SMALL }], NEG_CODE);
    const { recommendation } = await recommendForMenu([it], req(38), timeoutPricer);
    const priced = recommendation.plans[0]?.priced;
    assert.ok(priced, '价差完整时允许按推算价出方案（并如实标注）');
    assert.equal(priced!.effectivePrice, 3800, '金额应为 3850 − 50');
    assert.equal(priced!.priceSource, 'menu-adjusted-unverified');
    assert.equal(priced!.withinBudget, true, '降价后落在预算内');
    assert.equal(priced!.verified, false, '推算价不得标为已核实');
  });

  test('多轮替换：正负价差一起求和（+¥2 与 −¥0.5 ⇒ ¥40.00）', async () => {
    const it = await analyzeWith(
      [
        { round: DRINK_ROUND, choice: COLA_LARGE },
        { round: NEG_SNACK_ROUND, choice: CORN_SMALL },
      ],
      NEG_CODE,
    );
    const adj = adjustedMenuPriceOf(it);
    assert.ok(adj, '两处价差都已取得 ⇒ 应能推算');
    assert.equal(adj!.cents, 4000, '应为 3850 + 200 − 50');
    assert.equal(adj!.adjustment, 150, '价差合计应为 +150');

    const { recommendation } = await recommendForMenu([it], req(40), timeoutPricer);
    const priced = recommendation.plans[0]?.priced;
    assert.ok(priced, '¥40.00 ≤ ¥40.00 ⇒ 应在预算内');
    assert.equal(priced!.effectivePrice, 4000);
    assert.equal(priced!.withinBudget, true);
  });

  test('任一价差未知 ⇒ **不得**以原菜单价通过硬预算，且单列为「价格未知」', async () => {
    const base = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);
    // 把非默认组件的价差抹掉，模拟"官方详情缺该选项价差"
    const it: AnalyzedItem = {
      ...base,
      components: (base.components ?? []).map((c) =>
        c.isDefault === true ? c : { ...c, diffPrice: null },
      ),
    };
    assert.equal(adjustedMenuPriceOf(it), null, '价差不全时**不得**给出推算金额');

    const { recommendation, pricing } = await recommendForMenu([it], req(29), timeoutPricer);
    assert.equal(recommendation.plans.length, 0, '价格未知者不得进入方案');
    assert.equal(pricing.within.length, 0, '更不得以 ¥28.00 冒充"预算内"');
    assert.equal(pricing.nearestOver, null, '价格未知者也不作备选');
    const ex = recommendation.excluded.find((e) => e.name === TARGET_NAME);
    assert.ok(ex, '必须如实单列');
    assert.equal(ex!.kind, 'unknown-price');
  });

  test('初次官方成功、最终复核超时 ⇒ 降级为「未核实」，并**按降级后的金额**重算预算', async () => {
    const it = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);

    // A) 预算 ¥31：方案仍在，但来源已降级、金额仍为含价差的 ¥30.00（不是未调整的 ¥28.00）
    const a = await recommendForMenu([it], req(31), initialOnlyPricer);
    const priced = a.recommendation.plans[0]?.priced;
    assert.ok(priced, '降级后 ¥30.00 ≤ ¥31.00 ⇒ 应保留方案');
    assert.equal(priced!.priceSource, 'official-unverified', '最终复核未成功 ⇒ 不得标 official');
    assert.equal(priced!.verified, false);
    assert.equal(priced!.effectivePrice, 3000, '金额必须是含 +¥2 的 ¥30.00');
    assert.equal(priced!.withinBudget, true, '¥30.00 ≤ ¥31.00 ⇒ 在预算内');

    // B) 预算 ¥29：闸门用的是 ¥30.00 ⇒ 本轮**没有**预算内方案（不得退回 ¥28.00 充数）
    const b = await recommendForMenu([it], req(29), initialOnlyPricer);
    assert.equal(b.pricing.within.length, 0, '¥30.00 超 ¥29.00 ⇒ 不得进入预算内池');
    assert.equal(b.recommendation.plans.length, 0, '不得以旧价或菜单价硬凑方案');
  });

  test('RATE_LIMITED / TIMEOUT / 对象不匹配 / 60006 四类失败一律遵守同一闸门口径', async () => {
    const cases: { label: string; pricer: Pricer; expectExcluded?: 'unavailable' | 'unknown-price' }[] = [
      { label: 'RATE_LIMITED', pricer: rateLimitedPricer },
      { label: 'TIMEOUT', pricer: timeoutPricer },
      { label: '对象不匹配', pricer: mismatchedBasketPricer },
      { label: '60006 不可售', pricer: rejectingPricer, expectExcluded: 'unavailable' },
    ];
    for (const c of cases) {
      const it = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);
      const { recommendation, pricing } = await recommendForMenu([it], req(29), c.pricer);

      // 共性一：没有任何方案可以「verified」
      for (const p of recommendation.plans) {
        assert.equal(p.priced.verified, false, `${c.label}：不得出现已核实方案`);
        assert.notEqual(p.priced.priceSource, 'official', `${c.label}：不得标 official`);
      }
      // 共性二：¥28 的菜单价**绝不能**被当作 ≤ ¥29 而通过闸门
      assert.equal(pricing.within.length, 0, `${c.label}：¥28 未调整菜单价不得通过硬预算`);
      // 共性三：如实分流
      const ex = recommendation.excluded.find((e) => e.name === TARGET_NAME);
      if (c.expectExcluded) {
        assert.ok(ex, `${c.label}：应如实单列被移出的候选`);
        assert.equal(ex!.kind, c.expectExcluded);
      } else {
        // 超时/限流/对象不匹配三类的金额若给出，必须是含价差的推算价
        const alt = pricing.nearestOver;
        assert.ok(alt, `${c.label}：应给出备选`);
        assert.equal(alt!.effectivePrice, 3000, `${c.label}：金额必须含 +¥2 价差`);
      }
    }
  });
});
