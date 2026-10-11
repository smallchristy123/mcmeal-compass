/**
 * 计价闭环与预算硬约束（T2.3）
 *
 * 计划书 §6.2 第 2 阶段：
 *   · 先用**菜单价**做预筛（快、无需额外调用）；
 *   · 再对**入选候选**用官方 `calculate-price` 确认**含优惠与服务费的实付金额**；
 *   · `price > budget` 的候选排除在「预算内」方案外；
 *   · 若**全部超预算**，给出「**最接近且明确超出**」的备选，并明确说明它超了多少。
 *
 * 两条不可省的点：
 *   1. **官方计价为准**——菜单价可能与实付不同（优惠、服务费、打包费）；
 *   2. 计价失败时**降级但如实标注**，不假装已核实。
 *
 * ── 外部评审 P0-3 的处置（2026-10-11）──
 *   · **结构化收据**：每次报价都产出一条 `PriceReceipt`（工具/参数摘要/时间/状态/错误/重试/响应哈希），
 *     解释层的工具轨迹改为**引用真实收据**，不再静态拼装、更不会把失败的调用记成 `ok: true`；
 *   · **有界并发**：串行改并发（默认 3），并设**请求预算**与 **429 止损**（限流即停，不再硬送）；
 *   · **合法 0 元**：只有「官方没给价格」（`price === null`）才降级用菜单价；合法的 0 元报价照用；
 *   · **最终复核**：`requoteFinal()` 对最终入选方案再报一次价，标注报价时刻与来源。
 */

import { createHash } from 'node:crypto';

import type { AnalyzedItem } from './analyze.ts';
import type { PriceResult } from './schema.ts';
import { toYuan, type Cents } from './money.ts';

/** 单次官方报价的**结构化收据**（可作审计凭据，脱敏） */
export interface PriceReceipt {
  tool: 'calculate-price';
  /** 参数摘要（脱敏：只有商品码与数量，无 Token/账号/地址） */
  argsSummary: string;
  /** 发起时刻（ISO） */
  at: string;
  ok: boolean;
  /** 第几次尝试（1 起）；0 表示**未发起**（预算/止损导致） */
  attempt: number;
  /** 重试次数；**未知则省略**（不谎报 0） */
  retries?: number;
  /** 失败时的错误分类（如 RATE_LIMITED / TIMEOUT） */
  errorCode?: string;
  /** 失败说明（客户端保证已脱敏） */
  errorMessage?: string;
  /** 成功响应内容的 SHA-256 前 12 位（可用于交叉核对"当时到底返回了什么"） */
  responseHash?: string;
  durationMs: number;
}

export interface PricedCandidate {
  item: AnalyzedItem;
  /** 官方计价结果；null 表示未取得（此时价格来源为菜单价） */
  quote: PriceResult | null;
  /** 该候选对应的报价收据（含失败情形） */
  receipt: PriceReceipt;
  /** 用于比较的金额（分） */
  effectivePrice: Cents | null;
  /** 价格来源，**必须如实标注** */
  priceSource: 'official' | 'menu';
  withinBudget: boolean;
  /** 超出预算的金额（分）；未超为 0 */
  overByCents: number;
  /** 说明（如菜单价与实付不一致） */
  notes: string[];
  /** 是否已由官方计价核实（=false 时展示层必须标「未核实」） */
  verified: boolean;
}

export interface PricingOutcome {
  /** 预算内候选（已按官方计价确认或如实降级） */
  within: PricedCandidate[];
  /** 全部超预算时的「最接近预算」备选 */
  nearestOver: PricedCandidate | null;
  notes: string[];
  /** 全部报价收据（含失败的），供解释层引用与审计 */
  receipts: PriceReceipt[];
}

/** 一次报价的产出：结果 + 收据 */
export interface PriceAttempt {
  quote: PriceResult | null;
  receipt: PriceReceipt;
}

/** 计价器：给定候选，返回报价结果与收据 */
export type Pricer = (item: AnalyzedItem) => Promise<PriceAttempt>;

/** 便于测试与调用方构造一个"成功收据" */
export function buildArgsSummary(items: readonly { productCode: string; quantity: number }[]): string {
  return `items=[${items.map((i) => `${i.productCode}×${i.quantity}`).join(',')}]`;
}

