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

/**
 * 套餐子项的一轮（官方 `calculate-price` 的 `roundList` 元素）。
 *
 * ⚠️ 实测要点（2026-10-16，见 `docs/DECISION_NOTES.md`「10-16 追加 · O9」）：
 *   · `round` 必须传**轮次 id 的字符串形式**；传轮次**名**会被服务端拒为 `BUSINESS_FAILURE code=500`；
 *   · 带上默认组成与不带时**报价相同**（5050）；换成 +¥2 的选项则为 **5250**，−¥0.5 则为 **5000**。
 *     故「补上实际组成」既不改动既有结果，又让替换后的价格**真的随之变化**。
 */
export interface RoundLine {
  round: string;
  comboItemList: { code: string; quantity: number }[];
}

/** 一条报价行（官方契约：**productCode** + quantity；套餐行可带 `roundList` 表达实际组成） */
export interface PriceLine {
  productCode: string;
  quantity: number;
  /** 套餐顶层行的**实际组成**——不给则官方按默认组成计价 */
  roundList?: readonly RoundLine[];
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
  /** 报价对象（套餐按其自身码**整体报价**，不拆成单品相加；但**带上实际组成**，见 `roundList`） */
  items: readonly PriceLine[];
  /** **期望组成**（来自结构化组件）——留痕用，与「实发载荷」分开记录，便于逐项对照 */
  composition?: readonly PriceLine[];
  /**
   * ⚠️ 语义已收窄（v3.7.1）：**等于 `payloadFingerprint`**（实发载荷指纹）。
   * 保留旧名仅为兼容既有调用方；新代码请优先读下面两个显式字段。
   */
  fingerprint: string;
  /**
   * **实发载荷**的指纹（`items` ＋ `roundList`）。
   *
   * 为什么要与「期望组成」拆开：v3.7.0 曾把组成算进指纹、却**没把组成发进请求**，
   * 于是出现「指纹是组成专属的、报价却不是组成专属的」这一审计错位（复评 P1）。
   * 现在二者各记各的，任何一个变了都能一眼看出是**哪一边**变了。
   */
  payloadFingerprint: string;
  /** **期望组成**的指纹（由组件规范化而来）——与 `payloadFingerprint` 对照即知是否真的送出去了 */
  desiredCompositionFingerprint: string;
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
  /** 官方**业务错误码**（如限流的 508）；仅业务失败时存在，供证据核对 */
  businessCode?: number;
  /** 失败说明（客户端保证已脱敏） */
  errorMessage?: string;
  /** 成功响应内容的 SHA-256 前 12 位（可用于交叉核对"当时到底返回了什么"） */
  responseHash?: string;
  durationMs: number;
  /** 渠道（**必须如实**：它决定"离线=0 次真实请求"这句话能不能站住） */
  channel?: ReceiptChannel;
  /** 报价阶段 */
  stage?: PriceStage;
  /** **实发载荷**的指纹（items ＋ roundList）——与缓存标识一致 */
  requestFingerprint?: string;
  /** **实发载荷**的指纹（显式字段；与 `requestFingerprint` 同值，便于对照阅读） */
  payloadFingerprint?: string;
  /** **期望组成**的指纹——与 `payloadFingerprint` 并置，即可看出"想换的"与"真发出去的"是否一致 */
  desiredCompositionFingerprint?: string;
  /**
   * **期望组成的人可读记录**（如 `1:511781 ; 2:4810 ; 3:3100`）。
   * 与 `argsSummary`（实发载荷）并置，是复评 P1 要求的三件套之一：
   * **期望组成 / 实际发送载荷 / 响应核对结果**。
   */
  desiredComposition?: string;
}

/**
 * 收据里的「**期望组成 / 实发载荷 / 载荷指纹**」三件套——统一构造，避免逐个写入点漏写。
 *
 * 复评 P1 明确要求：收据必须能同时回答三个问题——
 *   ① 我**想**要什么组成？（`desiredComposition`，来自组件）
 *   ② 我**实际发给服务端**的是什么？（收据的 `argsSummary`，来自 `items`＋`roundList`）
 *   ③ 服务端返回的核对结果？（既有 `ok`／报价对象核对字段）
 * 三者并置，任何一侧「没跟上」都能一眼看出来。
 */
export function receiptCompositionOf(request: PriceRequest): Pick<
  PriceReceipt,
  'requestFingerprint' | 'payloadFingerprint' | 'desiredCompositionFingerprint' | 'desiredComposition'
