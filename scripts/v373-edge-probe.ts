/**
 * v3.7.3 复评 P2 反例探针（**前后对照**用）
 *
 * 用法：`node scripts/v373-edge-probe.ts > out.json`
 *
 * 设计约束：**只使用 v3.7.2 与 v3.7.3 都存在的公开 API**，
 * 故同一份脚本可在「修复前」与「修复后」的源码树上各跑一次，逐字段对照。
 * （`adjustedMenuPriceOf` 的 `compositionChanged` 是 v3.7.3 新增字段，
 *   故此处按可选读取，缺省记 `null`——修复前本就**没有**这个字段。）
 *
 * 两条反例出自：`mcmeal-compass-v3.7.2-review-2026-10-16.md` P2-1 / P2-2。
 */

import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';
import { NutritionMatcher } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { analyzeMenu, type AnalyzedItem } from '../src/analyze.ts';
import { adjustedMenuPriceOf, confirmPrices, requestOf, type Pricer } from '../src/pricing.ts';
import { cents } from '../src/money.ts';
import { toPriceResult } from '../src/schema.ts';

const TARGET_CODE = '9900004236';
const TARGET_NAME = '人气超值四件套随心选';

const analyzeWith = async (specs: { round: string; choice: string }[]): Promise<AnalyzedItem> => {
  const b = await loadFixtures();
  const matcher = new NutritionMatcher(b.nutritionRows, { aliases: DEFAULT_ALIASES });
  const { items } = await analyzeMenu(b.menuItems, matcher, fixtureDetailLoader(b), {
    ...(specs.length === 0 ? {} : { substitutions: specs }),
  });
  const it = items.find((i) => i.code === TARGET_CODE);
  if (!it) throw new Error(`夹具里应有 ${TARGET_CODE}`);
  return it;
};

/** 矛盾输入：失败回执 + 一份**与请求核对得上**的残留报价 */
const conflictingPricer =
  (errorCode: string, businessCode: number | undefined, message: string): Pricer =>
  async (item, request) => {
    const req = request ?? requestOf(item, 'initial');
    const residual = 2800;
    return {
      quote: toPriceResult({
        price: residual,
        productList: req.items.map((l) => ({
          productCode: l.productCode,
          productName: TARGET_NAME,
          quantity: l.quantity,
          subtotal: residual,
        })),
        takeWayList: [],
      }),
      receipt: {
        tool: 'calculate-price',
        argsSummary: 'stub',
        at: new Date().toISOString(),
        ok: false,
        attempt: 1,
        retries: 0,
        errorCode,
        ...(businessCode === undefined ? {} : { businessCode }),
        errorMessage: message,
        durationMs: 0,
        channel: 'live',
        stage: 'initial',
      },
    };
  };

const unknownPricer = (code: string, message: string): Pricer => async () => {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  throw e;
};

type Case = { input: unknown; output: unknown };

const rejectCase = async (errorCode: string, businessCode: number | undefined, message: string): Promise<Case> => {
  const it = await analyzeWith([{ round: '选择套餐内饮料', choice: '可乐大杯' }]);
  const outcome = await confirmPrices([it], cents(8000), conflictingPricer(errorCode, businessCode, message));
  const p = outcome.within[0] ?? outcome.nearestOver;
  return {
    input: {
      selectedComponents: [{ roundName: '选择套餐内饮料', choiceName: '可乐大杯', diffPrice: 200 }],
      receipt: { ok: false, errorCode, businessCode, errorMessage: message },
      residualQuote: { price: 2800, productListMatchesRequest: true },
      budgetCents: 8000,
    },
    output: {
      priceSource: p?.priceSource ?? null,
      verified: p?.verified ?? null,
      unavailable: p?.unavailable ?? null,
      effectivePrice: p?.effectivePrice ?? null,
      withinCount: outcome.within.length,
      nearestOverIsNull: outcome.nearestOver === null,
      excluded: outcome.excluded.map((e) => ({ code: e.code, kind: e.kind })),
      notes: p?.notes ?? [],
    },
  };
};

const main = async (): Promise<void> => {
  // ── 反例一：失败回执被同对象里的残留报价覆盖（P2-1）──
  const p21Unavailable = await rejectCase('SERVER_ERROR', 60006, '商品已售罄或不可售');
  const p21Timeout = await rejectCase('TIMEOUT', undefined, '请求超时');
  const p21RateLimited = await rejectCase('RATE_LIMITED', undefined, '触发限流');

  // ── 反例二：非默认 ±¥0 替换被写成「组成与默认一致」（P2-2）──
  const itZero = await analyzeWith([{ round: '小食#1', choice: '小杯玉米杯' }]);
  const adj = adjustedMenuPriceOf(itZero);
  const adjRecord = adj as unknown as Record<string, unknown> | null;
  const zeroOutcome = await confirmPrices([itZero], cents(8000), unknownPricer('TIMEOUT', '请求超时'));
  const zp = zeroOutcome.within[0] ?? zeroOutcome.nearestOver;

  const report = {
    probedAt: new Date().toISOString(),
    storeHint: '离线夹具（fixtures）· 套餐 9900004236',
    cases: {
      'P2-1 · 60006 + 残留匹配报价': p21Unavailable,
      'P2-1 · TIMEOUT + 残留匹配报价': p21Timeout,
      'P2-1 · RATE_LIMITED + 残留匹配报价': p21RateLimited,
      'P2-2 · 非默认 ±¥0 替换（adjustedMenuPriceOf）': {
        input: {
          selectedComponents: [{ roundName: '小食#1', choiceName: '小杯玉米杯', isDefault: false, diffPrice: 0 }],
          menuPrice: 2800,
        },
        output: {
          cents: adjRecord?.['cents'] ?? null,
          adjustment: adjRecord?.['adjustment'] ?? null,
          compositionChanged: adjRecord?.['compositionChanged'] ?? null,
          basis: adjRecord?.['basis'] ?? null,
        },
      },
      'P2-2 · 官方未取得时（超时）该替换的价源与措辞': {
        input: { scenario: '官方计价未取得（TIMEOUT）', budgetCents: 8000 },
        output: {
          priceSource: zp?.priceSource ?? null,
          effectivePrice: zp?.effectivePrice ?? null,
          verified: zp?.verified ?? null,
          priceBasis: zp?.priceBasis ?? null,
          notes: zp?.notes ?? [],
        },
      },
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
};

await main();