export function hashResponse(payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export interface ConfirmOptions {
  /** 官方计价失败时是否回退用菜单价（默认 true，并标注来源） */
  fallbackToMenuPrice?: boolean;
  /** 并发上限（默认 3）——避免把限流打爆 */
  concurrency?: number;
  /** 请求预算上限（默认 200）——超出即不再发起，剩余候选如实标为未核实 */
  maxRequests?: number;
  /** 遇到限流（RATE_LIMITED）是否停止后续请求（默认 true） */
  stopOnRateLimit?: boolean;
  /** 进度回调 */
  onProgress?: (done: number, total: number) => void;
}

interface ConfirmState {
  requests: number;
  stopped: boolean;
  stopReason: string | null;
}

/** 判断某个错误码是否属于"限流/不可继续" */
function isRateLimited(code: string | undefined): boolean {
  return code === 'RATE_LIMITED';
}

/**
 * 对候选调用官方计价并做预算判定。
 * 调用方应**先用菜单价粗筛**，只把少量候选递进来（并发亦有上限，避免打爆限流）。
 */
export async function confirmPrices(
  candidates: readonly AnalyzedItem[],
  budgetCents: Cents,
  pricer: Pricer,
  options: ConfirmOptions = {},
): Promise<PricingOutcome> {
  const fallback = options.fallbackToMenuPrice ?? true;
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const maxRequests = Math.max(0, options.maxRequests ?? 200);
  const stopOnRateLimit = options.stopOnRateLimit ?? true;

  const notes: string[] = [];
  const priced: PricedCandidate[] = new Array(candidates.length);
  const state: ConfirmState = { requests: 0, stopped: false, stopReason: null };
  let done = 0;

  const work = async (item: AnalyzedItem): Promise<PricedCandidate> => {
    // 请求预算 / 止损：一旦触顶或已限流，不再发起，如实标为"未核实"
    if (state.stopped || state.requests >= maxRequests) {
      const reason = state.stopReason ?? `已达请求预算上限（${maxRequests} 次）`;
      const receipt: PriceReceipt = {
        tool: 'calculate-price',
        argsSummary: buildArgsSummary([{ productCode: item.code, quantity: 1 }]),
        at: new Date().toISOString(),
        ok: false,
        attempt: 0,
        retries: 0,
        errorCode: state.stopped ? 'RATE_LIMITED' : 'BUDGET_EXCEEDED',
        errorMessage: `未发起计价：${reason}`,
        durationMs: 0,
      };
      return {
        item,
        quote: null,
        receipt,
        effectivePrice: fallback ? item.price : null,
        priceSource: 'menu',
        withinBudget: item.price !== null && fallback && item.price <= budgetCents,
        overByCents: fallback && item.price !== null ? Math.max(0, item.price - budgetCents) : Number.POSITIVE_INFINITY,
        notes: [`未发起官方计价（${reason}），如展示须标「未核实实付」`],
        verified: false,
      };
    }

    state.requests++;
    let attempt: PriceAttempt;
    try {
      attempt = await pricer(item);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      attempt = {
        quote: null,
        receipt: {
          tool: 'calculate-price',
          argsSummary: buildArgsSummary([{ productCode: item.code, quantity: 1 }]),
          at: new Date().toISOString(),
          ok: false,
          attempt: 1,
          retries: 0,
          ...(err.code === undefined ? {} : { errorCode: err.code }),
          errorMessage: err.message ?? String(e),
          durationMs: 0,
        },
      };
    }

    if (!attempt.receipt.ok && isRateLimited(attempt.receipt.errorCode) && stopOnRateLimit) {
      state.stopped = true;
      state.stopReason = `官方计价返回限流（RATE_LIMITED），已停止后续计价请求`;
      notes.push(state.stopReason);
    }

    const itemNotes: string[] = [];
    let effectivePrice: Cents | null = null;
    let priceSource: 'official' | 'menu' = 'menu';
    let verified = false;

    // ⚠️ 只有「官方没给出价格」才降级；合法的 0 元报价照用（0 元 ≠ 没报价）
    if (attempt.quote && attempt.quote.price !== null) {
      effectivePrice = attempt.quote.price;
      priceSource = 'official';
      verified = true;
      if (attempt.quote.price === 0) {
        itemNotes.push('官方报价为 ¥0.00（可能为赠品或全额优惠）——按官方价采用，**不是**「没拿到报价」');
      } else if (item.price !== null && item.price !== attempt.quote.price) {
        itemNotes.push(
          `菜单价 ¥${toYuan(item.price).toFixed(2)} 与官方实付 ¥${toYuan(attempt.quote.price).toFixed(2)} 不同（含优惠/费用）`,
        );
      }
    } else if (fallback && item.price !== null) {
      effectivePrice = item.price;
      priceSource = 'menu';
      itemNotes.push(
        `官方计价未取得（${attempt.receipt.errorCode ?? '未知原因'}），暂以菜单价计——**未核实实付**`,
      );
    } else {
      itemNotes.push('无价格数据，无法做预算判定');
    }

    const overByCents =
      effectivePrice === null ? Number.POSITIVE_INFINITY : Math.max(0, effectivePrice - budgetCents);

    done++;
    options.onProgress?.(done, candidates.length);

    return {
      item,
      quote: attempt.quote,
      receipt: attempt.receipt,
      effectivePrice,
      priceSource,
      withinBudget: effectivePrice !== null && effectivePrice <= budgetCents,
      overByCents,
      notes: itemNotes,
      verified,
    };
  };

  // 有界并发
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const idx = cursor++;
      const item = candidates[idx]!;
      priced[idx] = await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length || 1) }, worker));

  const results = priced.filter((p): p is PricedCandidate => p !== undefined);
  const within = results.filter((p) => p.withinBudget);

  let nearestOver: PricedCandidate | null = null;
  if (within.length === 0 && results.length > 0) {
    const overable = results.filter((p) => Number.isFinite(p.overByCents));
    nearestOver = overable.slice().sort((a, b) => a.overByCents - b.overByCents)[0] ?? null;
    if (nearestOver) {
      notes.push(
        `所有候选均超出预算。最接近的是「${nearestOver.item.name}」，` +
          `超出 ¥${toYuan(nearestOver.overByCents as Cents).toFixed(2)}——**需你明确同意后才纳入考虑**。`,
      );
    }
  }

  const unverified = results.filter((p) => !p.verified).length;
  if (unverified > 0) {
    notes.push(`有 ${unverified} 个候选未能取得官方报价，相关金额一律标注「未核实实付」。`);
  }
  const skippedByBudget = results.filter((p) => p.receipt.errorCode === 'BUDGET_EXCEEDED').length;
  if (skippedByBudget > 0) {
    notes.push(`有 ${skippedByBudget} 个候选因已达请求预算上限而未发起官方计价。`);
  }
  notes.push(`本次共发起 ${state.requests} 次官方计价请求（预算上限 ${maxRequests}，并发 ${concurrency}）。`);

  return { within, nearestOver, notes, receipts: results.map((r) => r.receipt) };
}

