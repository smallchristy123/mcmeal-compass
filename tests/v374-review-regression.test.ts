/**
 * v3.7.4 复评 O10 定向回归（2026-10-17）
 *
 * 复评原话（`mcmeal-compass-v3.7.3-review-2026-10-16.md` 第五节）：
 * > `roundListOf` 只有发现 `isDefault === false` 才认为组成发生变化；
 * > `adjustedMenuPriceOf` 只跳过 `isDefault === true`，因此 `false` 和 `undefined` 都会被当作替换。
 * > 也就是说，官方请求认为组成未变，降级价格却认为组成变了。
 *
 * 病根不是「哪边判据更好」，而是**同一字段被两处各自解释**。
 * 本文件把「唯一判据 + 三态语义」钉住：
 *   · `true`      ⇒ `default`；
 *   · `false`     ⇒ `swapped`（**±¥0 也是替换**）；
 *   · `undefined` ⇒ `unknown`（**既不送组成，也拒绝推算**——对同一「未知」保持沉默，不留两套事实）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';
import { NutritionMatcher } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { analyzeMenu, type AnalyzedItem } from '../src/analyze.ts';
import {
  adjustedMenuPriceFailureOf,
  adjustedMenuPriceOf,
  confirmPrices,
  defaultStateOf,
  requestOf,
  roundListOf,
  type Pricer,
} from '../src/pricing.ts';
import { cents, type Cents } from '../src/money.ts';
import { toPriceResult } from '../src/schema.ts';

const TARGET_CODE = '9900004236'; // 人气超值四件套随心选（菜单价 ¥28.00）
const TARGET_NAME = '人气超值四件套随心选';
const DRINK_ROUND = '选择套餐内饮料';
const COLA_LARGE = '可乐大杯'; // 官方详情标 +¥2（明确非默认）
const SNACK_ROUND = '小食#1';
const CORN_SMALL = '小杯玉米杯'; // 官方详情标 ±¥0（明确非默认）
const BASE_CENTS = 2800;

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

/**
 * 把某个组件的 `isDefault` 抹成 `undefined`——模拟「库直接调用方」的输入。
 *
 * 为什么要造这种输入：`ItemComponent.isDefault` 在公开类型里是**可选字段**，
 * 而 `roundListOf` / `adjustedMenuPriceOf` 都是**导出契约**，
 * 核心层不得假定调用方永远给全三态之一。
 */
const withUnknownDefault = (it: AnalyzedItem): AnalyzedItem => {
  const comps = it.components ?? [];
  assert.ok(comps.length > 0, '前提：该候选必须带结构化组件');
  return {
    ...it,
    components: comps.map((c, i) => (i === 0 ? { ...c, isDefault: undefined } : c)),
  };
};

/** 全部设为明确默认（`true`）——用于「不得矫枉过正」的对照 */
const allExplicitDefault = (it: AnalyzedItem): AnalyzedItem => ({
  ...it,
  components: (it.components ?? []).map((c) => ({ ...c, isDefault: true })),
});

/** 全部抹成 `undefined`——「整份组成默认态都未知」（无任何明确 swapped） */
const allUnknownDefault = (it: AnalyzedItem): AnalyzedItem => {
  const comps = it.components ?? [];
  assert.ok(comps.length > 0, '前提：该候选必须带结构化组件');
  return { ...it, components: comps.map((c) => ({ ...c, isDefault: undefined })) };
};

const timeoutPricer: Pricer = async () => {
  const e = new Error('请求超时') as Error & { code: string };
  e.code = 'TIMEOUT';
  throw e;
};

/** 一个「官方成功」的计价器——用来证明 unknown 不会被一刀切拒掉官方价 */
const okPricer =
  (price: Cents): Pricer =>
  async (item, request) => {
    const req = request ?? requestOf(item, 'initial');
    return {
      quote: toPriceResult({
        price,
        productList: req.items.map((l) => ({
          productCode: l.productCode,
          productName: TARGET_NAME,
          quantity: l.quantity,
          subtotal: price,
        })),
        takeWayList: [],
      }),
      receipt: {
        tool: 'calculate-price',
        argsSummary: 'stub',
        at: new Date().toISOString(),
        ok: true,
        attempt: 1,
        retries: 0,
        durationMs: 0,
        channel: 'live',
        stage: 'initial',
      },
    };
  };

