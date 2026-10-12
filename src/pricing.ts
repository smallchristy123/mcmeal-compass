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

/** 一条报价行（官方契约：**productCode** + quantity） */
export interface PriceLine {
  productCode: string;
  quantity: number;
}

/** 报价阶段：初次确认 / 最终复核 */
export type PriceStage = 'initial' | 'final';

/**
 * 报价渠道——用于**如实**统计「本次到底发起了几次真实请求」（评审 R6）：
 *   · `live`          真实 HTTP 请求；
 *   · `cache`         命中时间窗内缓存（**不新增网络调用**）；
 *   · `offline`       离线夹具（**不发起任何请求**）；
 *   · `not-attempted` 因止损/请求预算未发起。
 */
export type ReceiptChannel = 'live' | 'cache' | 'offline' | 'not-attempted';

/**
 * 一次**明确的报价请求**（评审 R4）。
 *
 * 之前 `requoteFinal` 只把 `list[0].productCode` 交给计价器，**丢掉其余组件与数量**，
 * 收据上却写着 `A×1`。现在：完整清单、组成指纹、报价阶段三者一起进入请求、收据与缓存标识。
 */
export interface PriceRequest {
  /** 报价对象（套餐按官方契约**整体报价**，不盲目拆成单品相加） */
  items: readonly PriceLine[];
  /** 实际组成（若与 items 不同，例如套餐选了非默认组件）——留痕与指纹用 */
  composition?: readonly PriceLine[];
  /** 组成指纹：items + composition 规范化后取哈希；进缓存键与收据 */
  fingerprint: string;
  stage: PriceStage;
}

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
  /** 渠道（**必须如实**：它决定"离线=0 次真实请求"这句话能不能站住） */
  channel?: ReceiptChannel;
  /** 报价阶段 */
  stage?: PriceStage;
  /** 组成指纹（与缓存标识一致，可交叉核对"这个价对应哪份组成"） */
  requestFingerprint?: string;
}

/**
 * 价格来源（**三态，R12 整改**）：
 *   · `official`             —— 本次报价**已通过核对**（可用于「官方实付」措辞）；
 *   · `official-unverified`  —— 金额来自**初次**官方报价，但**最终复核未成功**：
 *                               金额可以留作参考，但**不得**声称「已核」；
 *   · `menu`                 —— 菜单价（官方价未取得）。
 *
 * ⚠️ 病根（v3 被复审判 P0）：最终复核失败时，`applyRequote` 把来源回退成 `candidate.priceSource`，
 * 于是「初次官方价 + 复核失败」被渲染成「官方计价实付…（含优惠与费用，已核）」
 * ——**未核实却写着已核**，正是最该被阻断的一类不一致。
 */
export type PriceSource = 'official' | 'menu' | 'official-unverified';

export interface PricedCandidate {
  item: AnalyzedItem;
  /** 官方计价结果；null 表示未取得（此时价格来源为菜单价） */
  quote: PriceResult | null;
  /** 该候选对应的报价收据（含失败情形） */
  receipt: PriceReceipt;
  /** 用于比较的金额（分） */
  effectivePrice: Cents | null;
  /** 价格来源，**必须如实标注**（三态，见 `PriceSource`） */
  priceSource: PriceSource;
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
  /** 本次「到底做了什么」的如实统计（离线=0 次真实请求） */
  summary: RequestSummary;
}

/** 一次报价的产出：结果 + 收据 */
export interface PriceAttempt {
  quote: PriceResult | null;
  receipt: PriceReceipt;
}

/** 计价器：给定候选（与可选的完整报价请求），返回报价结果与收据 */
export type Pricer = (item: AnalyzedItem, request?: PriceRequest) => Promise<PriceAttempt>;

/** 便于测试与调用方构造一个"成功收据" */
export function buildArgsSummary(items: readonly PriceLine[]): string {
  return `items=[${items.map((i) => `${i.productCode}×${i.quantity}`).join(',')}]`;
}

export function hashResponse(payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** 规范化清单：剔除数量非正的行，并按商品码排序（保证指纹稳定） */
export function normalizeLines(lines: readonly PriceLine[]): PriceLine[] {
  return lines
    .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0)
    .slice()
    .sort((a, b) => a.productCode.localeCompare(b.productCode));
}