// ─────────────────── 最终复核（P0-3） ───────────────────

export interface RequoteResult {
  /** 按官方报价重新确认后的金额；null 表示复核失败 */
  price: Cents | null;
  receipt: PriceReceipt;
  /** 与初次报价是否一致（null 表示无法比较） */
  consistent: boolean | null;
  note: string;
}

/**
 * 对**最终入选**的方案按实际组件清单再报一次价。
 *
 * 为什么必须做：初筛用的可能只是菜单价或较早的报价；用户真正看到的方案，
 * 必须有一份**当下**的官方报价 + 时刻 + 来源，否则"实时价格"四个字站不住。
 */
export async function requoteFinal(
  candidate: PricedCandidate,
  pricer: Pricer,
  /** 实际组件清单（套餐被替换后，这里应是替换后的组件）；缺省用候选自身 */
  components?: readonly { productCode: string; quantity: number }[],
): Promise<RequoteResult> {
  const list = components ?? [{ productCode: candidate.item.code, quantity: 1 }];
  let attempt: PriceAttempt;
  try {
    attempt = await pricer({ ...candidate.item, code: list[0]!.productCode });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return {
      price: null,
      receipt: {
        tool: 'calculate-price',
        argsSummary: buildArgsSummary(list),
        at: new Date().toISOString(),
        ok: false,
        attempt: 1,
        retries: 0,
        ...(err.code === undefined ? {} : { errorCode: err.code }),
        errorMessage: err.message ?? String(e),
        durationMs: 0,
      },
      consistent: null,
      note: '最终复核失败——该方案的价格须标为「未核实」，不得以菜单价充当实付价',
    };
  }

  const before = candidate.effectivePrice;
  const after = attempt.quote?.price ?? null;
  const consistent = before === null || after === null ? null : before === after;
  return {
    price: after,
    receipt: attempt.receipt,
    consistent,
    note:
      attempt.receipt.ok
        ? consistent === true
          ? `复核一致（¥${(toYuan(after as Cents)).toFixed(2)}）`
          : consistent === false
            ? `复核与初次报价不同（¥${before === null ? '—' : toYuan(before).toFixed(2)} → ¥${after === null ? '—' : toYuan(after).toFixed(2)}），以复核价为准`
            : '复核成功，但初次报价缺失，无法比较'
        : '复核未成功，价格来源降级为菜单价并须标注「未核实」',
  };
}