> {
  const comp = request.composition ?? [];
  return {
    requestFingerprint: request.fingerprint,
    payloadFingerprint: request.payloadFingerprint,
    desiredCompositionFingerprint: request.desiredCompositionFingerprint,
    ...(comp.length > 0
      ? { desiredComposition: comp.map((l) => `${l.productCode}×${l.quantity}`).join(' ; ') }
      : {}),
  };
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
 *
 * ⚠️ v3.7.1 复评 P1 新增第四态 `menu-adjusted-unverified`：
 *   「菜单价 ＋ **已知的**替换价差」这一推算值。此前官方计价失败时直接回退**未调整**的菜单价
 *   （`effectivePrice = item.price`），于是「菜单价 ¥28、已知 +¥2、预算 ¥29」仍被判**预算内**——
 *   明知价差却拿它去过硬预算闸门，两句话不能同时成立。现改为：
 *     · 全部被选组件的价差都拿到了 → 用**调整后菜单价**（本来源），并标明不是官方实付；
 *     · 任一价差缺失 → **价格视为未知**（`effectivePrice=null`、`withinBudget=false`），不进预算内方案；
 *     · 官方明确「不可售」（如业务码 60006）→ 直接**移出可行集**（见 `PricedCandidate.unavailable`）。
 *
 * ⚠️ v3.7.3 复评 P2-2：第四态的触发条件由「价差合计 ≠ 0」修正为「**组成确有变化**」
 *   （即存在 `isDefault === false` 的非默认项）——**±¥0 的非默认替换同样是替换**。
 */
export type PriceSource =
  | 'official'
  | 'menu'
  | 'official-unverified'
  | 'menu-adjusted-unverified';

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
  /**
   * 官方**明确判定该组成不可售**（如业务码 60006「商品已售罄或不可售」）。
   * 这类候选**不是"实付未核实"，而是"买不到"**——必须移出可行集，
   * 既不作方案、也不作「最接近预算」的备选（复评 v3.7.1 · P1）。
   */
  unavailable: boolean;
  /** 金额依据的人可读描述（如「菜单价 ＋ 可乐大杯 +¥2.00」）——只在非官方价时出现 */
  priceBasis?: string;
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
  /** **未纳入可行集**的候选及原因（不可售 / 价格未知）——如实列出，不静默丢弃 */
  excluded: ExcludedCandidate[];
}

/** 被移出可行集的候选（复评 v3.7.1 · P1） */
export interface ExcludedCandidate {
  name: string;
  code: string;
  /** `unavailable`＝官方判定不可售；`unknown-price`＝官方计价未取得且替换价差不全 */
  kind: 'unavailable' | 'unknown-price';
  detail: string;
}

/** 一次报价的产出：结果 + 收据 */
export interface PriceAttempt {
  quote: PriceResult | null;
  receipt: PriceReceipt;
}

/**
 * 计价器：给定候选（与可选的完整报价请求），返回报价结果与收据。
 *
 * ⚠️ **调用契约（v3.7.3 · 复评 P2-1）**：`Pricer` 是导出的，核心层**不假定**调用方
 * 只会返回自洽结果。若实现返回 `receipt.ok === false` 却同时带 `quote`，
 * 该 `quote` 一律**不被采纳**（只作诊断），并由 `normalizePriceAttempt` 生成明确诊断。
 */
export type Pricer = (item: AnalyzedItem, request?: PriceRequest) => Promise<PriceAttempt>;