/** 组成指纹：同一份「商品 × 数量 × 组成」必得同一指纹；任一变化即变 */
export function fingerprintOf(items: readonly PriceLine[], composition?: readonly PriceLine[]): string {
  return hashResponse({
    items: normalizeLines(items),
    composition: composition && composition.length > 0 ? normalizeLines(composition) : null,
  });
}

/** 默认报价对象：**按官方契约整体报价**（套餐不拆件），单件即自身 */
export function basketOf(item: AnalyzedItem): PriceLine[] {
  return [{ productCode: item.code, quantity: 1 }];
}

/** 实际组成（来自结构化组件；仅用于指纹与留痕，不用于拆价） */
export function compositionOf(item: AnalyzedItem): PriceLine[] {
  return (item.components ?? []).map((c) => ({
    productCode: c.choiceCode,
    quantity: c.quantity > 0 ? c.quantity : 1,
  }));
}

/**
 * 构造一次完整报价请求。
 * @param items 显式给定的报价对象；未给则用候选自身（套餐整体）
 */
export function requestOf(
  item: AnalyzedItem,
  stage: PriceStage,
  items?: readonly PriceLine[],
): PriceRequest {
  const lines = items && items.length > 0 ? items : basketOf(item);
  const composition = compositionOf(item);
  return {
    items: lines,
    ...(composition.length > 0 ? { composition } : {}),
    fingerprint: fingerprintOf(lines, composition),
    stage,
  };
}

/** 报价对象与响应对照的核对结论（评审 R9） */
export interface BasketVerdict {
  status: 'matched' | 'empty-response' | 'mismatch';
  detail: string;
}

/**
 * 核对「请求的商品与数量」是否与响应逐项对应。
 *
 * 为什么要这一步：v2 只判断「响应里有 price 字段」，于是**空清单 + ¥0**
 * 被当成「官方已核实 0 元」。合法 0 元（赠品/全额优惠）仍应接受——
 * 前提是**报价对象核对得上**，而不是凭空清单猜成功。
 */
