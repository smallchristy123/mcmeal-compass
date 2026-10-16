/**
 * v3.7.3 复评 P2 定向回归（2026-10-16）
 *
 * 复评给的两句总原则，本文件把它们**机械地钉住**：
 *   ① **状态真值优先于载荷中碰巧存在的字段** —— 失败回执就是失败，
 *      即便同一对象里残留了一份报价（甚至报价对象还核对得上）；
 *   ② **组成真值独立于价差数值** —— 非默认的 ±¥0 替换**同样是替换**。
 *
 * 反例来源：`mcmeal-compass-v3.7.2-review-2026-10-16.md`（P2-1 / P2-2），
 * 及复评随附的 `review-v3.7.2-edge-probes.json`。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';
import { NutritionMatcher } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { analyzeMenu, type AnalyzedItem } from '../src/analyze.ts';
import {
  adjustedMenuPriceOf,
  confirmPrices,
  normalizePriceAttempt,
  requestOf,
  verifyQuoteBasket,
  type Pricer,
} from '../src/pricing.ts';
import { cents } from '../src/money.ts';
import { toPriceResult } from '../src/schema.ts';

const TARGET_CODE = '9900004236'; // 人气超值四件套随心选（菜单价 ¥28.00）
const TARGET_NAME = '人气超值四件套随心选';
const DRINK_ROUND = '选择套餐内饮料';
const COLA_LARGE = '可乐大杯'; // 官方详情标 +¥2
const CORN_SMALL = '小杯玉米杯'; // 官方详情标 ±¥0（**非默认**）
const SNACK_ROUND = '小食#1';
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

/** 造一个「可售性未知」的失败计价器（超时 / 限流 / 网络） */
const failWith = (code: string, message: string): Pricer => async () => {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  throw e;
};

const timeoutPricer = failWith('TIMEOUT', '请求超时');

/** 残留报价的构造方式 */
type Residual = 'absent' | 'matched' | 'mismatch';

interface ContradictionCase {
  /** 失败码（收据的 errorCode） */
  code: string;
  /** 官方业务码（如 60006） */
  businessCode?: number;
  message: string;
  residual: Residual;
  /** 期望：是否应被判为「不可售」 */
  expectUnavailable: boolean;
}

/**
 * 构造**矛盾输入**：`receipt.ok === false`，却同时带一份残留 `quote`。
 * 这正是复评 P2-1 的机械反例——`Pricer` 是导出契约，核心层不得假定调用方永远自洽。
 */
const contradictoryPricer =
  (c: ContradictionCase): Pricer =>
  async (_item, request) => {
    const req = request ?? requestOf(_item, 'initial');
    const residualPrice = 2800; // 残留报价：恰好等于菜单价，最容易被误采纳
    const productList =
      c.residual === 'matched'
        ? req.items.map((l) => ({
            productCode: l.productCode,
            productName: TARGET_NAME,
            quantity: l.quantity,
            subtotal: residualPrice,
          }))
        : [{ productCode: '0000000000', productName: '别的商品', quantity: 1, subtotal: residualPrice }];
    return {
      quote:
        c.residual === 'absent'
          ? null
          : toPriceResult({ price: residualPrice, productList, takeWayList: [] }),
      receipt: {
        tool: 'calculate-price',
        argsSummary: 'stub',
        at: new Date().toISOString(),
        ok: false,
        attempt: 1,
        retries: 0,
        errorCode: c.code,
        ...(c.businessCode === undefined ? {} : { businessCode: c.businessCode }),
        errorMessage: c.message,
        durationMs: 0,
        channel: 'live',
        stage: 'initial',
      },
    };
  };