/** 便于测试与调用方构造一个"成功收据"；**逐字反映实发载荷**（含套餐组成） */
export function buildArgsSummary(items: readonly PriceLine[]): string {
  const lines = items.map((i) => `${i.productCode}×${i.quantity}`).join(',');
  const rounds = items
    .filter((i) => (i.roundList?.length ?? 0) > 0)
    .flatMap((i) =>
      (i.roundList ?? []).map(
        (r) => `${r.round}:${r.comboItemList.map((c) => `${c.code}×${c.quantity}`).join('+')}`,
      ),
    );
  return rounds.length > 0 ? `items=[${lines}] roundList=[${rounds.join(' ; ')}]` : `items=[${lines}]`;
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

/** 默认报价对象：按其自身码整体报价（套餐不拆件相加），**并带上实际组成** */
export function basketOf(item: AnalyzedItem): PriceLine[] {
  const roundList = roundListOf(item);
  return [
    {
      productCode: item.code,
      quantity: 1,
      ...(roundList.length > 0 ? { roundList } : {}),
    },
  ];
}

/**
 * 由结构化组件构造官方 `roundList`——**这是「组成变了，计价请求也跟着变」的落点**。
 *
 * `round` 取**轮次 id 的字符串**（实测：传名称会被服务端拒为 500，见 `RoundLine` 注释）。
 * 组件缺 `roundId` 的旧数据一律跳过；此时退化为「不带组成」的请求（如实记录，不假装带了）。
 */
export function roundListOf(item: AnalyzedItem): RoundLine[] {
  const comps = item.components ?? [];
  if (comps.length === 0) return [];
  /*
   * ⚠️ 只在**组成与默认不同**时才带 `roundList`（2026-10-16 实测所定，见 DECISION_NOTES「O9」）：
   *   · 未替换（全部为默认项）⇒ 不带 —— 与 v3.7.0 行为逐字一致，**既有官方核价覆盖面零回归**；
   *   · 已替换（存在非默认项）⇒ 带上 —— 让「组成变了，计价请求也跟着变」真正成立。
   *
   * 为什么不一律带上：实测同一套餐，仅顶层码时报 ✓（如 12750），
   * **带上 roundList 反被服务端以 `60006 商品已售罄或不可售` 拒绝**（BFF四宫格小食盘双人餐、
   * 全明星双人分享餐八件套 两个套餐复现）。一律带上会**凭空损失官方核价覆盖面**，
   * 那是拿覆盖面换一致性，得不偿失。
   */
  if (comps.every((c) => c.isDefault !== false)) return [];

  const byRound = new Map<number, { code: string; quantity: number }[]>();
  for (const c of comps) {
    const roundId = c.roundId;
    // 缺轮次 id（合成/历史/无详情）⇒ 跳过；**不猜一个 id 顶上**
    if (roundId === undefined || !Number.isFinite(roundId)) continue;
    const arr = byRound.get(roundId) ?? [];
    arr.push({ code: c.choiceCode, quantity: c.quantity > 0 ? c.quantity : 1 });
    byRound.set(roundId, arr);
  }
  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, comboItemList]) => ({ round: String(round), comboItemList }));
}

/** 期望组成（来自结构化组件）——留痕用；**不用于拆价** */
export function compositionOf(item: AnalyzedItem): PriceLine[] {
  return (item.components ?? []).map((c) => ({
    productCode: c.choiceCode,
    quantity: c.quantity > 0 ? c.quantity : 1,
  }));
}

/**
 * 构造一次完整报价请求。
 * @param items 显式给定的报价对象；未给则用候选自身（套餐整体 + 实际组成）
 *
 * 指纹**分两个**：`payloadFingerprint`（实发载荷）与 `desiredCompositionFingerprint`（期望组成）。
 * `fingerprint` 保留为前者，缓存键据此判定（缓存必须按**实发载荷**区分，否则会把
 * 「未带组成的报价」当成「带组成的报价」复用）。
 */