export function verifyQuoteBasket(
  request: PriceRequest,
  quote: { productList: readonly { productCode: string; quantity: number }[] },
): BasketVerdict {
  const want = normalizeLines(request.items);
  const got = normalizeLines(quote.productList.map((p) => ({ productCode: p.productCode, quantity: p.quantity })));

  if (want.length === 0) {
    return { status: 'matched', detail: '请求清单为空（无需对照）' };
  }
  if (got.length === 0) {
    return {
      status: 'empty-response',
      detail: `请求 ${want.length} 项，但响应未返回任何商品明细——**无法核对报价对象**`,
    };
  }
  const gotByCode = new Map(got.map((g) => [g.productCode, g.quantity]));
  const missing = want.filter((w) => !gotByCode.has(w.productCode));
  const qtyDiff = want
    .filter((w) => gotByCode.has(w.productCode) && gotByCode.get(w.productCode) !== w.quantity)
    .map((w) => `${w.productCode}：请求 ×${w.quantity} / 响应 ×${gotByCode.get(w.productCode)}`);

  if (missing.length > 0 || qtyDiff.length > 0) {
    return {
      status: 'mismatch',
      detail:
        `报价对象与请求不一致——` +
        [
          missing.length > 0 ? `缺项：${missing.map((m) => m.productCode).join('、')}` : '',
          qtyDiff.length > 0 ? `数量不符：${qtyDiff.join('；')}` : '',
        ]
          .filter(Boolean)
          .join('；'),
    };
  }
  const extra = got.filter((g) => !want.some((w) => w.productCode === g.productCode));
  return {
    status: 'matched',
    detail:
      extra.length > 0
        ? `报价对象与请求一致（响应另含 ${extra.length} 项，未纳入判定）`
        : '报价对象与请求一致',
  };
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
    const request = requestOf(item, 'initial');
    // 请求预算 / 止损：一旦触顶或已限流，不再发起，如实标为"未核实"
    if (state.stopped || state.requests >= maxRequests) {
      const reason = state.stopReason ?? `已达请求预算上限（${maxRequests} 次）`;
      const receipt: PriceReceipt = {
        tool: 'calculate-price',
        argsSummary: buildArgsSummary(request.items),
        at: new Date().toISOString(),
        ok: false,
        attempt: 0,
        retries: 0,
        errorCode: state.stopped ? 'RATE_LIMITED' : 'BUDGET_EXCEEDED',
        errorMessage: `未发起计价：${reason}`,
        durationMs: 0,
        channel: 'not-attempted',
        stage: 'initial',
        requestFingerprint: request.fingerprint,
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
      // ⚠️ 完整报价请求随行：组件与数量不再丢失（评审 R4）
      attempt = await pricer(item, request);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      attempt = {
        quote: null,
        receipt: {
          tool: 'calculate-price',
          argsSummary: buildArgsSummary(request.items),
          at: new Date().toISOString(),
          ok: false,
          attempt: 1,
          retries: 0,
          ...(err.code === undefined ? {} : { errorCode: err.code }),
          errorMessage: err.message ?? String(e),
          durationMs: 0,
          channel: 'live',
          stage: 'initial',
          requestFingerprint: request.fingerprint,
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

    // 报价对象核对（评审 R9）：拿不到逐项清单 / 商品或数量不符 ⇒ 不能算"已核实"
    const verdict = attempt.quote ? verifyQuoteBasket(request, attempt.quote) : null;
    const pricePresent = Boolean(attempt.quote && attempt.quote.price !== null);
    const basketOk = verdict?.status === 'matched';

    // ⚠️ 只有「官方给出价格 **且** 报价对象核对得上」才采纳为官方价；
    //    合法的 0 元报价照用（0 元 ≠ 没报价），但同样要过核对这一关。
    if (pricePresent && basketOk) {
      effectivePrice = attempt.quote!.price as Cents;
      priceSource = 'official';
      verified = true;
      if (effectivePrice === 0) {
        itemNotes.push('官方报价为 ¥0.00（可能为赠品或全额优惠）——按官方价采用，**不是**「没拿到报价」');
      } else if (item.price !== null && item.price !== effectivePrice) {
        itemNotes.push(
          `菜单价 ¥${toYuan(item.price).toFixed(2)} 与官方实付 ¥${toYuan(effectivePrice).toFixed(2)} 不同（含优惠/费用）`,
        );
      }
      if (verdict && verdict.detail.includes('另含')) itemNotes.push(`报价对象核对：${verdict.detail}`);
    } else if (pricePresent) {
      // 有价格字段，但报价对象核对不上 → **拒绝采纳**，不得据此说"已核实"
      itemNotes.push(
        `官方响应**未通过报价对象核对**（${verdict?.detail ?? '无明细'}）：不采纳该金额，标记为「未核实实付」`,
      );
      if (fallback && item.price !== null) {
        effectivePrice = item.price;
        priceSource = 'menu';
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
    notes.push(`有 ${unverified} 个候选未能取得**经核对的**官方报价，相关金额一律标注「未核实实付」。`);
  }
  const skippedByBudget = results.filter((p) => p.receipt.errorCode === 'BUDGET_EXCEEDED').length;
  if (skippedByBudget > 0) {
    notes.push(`有 ${skippedByBudget} 个候选因已达请求预算上限而未发起官方计价。`);
  }
  // ⚠️ 这句话必须只统计**真实 HTTP 请求**（评审 R6）：
  //    离线读取、缓存命中、未发起都不算——否则「离线却声称发起 29 次请求」会再次发生。
  const summary = summarizePricing(results);
  notes.push(summary.note);

  return { within, nearestOver, notes, receipts: results.map((r) => r.receipt), summary };
}

// ─────────────────── 请求事实汇总（评审 R6） ───────────────────

/**
 * 「本次到底做了什么」的如实统计——候选/离线/缓存/真实请求/成败/未发起。
 *
 * ⚠️ R12 复审的次要项：旧版把「离线夹具未发起」也算进 `failed`，
 * 读的人容易以为「离线跑了 15 次全失败」。现在**拆成三个不同字段**：
 * `attemptedFailures`（真发起过但失败）／`offlineNotInitiated`（离线未发起）／
 * `skippedByBudget`（因预算或止损未发起）。
 */
export interface RequestSummary {
  candidates: number;
  /** 真实 HTTP 请求次数（离线=0、缓存命中不计） */
  liveAttempts: number;
  cacheHits: number;
  offlineReads: number;
  /** 离线夹具下的「未发起」——**不是失败** */
  offlineNotInitiated: number;
  /** 因请求预算/止损而未发起 */
  skippedByBudget: number;
  /** **发起过**但失败（真实尝试中的失败） */
  attemptedFailures: number;
  succeeded: number;
  retries: number;
  verified: number;
  unverified: number;
  note: string;
}

export function summarizeReceipts(
  receipts: readonly PriceReceipt[],
  verifiedCount = 0,
): RequestSummary {
  const cacheHits = receipts.filter((r) => r.channel === 'cache').length;
  const offlineReads = receipts.filter((r) => r.channel === 'offline').length;
  const offlineNotInitiated = receipts.filter(
    (r) => r.attempt === 0 && r.channel === 'offline',
  ).length;
  const skippedByBudget = receipts.filter(
    (r) => r.attempt === 0 && r.channel !== 'offline',
  ).length;
  const liveAttempts = receipts.filter(
    (r) => r.attempt >= 1 && r.channel !== 'cache' && r.channel !== 'offline',
  ).length;
  const succeeded = receipts.filter((r) => r.attempt >= 1 && r.ok).length;
  const attemptedFailures = receipts.filter((r) => r.attempt >= 1 && !r.ok).length;
  const retries = receipts.reduce((n, r) => n + (r.retries ?? 0), 0);
  const candidates = receipts.length;

  return {
    candidates,
    liveAttempts,
    cacheHits,
    offlineReads,
    offlineNotInitiated,
    skippedByBudget,
    attemptedFailures,
    succeeded,
    retries,
    verified: verifiedCount,
    unverified: candidates - verifiedCount,
    note:
      `本次共发起 ${liveAttempts} 次真实官方计价请求` +
      `（候选 ${candidates} 项；成功 ${succeeded}；发起后失败 ${attemptedFailures}；` +
      `离线读取 ${offlineReads}（其中未发起 ${offlineNotInitiated}）；缓存命中 ${cacheHits}；` +
      `因预算/止损未发起 ${skippedByBudget}；重试 ${retries}）。` +
      `　注：**未发起不等于失败**——离线夹具与预算止损都未发起过请求。`,
  };
}

export function summarizePricing(results: readonly PricedCandidate[]): RequestSummary {
  return summarizeReceipts(
    results.map((r) => r.receipt),
    results.filter((r) => r.verified).length,
  );
}

// ─────────────────── 最终复核（P0-3） ───────────────────

export interface RequoteResult {
  /** 按官方报价重新确认后的金额；null 表示复核失败或未通过对象核对 */
  price: Cents | null;
  receipt: PriceReceipt;
  /** 本次复核实际使用的报价请求（含完整组件与数量、组成指纹） */
  request: PriceRequest;
  /** 是否通过「报价对象核对」（false ⇒ 金额不得当"已核实"用） */
  verified: boolean;
  /** 复核返回的原始报价（供证据层引用） */
  quote: PriceResult | null;
  /** 与初次报价是否一致（null 表示无法比较） */
  consistent: boolean | null;
  note: string;
}

/**
 * 对**最终入选**的方案按实际组件清单再报一次价。
 *
 * 为什么必须做：初筛用的可能只是菜单价或较早的报价；用户真正看到的方案，
 * 必须有一份**当下**的官方报价 + 时刻 + 来源，否则"实时价格"四个字站不住。
 *
 * ⚠️ v3 整改（评审 R3/R4）：此前它只是「定义了、也有测试，但**从没被主流程调用**」，
 * 且把 `A×2 + B×3` 压成 `list[0].productCode`（数量与其余组件全丢）。
 * 现在：完整清单进请求、进收据、进指纹；并由 `recommendForMenu` **真正调用**。
 */
export async function requoteFinal(
  candidate: PricedCandidate,
  pricer: Pricer,
  /** 实际报价对象（套餐被替换后，这里应是替换后的组成）；缺省用候选自身 */
  components?: readonly PriceLine[],
): Promise<RequoteResult> {
  const request = requestOf(candidate.item, 'final', components);
  let attempt: PriceAttempt;
  try {
    attempt = await pricer(candidate.item, request);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return {
      price: null,
      receipt: {
        tool: 'calculate-price',
        argsSummary: buildArgsSummary(request.items),
        at: new Date().toISOString(),
        ok: false,
        attempt: 1,
        retries: 0,
        ...(err.code === undefined ? {} : { errorCode: err.code }),
        errorMessage: err.message ?? String(e),
        durationMs: 0,
        channel: 'live',
        stage: 'final',
        requestFingerprint: request.fingerprint,
      },
      request,
      verified: false,
      quote: null,
      consistent: null,
      note: '最终复核失败——该方案的价格须标为「未核实」，不得以菜单价充当实付价',
    };
  }

  // 收据以**本次请求**为准：完整清单 + 阶段 + 指纹（不再沿用 pricer 内部的单件摘要）
  const receipt: PriceReceipt = {
    ...attempt.receipt,
    argsSummary: buildArgsSummary(request.items),
    stage: 'final',
    requestFingerprint: request.fingerprint,
  };

  const verdict = attempt.quote ? verifyQuoteBasket(request, attempt.quote) : null;
  const basketOk = verdict?.status === 'matched';
  const pricePresent = Boolean(attempt.quote && attempt.quote.price !== null);
  const verified = pricePresent && basketOk;
  const after: Cents | null = verified ? (attempt.quote!.price as Cents) : null;
  const before = candidate.effectivePrice;
  const consistent = before === null || after === null ? null : before === after;

  return {
    price: after,
    receipt,
    request,
    verified,
    quote: attempt.quote,
    consistent,
    note: !pricePresent
      ? '复核未成功，价格来源降级为菜单价并须标注「未核实」'
      : !basketOk
        ? `复核响应未通过报价对象核对（${verdict?.detail ?? '无明细'}）——结果标为「未核实」`
        : consistent === true
          ? `复核一致（¥${toYuan(after as Cents).toFixed(2)}）`
          : consistent === false
            ? `复核与初次报价不同（¥${before === null ? '—' : toYuan(before).toFixed(2)} → ¥${after === null ? '—' : toYuan(after).toFixed(2)}），以复核价为准`
            : '复核成功，但初次报价缺失，无法比较',
  };
}

/**
 * 把最终复核结果落回候选：重算预算判定、价格来源与「已核实」标记。
 * （评审 C：复核变价后，预算/评分/解释都必须跟着变。）
 *
 * ⚠️ R12：复核**未通过**时，来源**不得**继续是 `official`——
 * 沿用初次金额可以，但必须降为 `official-unverified`（或 `menu`），
 * 否则展示层会把它渲染成「已核」。
 */
export function applyRequote(
  candidate: PricedCandidate,
  requote: RequoteResult,
  budgetCents: Cents,
): PricedCandidate {
  const effectivePrice = requote.price ?? candidate.effectivePrice;
  const hadOfficialPrice = candidate.priceSource === 'official' || candidate.quote !== null;
  const priceSource: PriceSource = requote.verified
    ? 'official'
    : hadOfficialPrice
      ? 'official-unverified'
      : 'menu';
  const overByCents =
    effectivePrice === null ? Number.POSITIVE_INFINITY : Math.max(0, effectivePrice - budgetCents);
  const failureNote = requote.verified
    ? `最终复核：${requote.note}`
    : `最终复核：${requote.note}` +
      `（沿用初次金额时仅作参考——**未核实，不代表当前实付**，来源标记 ${priceSource}）`;
  return {
    ...candidate,
    quote: requote.quote ?? candidate.quote,
    receipt: requote.receipt,
    effectivePrice,
    priceSource,
    verified: requote.verified,
    withinBudget: effectivePrice !== null && effectivePrice <= budgetCents,
    overByCents,
    notes: [...candidate.notes, failureNote],
  };
}