/** 复评要求的矩阵：失败码 × 有无残留报价 × 篮子匹配/不匹配 */
const MATRIX: ContradictionCase[] = [
  // ── 官方明确「不可售」：无论有没有残留报价，都必须移出可行集 ──
  { code: 'SERVER_ERROR', businessCode: 60006, message: '商品已售罄或不可售', residual: 'absent', expectUnavailable: true },
  { code: 'SERVER_ERROR', businessCode: 60006, message: '商品已售罄或不可售', residual: 'matched', expectUnavailable: true },
  { code: 'SERVER_ERROR', businessCode: 60006, message: '商品已售罄或不可售', residual: 'mismatch', expectUnavailable: true },
  // ── 可售性未知（超时）：不得采纳残留报价，须用推算价 ──
  { code: 'TIMEOUT', message: '请求超时', residual: 'absent', expectUnavailable: false },
  { code: 'TIMEOUT', message: '请求超时', residual: 'matched', expectUnavailable: false },
  { code: 'TIMEOUT', message: '请求超时', residual: 'mismatch', expectUnavailable: false },
  // ── 可售性未知（限流）：同上 ──
  { code: 'RATE_LIMITED', message: '触发限流', residual: 'absent', expectUnavailable: false },
  { code: 'RATE_LIMITED', message: '触发限流', residual: 'matched', expectUnavailable: false },
  { code: 'RATE_LIMITED', message: '触发限流', residual: 'mismatch', expectUnavailable: false },
];

describe('v3.7.3 · P2-1 失败回执不得被残留报价覆盖（fail-closed）', () => {
  for (const c of MATRIX) {
    const tag = `${c.businessCode === undefined ? c.code : `业务码 ${c.businessCode}`} · ${
      c.residual === 'absent' ? '无残留报价' : c.residual === 'matched' ? '残留报价且篮子匹配' : '残留报价且篮子不匹配'
    }`;
    test(`矩阵：${tag} ⇒ 绝不成 official/verified`, async () => {
      const it = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]); // 含 +¥2 替换
      const pricer = contradictoryPricer(c);

      // 先钉住「这个反例确实是矛盾的」：失败回执 + 存在的报价字段
      const attempt = await pricer(it, requestOf(it, 'initial'));
      assert.equal(attempt.receipt.ok, false, '反例前提：回执必须是失败');
      if (c.residual === 'absent') {
        assert.equal(attempt.quote, null);
      } else {
        assert.ok(attempt.quote, '反例前提：残留报价必须存在');
        const verdict = verifyQuoteBasket(requestOf(it, 'initial'), attempt.quote!);
        assert.equal(
          verdict.status,
          c.residual === 'matched' ? 'matched' : 'mismatch',
          '反例前提：篮子匹配性须与用例声明一致（否则覆盖不到「匹配也被拒」）',
        );
        // 矛盾诊断必须给出
        const norm = normalizePriceAttempt(attempt);
        assert.ok(norm.contradiction, '`receipt.ok=false` 且带报价 ⇒ 必须生成明确诊断');
        assert.ok(norm.contradiction!.includes('失败回执就是失败'), '诊断须写明处置原则');
      }

      const outcome = await confirmPrices([it], cents(8000), pricer);

      // ★ 核心断言：失败结果绝不成为「官方已核实价」
      for (const p of [...outcome.within, ...(outcome.nearestOver === null ? [] : [outcome.nearestOver])]) {
        assert.notEqual(p.priceSource, 'official', `${tag}：失败回执不得成 official`);
        assert.equal(p.verified, false, `${tag}：失败回执不得标为已核实`);
      }

      if (c.expectUnavailable) {
        assert.equal(outcome.within.length, 0, `${tag}：不可售者不得进入预算内`);
        assert.equal(outcome.nearestOver, null, `${tag}：不可售者也不作「最接近预算」备选`);
        const ex = outcome.excluded.find((e) => e.code === TARGET_CODE);
        assert.ok(ex, `${tag}：必须如实单列被移出的候选`);
        assert.equal(ex!.kind, 'unavailable', `${tag}：移出理由应为不可售`);
      } else {
        assert.equal(
          outcome.excluded.find((e) => e.code === TARGET_CODE),
          undefined,
          `${tag}：可售性未知 ≠ 不可售，不得移出可行集`,
        );
        const p = outcome.within[0];
        assert.ok(p, `${tag}：价差完整 ⇒ 应用推算价参与预算判定`);
        // ★ 残留报价（¥28.00）**从未**被采纳；金额来自「菜单价 ＋ 已知价差」= ¥30.00
        assert.equal(p!.effectivePrice, 3000, `${tag}：金额须为 2800 + 200 的推算价，而非残留报价 2800`);
        assert.equal(p!.priceSource, 'menu-adjusted-unverified', `${tag}：推算价须标第四态`);
        assert.equal(p!.verified, false, `${tag}：推算价不是已核实`);
        if (c.residual !== 'absent') {
          assert.ok(
            p!.notes.some((n) => n.includes('矛盾输入')),
            `${tag}：残留报价的矛盾必须在说明里留痕`,
          );
        }
      }
    });
  }

  test('`normalizePriceAttempt`：自洽输入不产生诊断（不得误报）', () => {
    const ok = normalizePriceAttempt({
      quote: toPriceResult({ price: 100, productList: [], takeWayList: [] }),
      receipt: {
        tool: 'calculate-price',
        argsSummary: '',
        at: new Date().toISOString(),
        ok: true,
        attempt: 1,
        durationMs: 0,
      },
    });
    assert.equal(ok.contradiction, undefined, '成功回执带报价是正常情形，不得报矛盾');

    const failedNoQuote = normalizePriceAttempt({
      quote: null,
      receipt: {
        tool: 'calculate-price',
        argsSummary: '',
        at: new Date().toISOString(),
        ok: false,
        attempt: 1,
        errorCode: 'TIMEOUT',
        durationMs: 0,
      },
    });
    assert.equal(failedNoQuote.contradiction, undefined, '失败但没有残留报价 ⇒ 不是矛盾输入');
  });
});