describe('v3.7.4 · O10 `isDefault` 唯一判据（三态）', () => {
  test('三态映射：true⇒default / false⇒swapped / undefined⇒unknown', () => {
    assert.equal(defaultStateOf({ isDefault: true } as never), 'default');
    assert.equal(defaultStateOf({ isDefault: false } as never), 'swapped');
    assert.equal(defaultStateOf({} as never), 'unknown', '缺字段 ⇒ 未知（不得默认成任一侧）');
    assert.equal(defaultStateOf({ isDefault: undefined } as never), 'unknown');
  });

  test('undefined ⇒ 两处**互不矛盾**：不送组成、也拒绝推算（不留两套事实）', async () => {
    const it = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);
    const unknown = allUnknownDefault(it);

    // 请求侧：不给结论 ⇒ 不送组成
    assert.deepEqual(roundListOf(unknown), [], '`unknown` 不构成「明确替换」⇒ 不得凭空送组成');
    // 价格侧：拒绝推算（而不是"当作替换去算钱"）
    assert.equal(adjustedMenuPriceOf(unknown), null, '`unknown` ⇒ 价格未知，不得按替换推算');
    assert.match(
      adjustedMenuPriceFailureOf(unknown) ?? '',
      /默认态未知/,
      '失败原因须点名「默认态未知」，不得混写成「价差不全」',
    );

    // 同一输入、同一「未知」，两侧都不给结论——这才是「一个事实、一个判据」
    assert.equal(
      roundListOf(unknown).length === 0 && adjustedMenuPriceOf(unknown) === null,
      true,
    );
  });

  test('undefined ⇒ 该候选进入 `unknown-price`，且**不被菜单价混过预算**', async () => {
    const it = await analyzeWith([]); // 无替换：正常应为 ¥28 菜单价
    const unknown = allUnknownDefault(it);
    const outcome = await confirmPrices([unknown], cents(8000), timeoutPricer);

    assert.equal(outcome.within.length, 0, '价格未知者不得进入预算内池');
    assert.equal(outcome.nearestOver, null, '也不得充当「最接近预算」的备选');
    const ex = outcome.excluded.find((e) => e.code === TARGET_CODE);
    assert.ok(ex, '必须如实单列');
    assert.equal(ex!.kind, 'unknown-price');
    assert.match(ex!.detail, /默认态未知/, '单列说明须留下真实原因');
  });

  test('对照（不得矫枉过正）：全部明确默认 ⇒ 不送组成、按菜单价、compositionChanged=false', async () => {
    const it = await analyzeWith([]);
    const def = allExplicitDefault(it);
    assert.deepEqual(roundListOf(def), [], '全部明确默认 ⇒ 不送组成（覆盖面零回归）');
    const adj = adjustedMenuPriceOf(def);
    assert.ok(adj);
    assert.equal(adj!.cents, BASE_CENTS);
    assert.equal(adj!.compositionChanged, false);
    assert.equal(adj!.basis, '菜单价（组成与默认一致）');
  });

  test('对照：明确替换（±¥0）⇒ 送组成、compositionChanged=true', async () => {
    const it = await analyzeWith([{ round: SNACK_ROUND, choice: CORN_SMALL }]);
    assert.ok(roundListOf(it).length > 0, '明确替换 ⇒ 请求须带组成');
    const adj = adjustedMenuPriceOf(it);
    assert.ok(adj);
    assert.equal(adj!.compositionChanged, true);
    assert.ok(adj!.basis.includes('±¥0.00'));
  });

  test('混态（1 个明确替换 + 1 个未知）⇒ 组成照送，但价格仍拒算（未知优先）', async () => {
    const it = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);
    const mixed = withUnknownDefault(it);
    // 前提：改后仍存在明确替换项（其余组件保持官方布尔）
    assert.ok(roundListOf(mixed).length > 0, '只要存在明确 `swapped`，组成就该送——未知者不否决请求');
    assert.equal(adjustedMenuPriceOf(mixed), null, '但价格里含未知项 ⇒ 整份拒算，不拿部分已知充全量');
  });

  test('unknown 不得连累官方价：官方成功时照常采纳（修复不得过度）', async () => {
    const it = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);
    const unknown = withUnknownDefault(it);
    const outcome = await confirmPrices([unknown], cents(8000), okPricer(cents(3000)));
    const p = outcome.within[0];
    assert.ok(p, '官方价与「能否推算」无关 ⇒ 该进预算池');
    assert.equal(p!.effectivePrice, 3000);
    assert.equal(p!.priceSource, 'official', '官方价照常采纳，不因默认态未知而降级');
    assert.equal(p!.verified, true);
  });
});
