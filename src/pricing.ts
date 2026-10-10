/**
 * 计价闭环与预算硬约束（T2.3）
 *
 * 计划书 §6.2 第 2 阶段：
 *   · 先用**菜单价**做预筛（快、无需额外调用）；
 *   · 再对**入选候选**用官方 `calculate-price` 确认**含优惠与服务费的实付金额**；
 *   · `price > budget` 的候选排除在「预算内」方案外；
 *   · 若**全部超预算**，给出「**最接近且明确超出**」的备选，并明确说明它超了多少。
 *
 * 两个不可省的点：
 *   1. **官方计价为准**——菜单价可能与实付不同（优惠、服务费、打包费）；
 *   2. 计价失败时**降级但如实标注**，不假装已核实。
 */

import type { AnalyzedItem } from './analyze.ts';
import type { PriceResult } from './schema.ts';
import { toYuan, type Cents } from './money.ts';

export interface PricedCandidate {
  item: AnalyzedItem;
  /** 官方计价结果；null 表示未取得（此时价格来源为菜单价） */
  quote: PriceResult | null;
  /** 用于比较的金额（分） */
  effectivePrice: Cents | null;
  /** 价格来源，**必须如实标注** */
  priceSource: 'official' | 'menu';
  withinBudget: boolean;
  /** 超出预算的金额（分）；未超为 0 */
  overByCents: number;
  /** 说明（如菜单价与实付不一致） */
  notes: string[];
}

export interface PricingOutcome {
  /** 预算内候选（已按官方计价确认或如实降级） */
  within: PricedCandidate[];
  /** 全部超预算时的「最接近预算」备选 */
  nearestOver: PricedCandidate | null;
  notes: string[];
}

/** 计价器：给定候选，返回官方计价结果（失败返回 null） */
export type Pricer = (item: AnalyzedItem) => Promise<PriceResult | null>;

export interface ConfirmOptions {
  /** 官方计价失败时是否回退用菜单价（默认 true，并标注来源） */
  fallbackToMenuPrice?: boolean;
}

/**
 * 对候选调用官方计价并做预算判定。
 * 调用方应**先用菜单价粗筛**，只把少量候选递进来（避免打爆限流）。
 */
export async function confirmPrices(
  candidates: readonly AnalyzedItem[],
  budgetCents: Cents,
  pricer: Pricer,
  options: ConfirmOptions = {},
): Promise<PricingOutcome> {
  const fallback = options.fallbackToMenuPrice ?? true;
  const notes: string[] = [];
  const priced: PricedCandidate[] = [];

  for (const item of candidates) {
    let quote: PriceResult | null = null;
    try {
      quote = await pricer(item);
    } catch (e) {
      notes.push(`「${item.name}」官方计价失败：${e instanceof Error ? e.message : String(e)}`);
    }

    let effectivePrice: Cents | null = null;
    let priceSource: 'official' | 'menu' = 'menu';
    const itemNotes: string[] = [];

    if (quote && quote.price > 0) {
      effectivePrice = quote.price;
      priceSource = 'official';
      if (item.price !== null && item.price !== quote.price) {
        itemNotes.push(
          `菜单价 ¥${toYuan(item.price).toFixed(2)} 与官方实付 ¥${toYuan(quote.price).toFixed(2)} 不同（含优惠/费用）`,
        );
      }
    } else if (fallback && item.price !== null) {
      effectivePrice = item.price;
      priceSource = 'menu';
      itemNotes.push('官方计价未取得，暂以菜单价计——**未核实实付**');
    } else {
      itemNotes.push('无价格数据，无法做预算判定');
    }

    const overByCents = effectivePrice === null ? Number.POSITIVE_INFINITY : Math.max(0, effectivePrice - budgetCents);
    priced.push({
      item,
      quote,
      effectivePrice,
      priceSource,
      withinBudget: effectivePrice !== null && effectivePrice <= budgetCents,
      overByCents,
      notes: itemNotes,
    });
  }

  const within = priced.filter((p) => p.withinBudget);
  let nearestOver: PricedCandidate | null = null;
  if (within.length === 0 && priced.length > 0) {
    const overable = priced.filter((p) => Number.isFinite(p.overByCents));
    nearestOver = overable.slice().sort((a, b) => a.overByCents - b.overByCents)[0] ?? null;
    if (nearestOver) {
      notes.push(
        `所有候选均超出预算。最接近的是「${nearestOver.item.name}」，` +
          `超出 ¥${toYuan(nearestOver.overByCents as Cents).toFixed(2)}——**需你明确同意后才纳入考虑**。`,
      );
    }
  }

  return { within, nearestOver, notes };
}