describe('v3.7.3 · P2-2 组成真值独立于价差数值', () => {
  test('非默认 ±¥0 替换 ⇒ `compositionChanged=true`，依据点名「±¥0.00」，不得写成「组成与默认一致」', async () => {
    const it = await analyzeWith([{ round: SNACK_ROUND, choice: CORN_SMALL }]);
    const adj = adjustedMenuPriceOf(it);
    assert.ok(adj, '价差已取得（为 0）⇒ 应能推算');
    // 金额事实：±¥0 ⇒ 调整额与金额**不变**（不得凭空加减）
    assert.equal(adj!.adjustment, 0, '该选项在本套餐官方标 ±¥0 ⇒ 调整额必须为 0');
    assert.equal(adj!.cents, BASE_CENTS, '调整后菜单价仍为 ¥28.00');
    // 组成事实：**非默认项即组成已变**——与价差是否为 0 无关
    assert.equal(adj!.compositionChanged, true, '±¥0 的非默认替换**同样是替换**');
    assert.ok(adj!.basis.includes(CORN_SMALL), '依据里必须点名被替换的选项');
    assert.ok(adj!.basis.includes('±¥0.00'), '±¥0 也要如实列出，不能因为金额为零而隐去');
    assert.ok(!adj!.basis.includes('组成与默认一致'), '不得再写成「菜单价（组成与默认一致）」');
  });

  test('官方实付未取得（超时）⇒ 价源须为 `menu-adjusted-unverified`，且写明「未确认该替换组成可售」', async () => {
    const it = await analyzeWith([{ round: SNACK_ROUND, choice: CORN_SMALL }]);
    const outcome = await confirmPrices([it], cents(8000), timeoutPricer);
    const p = outcome.within[0];
    assert.ok(p, '价差完整 ⇒ 应以推算价参与预算判定（¥28 ≤ ¥80）');
    assert.equal(p!.effectivePrice, 2800, '金额仍是 ¥28.00（±¥0 不改变金额）');
    assert.equal(p!.priceSource, 'menu-adjusted-unverified', '组成已变 ⇒ 不得退回普通 menu');
    assert.equal(p!.verified, false, '推算价不是已核实');
    assert.ok((p!.priceBasis ?? '').includes('±¥0.00'), '金额依据须显示这是一次 ±¥0 的替换');
    assert.ok(
      p!.notes.some((n) => n.includes('未确认该替换组成可售')),
      '降级说明须统一写明「不是官方实付，也未确认该替换组成可售」',
    );
  });

  test('对照（不得误升级）：无替换项 ⇒ `compositionChanged=false`、价源仍是普通 menu', async () => {
    const it = await analyzeWith([]);
    const adj = adjustedMenuPriceOf(it);
    assert.ok(adj);
    assert.equal(adj!.compositionChanged, false, '没有非默认项 ⇒ 组成未变');
    assert.equal(adj!.basis, '菜单价（组成与默认一致）');

    const outcome = await confirmPrices([it], cents(8000), timeoutPricer);
    const p = outcome.within[0];
    assert.ok(p);
    assert.equal(p!.priceSource, 'menu', '组成未变时沿用普通菜单价语义——不要矫枉过正');
    assert.equal(p!.verified, false);
  });
});