export function requestOf(
  item: AnalyzedItem,
  stage: PriceStage,
  items?: readonly PriceLine[],
): PriceRequest {
  const lines = items && items.length > 0 ? items : basketOf(item);
  const composition = compositionOf(item);
  const payloadFingerprint = fingerprintOf(lines);
  const desiredCompositionFingerprint = fingerprintOf(composition);
  return {
    items: lines,
    ...(composition.length > 0 ? { composition } : {}),
    fingerprint: payloadFingerprint,
    payloadFingerprint,
    desiredCompositionFingerprint,
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

// ─────────────── 计价失败的语义分流与「调整后菜单价」（v3.7.1 复评 P1） ───────────────

/**
 * 计价失败的语义分类。**这两类不能混为一谈**：
 *   · `unavailable` —— 官方明确说「这个组成买不到」（已售罄/不可售/已下架）。
 *                      它不是"价格未核实"，而是**可售性已否定** ⇒ 移出可行集；
 *   · `unknown`     —— 超时 / 限流 / 网络 / 未发起请求：**价格与可售性都不知道**。
 *                      此时可以用「菜单价 ＋ 已知价差」做**明示为推算**的比较，
 *                      但**价差不全就不得比较**（宁可说不知道，不得用偏低的价格过闸门）。
 */
export type PriceFailureKind = 'unavailable' | 'unknown';

/**
 * 「官方判定不可售」的业务码白名单。
 * `60006` 为**实测**所得：本地菜单快照与门店实时商品列表偏离时，带 `roundList` 的组成报价被拒，
 * 报文即「商品已售罄或不可售」（见 `docs/DECISION_NOTES.md` 的 O4/O9 与复评 P1 整改节）。
 */
const UNAVAILABLE_BUSINESS_CODES: readonly number[] = [60006];

/** 业务码缺失时的**辅助**判据（报文含义）。刻意收窄，避免误伤。 */
const UNAVAILABLE_TEXT = /(已售罄|不可售|已下架|已停售|无法购买)/;

/** 把一次失败的收据分流成 `unavailable` / `unknown`；`ok=true` 返回 null */
export function classifyPriceFailure(receipt: PriceReceipt): PriceFailureKind | null {
  if (receipt.ok) return null;
  if (typeof receipt.businessCode === 'number' && UNAVAILABLE_BUSINESS_CODES.includes(receipt.businessCode)) {
    return 'unavailable';
  }
  if (UNAVAILABLE_TEXT.test(receipt.errorMessage ?? '')) return 'unavailable';
  return 'unknown';
}

/**
 * 报价尝试的**规范化与不变量检查**（v3.7.3 · 复评 P2-1）。
 *
 * 不变量：**状态真值优先于载荷中碰巧存在的字段**——
 * 一份 `receipt.ok === false` 的失败回执，**不得**同时被当作可采信的报价。
 *
 * 为什么要有这一件：`Pricer` 是**导出的调用契约**，核心层不能假定每个调用方
 * 都构造不出「失败回执 + 残留报价」这种矛盾结果（内置 `McpClient` 在业务失败时通常抛错，
 * 反而掩盖了这一理论暴露面）。此处把矛盾**显式化**：残留 `quote` 仍留在 `attempt.quote`
 * 里**仅供诊断**，但 `confirmPrices` / `requoteFinal` 一律**先看 `receipt.ok`**，永不采纳它。
 */
export interface NormalizedPriceAttempt {
  /** 规范化后的尝试（残留报价仍在 `quote`，**仅作诊断**） */
  attempt: PriceAttempt;
  /** 若发现 `receipt.ok === false && quote != null` 这一矛盾输入，给出明确诊断；否则为 undefined */
  contradiction?: string;
}

/** 见 `NormalizedPriceAttempt`——**失败回执就是失败**，残留报价只作诊断，不得采纳为官方价。 */
export function normalizePriceAttempt(attempt: PriceAttempt): NormalizedPriceAttempt {
  const { receipt, quote } = attempt;
  if (receipt.ok || quote === null || quote === undefined) return { attempt };
  const why =
    receipt.businessCode !== undefined
      ? `业务码 ${receipt.businessCode}`
      : (receipt.errorCode ?? '未给出错误码');
  const shown =
    quote.price === null || quote.price === undefined
      ? '报价字段为 `null`'
      : `报价字段为 ¥${toYuan(quote.price).toFixed(2)}`;
  return {
    attempt,
    contradiction:
      `**矛盾输入**：报价回执为**失败**（${why}${receipt.errorMessage === undefined ? '' : `：${receipt.errorMessage}`}）` +
      `，却同时带有${shown}。按「状态真值优先于载荷中碰巧存在的字段」——` +
      `**失败回执就是失败**，该残留报价**仅作诊断，不得采纳为官方价**。`,
  };
}

/**
 * 「调整后菜单价」的推算结果。
 *
 * ⚠️ v3.7.3 复评 P2-2：**「金额是否改变」与「组成是否改变」是两件事**，必须分开表达。
 * 旧实现只有 `adjustment`，调用方便以「价差合计是否为 0」代替「组成是否变化」，
 * 于是「小食 → 小杯玉米杯（±¥0）」这类**真实替换**被写成「菜单价（组成与默认一致）」，
 * 价源也退回普通 `menu`——金额没错，**证据语义错了**。
 */
export interface AdjustedMenuPrice {
  /** 调整后菜单价（分） */
  cents: Cents;
  /** 相加的替换价差合计（分）；**0 不等于「组成与默认一致」**（见 `compositionChanged`） */
  adjustment: Cents;
  /**
   * **组成是否真的变了**——**只由「是否存在 `isDefault === false` 的非默认项」决定**，
   * 与价差数值无关。（±¥0 的非默认替换同样是替换。）
   */
  compositionChanged: boolean;
  /** 人可读依据（如「菜单价 ＋ 小杯玉米杯 ±¥0.00」；无替换项时为「菜单价（组成与默认一致）」） */
  basis: string;
}

/**
 * 按「菜单价 ＋ Σ(已选非默认项的官方价差 × 数量)」推算调整后菜单价。
 *
 * **只在每一处与默认不同的选项都拿到了价差时才给值**；任一缺失即返回 `null`
 * （`null` 的语义是「价格未知」，调用方**不得**退回原菜单价去过硬预算）。
 * 组成与默认一致（无替换项）时返回金额即菜单价、`adjustment=0`、`compositionChanged=false`。
 *
 * ⚠️ v3.7.3 复评 P2-2：**±¥0 的非默认替换同样是替换**。
 * 旧实现用「价差合计是否为 0」代替「组成是否变化」，于是「小食 → 小杯玉米杯（`diffPrice=0`）」
 * 被写成「菜单价（组成与默认一致）」、价源退回普通 `menu`。金额（¥28）没算错，
 * 但**证据语义错了**：官方计价失败时，用户无从看出一套**替换过、且可售性未确认**的组成。
 * 现改为：**非默认项（含 ±¥0）一律列出**，`compositionChanged` 只由 `isDefault` 决定。
 */
export function adjustedMenuPriceOf(item: AnalyzedItem): AdjustedMenuPrice | null {
  if (item.price === null || !Number.isFinite(item.price)) return null;
  const comps = item.components ?? [];
  let adjustment = 0;
  let compositionChanged = false;
  const parts: string[] = [];
  const missing: string[] = [];

  for (const c of comps) {
    // 默认项：其相对默认的价差恒为 0（菜单价已含），无须价差数据
    if (c.isDefault === true) continue;
    // 走到这里 ⇒ 这是一个**非默认项**：组成已变，**与价差是否为 0 无关**
    compositionChanged = true;
    const qty = c.quantity > 0 ? c.quantity : 1;
    if (typeof c.diffPrice !== 'number' || !Number.isFinite(c.diffPrice)) {
      missing.push(`「${c.roundName} → ${c.choiceName}」`);
      continue;
    }
    adjustment += c.diffPrice * qty;
    // ±¥0 也要列出：它是「发生过替换」的证据，不能因为金额为零而隐去（复评 P2-2 要求 ②）
    const sign = c.diffPrice > 0 ? '+' : c.diffPrice < 0 ? '−' : '±';
    const abs = (Math.abs(c.diffPrice) * qty) / 100;
    parts.push(`${c.choiceName}${qty > 1 ? `×${qty}` : ''} ${sign}¥${abs.toFixed(2)}`);
  }

  if (missing.length > 0) return null;

  const cents = (item.price + adjustment) as Cents;
  return {
    cents,
    adjustment: adjustment as Cents,
    compositionChanged,
    basis: compositionChanged ? `菜单价 ＋ ${parts.join(' ＋ ')}` : '菜单价（组成与默认一致）',
  };
}

/**
 * 推算值的价源：
 *   · **组成有变**（含 ±¥0 的非默认替换）⇒ `menu-adjusted-unverified`——
 *     官方实付未取得，且该替换组成的**可售性也未确认**；
 *   · **组成未变**（金额即菜单价）⇒ 沿用 `menu`。
 *
 * **不由价差合计是否为 0 决定**（v3.7.3 复评 P2-2 要求 ③）。
 */
function sourceOfAdjusted(adj: AdjustedMenuPrice): PriceSource {
  return adj.compositionChanged ? 'menu-adjusted-unverified' : 'menu';
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
        ...receiptCompositionOf(request),
      };
      // 未发起 ≠ 价格＝菜单价：若该候选带替换，数字必须按**调整后菜单价**给，否则就是用偏低值过闸门
      const adj = fallback ? adjustedMenuPriceOf(item) : null;
      const skippedNotes = [`未发起官方计价（${reason}），如展示须标「未核实实付」`];
      // ⚠️ 判据按**组成**（`compositionChanged`）而非按价差是否为 0（v3.7.3 复评 P2-2）
      if (adj && adj.compositionChanged) {
        skippedNotes.push(`该候选含替换项，金额按**调整后菜单价**推算（${adj.basis}）——**不是官方实付，也未确认该替换组成可售**`);
      } else if (adj) {
        skippedNotes.push('金额为菜单价（无替换项，与调整后菜单价同值）——**未核实实付**');
      } else {
        skippedNotes.push(
          '替换价差**不完整**，调整后菜单价无法推算 ⇒ **价格未知**，不参与预算判定（不退回原菜单价充数）',
        );
      }
      return {
        item,
        quote: null,
        receipt,
        effectivePrice: adj ? adj.cents : null,
        priceSource: adj ? sourceOfAdjusted(adj) : 'menu',
        ...(adj ? { priceBasis: adj.basis } : {}),
        unavailable: false,
        withinBudget: adj !== null && adj.cents <= budgetCents,
        overByCents: adj === null ? Number.POSITIVE_INFINITY : Math.max(0, adj.cents - budgetCents),
        notes: skippedNotes,
        verified: false,
      };
    }

    state.requests++;
    let attempt: PriceAttempt;
    try {
      // ⚠️ 完整报价请求随行：组件与数量不再丢失（评审 R4）
      attempt = await pricer(item, request);
    } catch (e) {
      const err = e as { code?: string; message?: string; businessCode?: number };
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
          ...(err.businessCode === undefined ? {} : { businessCode: err.businessCode }),
          errorMessage: err.message ?? String(e),
          durationMs: 0,
          channel: 'live',
          stage: 'initial',
          ...receiptCompositionOf(request),
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
    let priceSource: PriceSource = 'menu';
    let priceBasis: string | undefined;
    let verified = false;
    let unavailable = false;

    // ⚠️ v3.7.3 · 复评 P2-1：先做**不变量检查**——「失败回执 + 残留报价」是矛盾输入，
    //    必须显式诊断，且其 `quote` 字段**绝不**被采纳（残留报价只作诊断）。
    const { contradiction } = normalizePriceAttempt(attempt);
    if (contradiction !== undefined) itemNotes.push(contradiction);

    // 报价对象核对（评审 R9）：拿不到逐项清单 / 商品或数量不符 ⇒ 不能算"已核实"
    const verdict = attempt.quote ? verifyQuoteBasket(request, attempt.quote) : null;
    const pricePresent = Boolean(attempt.quote && attempt.quote.price !== null);
    const basketOk = verdict?.status === 'matched';

    // 官方失败时的降级依据：**调整后菜单价**（菜单价 ＋ 已知替换价差）。
    // null ⇒ 替换价差不全 ⇒ 价格未知（**绝不退回原菜单价充数**）。
    const adj = fallback ? adjustedMenuPriceOf(item) : null;
    const failureKind = classifyPriceFailure(attempt.receipt);

    // ⚠️ 官方价的**必要条件（三者缺一不可）**：
    //    ① `receipt.ok === true`——**失败回执就是失败**，即便它残留了报价字段（v3.7.3 复评 P2-1）；
    //    ② 官方给出价格（合法的 0 元照用：0 元 ≠ 没报价）；
    //    ③ 报价对象核对得上。
    const adoptOfficial = attempt.receipt.ok && pricePresent && basketOk;

    if (adoptOfficial) {
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
    } else if (failureKind === 'unavailable') {
      // 官方**明确否定可售性**：这不是"实付未核实"，而是"买不到" ⇒ 移出可行集
      unavailable = true;
      itemNotes.push(
        `官方判定该组成**不可售**（${attempt.receipt.businessCode === undefined ? '' : `业务码 ${attempt.receipt.businessCode}：`}` +
          `${attempt.receipt.errorMessage ?? '无说明'}）——**移出可行集**：既不作方案，也不作「最接近预算」的备选`,
      );
    } else if (attempt.receipt.ok && pricePresent) {
      // 回执**成功**、也给了价格字段，但报价对象核对不上 → **拒绝采纳**，不得据此说"已核实"
      itemNotes.push(
        `官方响应**未通过报价对象核对**（${verdict?.detail ?? '无明细'}）：不采纳该金额`,
      );
      if (adj) {
        effectivePrice = adj.cents;
        priceSource = sourceOfAdjusted(adj);
        priceBasis = adj.basis;
        itemNotes.push(
          adj.compositionChanged
            ? `金额改按**调整后菜单价**推算（${adj.basis}）——**不是官方实付，也未确认该替换组成可售**`
            : '金额改按**菜单价**计（无替换项）——**未核实实付**',
        );
      } else {
        itemNotes.push('调整后菜单价无法推算（替换价差不全）⇒ **价格未知**，不参与预算判定');
      }
    } else if (adj) {
      // 走到这里含两种情形：① 失败回执（含残留报价——其报价已被上面的不变量检查否掉）；
      // ② 回执成功但官方没给价格字段（`price === null`）。
      effectivePrice = adj.cents;
      priceSource = sourceOfAdjusted(adj);
      priceBasis = adj.basis;
      if (adj.compositionChanged) {
        // 组成有变（**含 ±¥0 的非默认替换**）⇒ 官方实付未取得，且该替换组成的可售性未确认
        itemNotes.push(
          `官方计价未取得（${attempt.receipt.errorCode ?? '未知原因'}），金额按**调整后菜单价**推算（${adj.basis}）` +
            `——**不是官方实付，也未确认该替换组成可售**，且**已把已知价差计入预算判定**`,
        );
      } else {
        itemNotes.push(
          `官方计价未取得（${attempt.receipt.errorCode ?? '未知原因'}），暂以菜单价计——**未核实实付**`,
        );
      }
    } else {
      itemNotes.push(
        '价格未知：官方计价未取得，且替换价差**不完整**（无从推算调整后菜单价）——不参与预算判定，也不列为可购买方案',
      );
    }

    const overByCents =
      unavailable || effectivePrice === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, effectivePrice - budgetCents);

    done++;
    options.onProgress?.(done, candidates.length);

    return {
      item,
      quote: attempt.quote,
      receipt: attempt.receipt,
      effectivePrice: unavailable ? null : effectivePrice,
      priceSource: unavailable ? 'menu' : priceSource,
      ...(unavailable || priceBasis === undefined ? {} : { priceBasis }),
      unavailable,
      withinBudget: !unavailable && effectivePrice !== null && effectivePrice <= budgetCents,
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

  // ⚠️ v3.7.1 复评 P1：**可行集先做可售性与价格可知性分流**，再谈预算与排序。
  //    不可售者不是"备选"，价格未知者也不是"预算内"——两者都不得进入方案池。
  const unavailableOnes = results.filter((p) => p.unavailable);
  const unknownPriceOnes = results.filter((p) => !p.unavailable && p.effectivePrice === null);
  const feasible = results.filter((p) => !p.unavailable && p.effectivePrice !== null);

  const excluded: ExcludedCandidate[] = [
    ...unavailableOnes.map((p) => ({
      name: p.item.name,
      code: p.item.code,
      kind: 'unavailable' as const,
      detail:
        `官方判定该组成不可售（${p.receipt.businessCode === undefined ? '' : `业务码 ${p.receipt.businessCode}：`}` +
        `${p.receipt.errorMessage ?? '无说明'}）`,
    })),
    ...unknownPriceOnes.map((p) => ({
      name: p.item.name,
      code: p.item.code,
      kind: 'unknown-price' as const,
      detail: '官方计价未取得，且替换价差不全 ⇒ 调整后菜单价无法推算（**不用原菜单价充数**）',
    })),
  ];

  const within = feasible.filter((p) => p.withinBudget);

  let nearestOver: PricedCandidate | null = null;
  if (within.length === 0 && feasible.length > 0) {
    const overable = feasible.filter((p) => Number.isFinite(p.overByCents));
    nearestOver = overable.slice().sort((a, b) => a.overByCents - b.overByCents)[0] ?? null;
    if (nearestOver) {
      notes.push(
        `所有候选均超出预算。最接近的是「${nearestOver.item.name}」，` +
          `超出 ¥${toYuan(nearestOver.overByCents as Cents).toFixed(2)}——**需你明确同意后才纳入考虑**。`,
      );
    }
  }

  if (unavailableOnes.length > 0) {
    notes.push(
      `有 ${unavailableOnes.length} 个候选被官方**判定不可售** ⇒ 已移出可行集（不作方案、也不作备选）：` +
        unavailableOnes.map((p) => `「${p.item.name}」`).join('、'),
    );
  }
  if (unknownPriceOnes.length > 0) {
    notes.push(
      `有 ${unknownPriceOnes.length} 个候选**价格未知**（官方计价未取得且替换价差不全）` +
        `⇒ **未纳入预算判定**，也不列为可购买方案：` +
        unknownPriceOnes.map((p) => `「${p.item.name}」`).join('、'),
    );
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

  return { within, nearestOver, notes, receipts: results.map((r) => r.receipt), summary, excluded };
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
    const err = e as { code?: string; message?: string; businessCode?: number };
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
        ...(err.businessCode === undefined ? {} : { businessCode: err.businessCode }),
        errorMessage: err.message ?? String(e),
        durationMs: 0,
        channel: 'live',
        stage: 'final',
        ...receiptCompositionOf(request),
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
    ...receiptCompositionOf(request),
  };

  // ⚠️ v3.7.3 · 复评 P2-1：复核价的采纳同样要过 `receipt.ok` 这一关——
  //    「失败回执 + 残留报价」不得被当成本次复核的实付价（与 `confirmPrices` 同一不变量）。
  const { contradiction } = normalizePriceAttempt(attempt);
  const verdict = attempt.quote ? verifyQuoteBasket(request, attempt.quote) : null;
  const basketOk = verdict?.status === 'matched';
  const pricePresent = Boolean(attempt.quote && attempt.quote.price !== null);
  const verified = attempt.receipt.ok && pricePresent && basketOk;
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
    note: !attempt.receipt.ok
      ? `${contradiction === undefined ? '' : `${contradiction} `}` +
        `复核请求**失败**（${attempt.receipt.businessCode === undefined ? (attempt.receipt.errorCode ?? '未知原因') : `业务码 ${attempt.receipt.businessCode}`}）` +
        `——本次复核**未取得可信价格**，结果标为「未核实」`
      : !pricePresent
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
  // ① 复核被官方**明确否定可售性** ⇒ 撤下（连备选都不作）
  if (classifyPriceFailure(requote.receipt) === 'unavailable') {
    return {
      ...candidate,
      quote: requote.quote ?? candidate.quote,
      receipt: requote.receipt,
      effectivePrice: null,
      priceSource: 'menu',
      priceBasis: undefined,
      unavailable: true,
      verified: false,
      withinBudget: false,
      overByCents: Number.POSITIVE_INFINITY,
      notes: [
        ...candidate.notes,
        `最终复核：官方判定该组成**不可售**` +
          `（${requote.receipt.businessCode === undefined ? '' : `业务码 ${requote.receipt.businessCode}：`}` +
          `${requote.receipt.errorMessage ?? '无说明'}）⇒ 撤下，不作为可购买方案`,
      ],
    };
  }

  // ② 常规路径：复核价优先；复核未通过时按「初次是否拿到过经核对的官方价」降级
  const hadVerifiedOfficial = candidate.priceSource === 'official';
  const adj = adjustedMenuPriceOf(candidate.item);
  let effectivePrice = requote.price ?? candidate.effectivePrice;
  let priceSource: PriceSource;
  let priceBasis = candidate.priceBasis;

  if (requote.verified) {
    priceSource = 'official';
  } else if (hadVerifiedOfficial) {
    // 初次报价**已经过对象核对**（含 roundList 的官方组成价），仅复核未成功 ⇒ 沿用并降级
    priceSource = 'official-unverified';
  } else if (adj) {
    // 官方从未核实过该组成：只能用**调整后菜单价**（含已知价差），绝不退回未调整菜单价
    effectivePrice = adj.cents;
    priceSource = sourceOfAdjusted(adj);
    priceBasis = adj.basis;
  } else {
    // 价差不全 ⇒ 价格未知：撤出预算内（不退回原菜单价充数）
    effectivePrice = null;
    priceSource = 'menu';
    priceBasis = undefined;
  }

  const overByCents =
    effectivePrice === null ? Number.POSITIVE_INFINITY : Math.max(0, effectivePrice - budgetCents);
  const failureNote = requote.verified
    ? `最终复核：${requote.note}`
    : effectivePrice === null
      ? `最终复核：${requote.note}（**价格未知**：官方未核实且替换价差不全 ⇒ 不参与预算判定）`
      : hadVerifiedOfficial
        ? `最终复核：${requote.note}` +
          `（沿用初次官方金额仅作参考——**未核实，不代表当前实付**，来源标记 ${priceSource}）`
        : `最终复核：${requote.note}（金额为**调整后菜单价**${priceBasis ? `：${priceBasis}` : ''}` +
          `——**不是官方实付，也未确认可售**，来源标记 ${priceSource}）`;
  return {
    ...candidate,
    quote: requote.quote ?? candidate.quote,
    receipt: requote.receipt,
    effectivePrice,
    priceSource,
    ...(priceBasis === undefined ? {} : { priceBasis }),
    unavailable: false,
    verified: requote.verified,
    withinBudget: effectivePrice !== null && effectivePrice <= budgetCents,
    overByCents,
    notes: [...candidate.notes, failureNote],
  };
}
