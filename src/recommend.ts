/**
 * 三方案生成与去重（T2.4）
 *
 * 计划书 §6.4 的硬要求：
 *   「不要让『三张推荐卡』只因标题不同而展示同一个套餐。……
 *     若有效候选少于三项，**诚实展示 1～2 项**并说明原因，不人为造齐三项。」
 *
 * 三种「不同目标」的选择口径（按 §6.4）：
 *   · **预算优先**——在可靠可比集合中价格较低；
 *   · **蛋白质优先**——在预算内、营养完整的候选中优先蛋白质（并列时看蛋白/价格比）；
 *   · **均衡优先**——按多指标加权（无单一极端偏好），并强调取舍。
 *
 * 三者按顺序挑选并**去重**：后一个若与已选重复，就退而取其次优。
 */

import type { AnalyzedItem } from './analyze.ts';
import type { ConstraintOutcome, MealRequest, Priority } from './constraints.ts';
import { applyHardConstraints, checkNonPriceConstraints } from './constraints.ts';
import type { PricedCandidate, PricingOutcome, Pricer } from './pricing.ts';
import { confirmPrices, requoteFinal, applyRequote, summarizeReceipts } from './pricing.ts';
import {
  buildScoreContext,
  paretoFront,
  scoreItem,
  type PriceResolver,
  type ScoreBreakdown,
} from './score.ts';
import { explainPlan, comparePlans, type Explanation } from './explain.ts';
import { toYuan, cents, type Cents } from './money.ts';

export interface Plan {
  key: Priority;
  label: string;
  priced: PricedCandidate;
  score: ScoreBreakdown;
  /** 选择该方案的一句话理由（由程序算出的数字组成） */
  reason: string;
  explanation: Explanation;
}

export interface Recommendation {
  /** 实际给出的方案（**可能少于 3 个**，此时 shortfallNote 非空） */
  plans: Plan[];
  /**
   * 首选方案的 key（= 用户本轮偏好）。**plans[0] 即首选**——
   * 评审 R10 要求 preference 必须真的改变输出顺序，而不是只印个标签。
   */
  primaryKey: Priority;
  /** 用户偏好含义的如实说明（避免「以为偏好生效了」） */
  primaryNote: string;
  /** 候选不足三项时的如实说明 */
  shortfallNote: string | null;
  /** 安全提示（声明过敏/需专业指导时非空，**不得忽略**） */
  safetyNotice: string | null;
  /** 预算全超时的备选说明 */
  overBudgetNote: string | null;
  notes: string[];
}

const LABELS: Record<Priority, string> = {
  budget: '预算优先',
  protein: '蛋白质优先',
  balance: '均衡优先',
};

/** 蛋白质/价格比（每元多少克）；价格缺失或为 0 时返回 null（**不用 0 冒充**） */
function proteinPerYuan(p: PricedCandidate): number | null {
  if (p.effectivePrice === null || p.effectivePrice <= 0) return null;
  const g = p.item.totals.protein.value;
  if (g === null) return null;
  return g / toYuan(p.effectivePrice);
}

export interface BuildRecommendationInput {
  outcome: ConstraintOutcome;
  pricing: PricingOutcome;
  req: MealRequest;
}

/**
 * 生成三方案。
 *
 * 口径（v3 整改后）：
 *   · **价格同源**：预算判定、评分归一化、帕累托、性价比与解释句，一律使用
 *     `PricedCandidate.effectivePrice`（官方实付优先，未取得才降级菜单价并标注）；
 *   · **偏好真的生效**：`preferences.priority` 决定**首选（plans[0]）**是哪一个视角，
 *     而不是只印一个标签（评审 R10）。
 */
export function buildRecommendation(input: BuildRecommendationInput): Recommendation {
  const { outcome, pricing, req } = input;
  const notes: string[] = [];
  const primary = req.preferences.priority;

  // 候选池：**仅预算内**者参与（全超时另走 overBudgetNote）
  const pool = pricing.within;

  // 本轮统一的「取价」口径——**唯一一处**决定分数跟着哪个价走
  const effectivePriceIndex = new Map<string, Cents | null>(
    pool.map((p) => [p.item.code, p.effectivePrice]),
  );
  const priceOf: PriceResolver = (i) => effectivePriceIndex.get(i.code) ?? i.price;

  const noPlanNote = `本轮偏好＝${LABELS[primary]}，但候选不足，未能给出任何方案。`;

  if (pool.length === 0) {
    return {
      plans: [],
      primaryKey: primary,
      primaryNote: noPlanNote,
      shortfallNote: '在预算内、且营养数据达标的候选中，**没有可用方案**。',
      safetyNotice: outcome.safetyNotice,
      overBudgetNote: pricing.nearestOver
        ? `所有候选均超出预算。最接近的是「${pricing.nearestOver.item.name}」，` +
          `超出 ¥${toYuan(pricing.nearestOver.overByCents as Cents).toFixed(2)}——**需你明确同意后才纳入考虑**。`
        : (pricing.notes.find((n) => n.includes('超出预算')) ?? null),
      notes: [
        ...notes,
        ...pricing.notes,
        `共评估 ${outcome.rejected.length} 项被硬约束排除，${outcome.dataInsufficient.length} 项因数据不足排除。`,
      ],
    };
  }

  // 归一化上下文基于全部预算内候选，且**与判定同用实付价**（评审 R5）
  const ctx = buildScoreContext(pool.map((p) => p.item), req, priceOf);

  // 帕累托前沿（价格 vs 蛋白质）——作为「可靠可比集合」的一种口径（同样用实付价）
  const front = new Set(
    paretoFront(pool.map((p) => p.item), (i) => [
      {
        key: 'price',
        value: priceOf(i) === null ? Number.POSITIVE_INFINITY : toYuan(priceOf(i) as Cents),
        higherIsBetter: false,
      },
      { key: 'protein', value: i.totals.protein.value ?? 0, higherIsBetter: true },
    ]).map((i) => i.code),
  );
  notes.push(
    `帕累托前沿（实付价↓ × 蛋白质↑）共 ${front.size} 项，供「均衡」口径参考；` +
      `本轮价格口径＝${pool.some((p) => p.priceSource === 'official') ? '官方实付价（未取得者用菜单价并标注）' : '菜单价（官方计价未取得，均标「未核实实付」）'}。`,
  );

  const taken = new Set<string>();
  const plans: Plan[] = [];

  /** 按比较器选一个尚未被占用的最优候选 */
  const pick = (comparator: (a: PricedCandidate, b: PricedCandidate) => number): PricedCandidate | undefined =>
    pool
      .filter((p) => !taken.has(p.item.code))
      .slice()
      .sort(comparator)[0];

  // ① 预算优先：价格最低；并列时取蛋白质高者
  const budgetPick = pick((a, b) => {
    const pa = a.effectivePrice ?? Number.POSITIVE_INFINITY;
    const pb = b.effectivePrice ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return (b.item.totals.protein.value ?? 0) - (a.item.totals.protein.value ?? 0);
  });
  if (budgetPick) {
    taken.add(budgetPick.item.code);
    plans.push(
      makePlan('budget', budgetPick, ctx, req, priceOf,
        budgetReason(budgetPick)),
    );
  }

  // ② 蛋白质优先：蛋白质最高；并列时取「蛋白/价格比」高者
  const proteinPick = pick((a, b) => {
    const ga = a.item.totals.protein.value ?? -1;
    const gb = b.item.totals.protein.value ?? -1;
    if (ga !== gb) return gb - ga;
    return (proteinPerYuan(b) ?? -1) - (proteinPerYuan(a) ?? -1);
  });
  if (proteinPick) {
    taken.add(proteinPick.item.code);
    const ratio = proteinPerYuan(proteinPick);
    plans.push(
      makePlan('protein', proteinPick, ctx, req, priceOf,
        `蛋白质 ${proteinPick.item.totals.protein.value}g 为候选最高` +
          (ratio === null ? '' : `（约 ${ratio.toFixed(1)} g/元）`)),
    );
  }

  // ③ 均衡优先：多指标加权最高
  const balancePick = pick((a, b) => {
    const sa = scoreItem(a.item, ctx, 'balance', undefined, priceOf).total;
    const sb = scoreItem(b.item, ctx, 'balance', undefined, priceOf).total;
    if (sb !== sa) return sb - sa;
    // 同分时优先落在帕累托前沿上的（取舍更干净）
    return Number(front.has(b.item.code)) - Number(front.has(a.item.code));
  });
  if (balancePick) {
    taken.add(balancePick.item.code);
    plans.push(
      makePlan('balance', balancePick, ctx, req, priceOf,
        '价格与蛋白质综合权衡，无单一极端偏好（详见分量明细）'),
    );
  }

  // ⭐ 偏好生效：把「本轮偏好」对应的那张提到最前（评审 R10 的甲案）
  const primaryIdx = plans.findIndex((p) => p.key === primary);
  if (primaryIdx > 0) {
    const [head] = plans.splice(primaryIdx, 1);
    plans.unshift(head!);
  }

  // 方案间互相对照（对比句挂在最后一张卡上，便于用户看取舍）
  if (plans.length >= 2) {
    const base = plans[plans.length - 1]!;
    const other = plans[0]!;
    base.explanation.statements.push('—— 与「' + other.label + '」对照 ——');
    base.explanation.statements.push(...comparePlans(base.priced, other.priced, energyOptions(req)));
  }

  const primaryNote =
    primaryIdx < 0
      ? `本轮偏好＝${LABELS[primary]}，但该视角在本轮候选中未生成独立方案（候选不足或去重后落空）——已如实少给，不张冠李戴。`
      : `本轮偏好＝${LABELS[primary]}：三张卡各对应一种视角，**首选（第 1 张）即按该偏好选出**，另两张供横向对照。`;

  // 诚实汇报：不足三项时说清为什么
  let shortfallNote: string | null = null;
  if (plans.length < 3) {
    shortfallNote =
      `仅给出 ${plans.length} 个方案（不足三项）。原因：` +
      `预算内且营养数据达标的候选共 ${pool.length} 项，` +
      `去重后无法再凑出第三个**真实不同**的方案——**本项目不人为造齐三项**。`;
  }

  return {
    plans,
    primaryKey: primary,
    primaryNote,
    shortfallNote,
    safetyNotice: outcome.safetyNotice,
    overBudgetNote: pricing.notes.find((n) => n.includes('超出预算')) ?? null,
    notes: [...notes, ...pricing.notes],
  };
}

/** 热量口径说明：**没有热量目标时不产生"更多即更优"的判断**（评审 P1-5） */
function energyOptions(req: MealRequest): { energyTargetKcal: number | null } {
  return { energyTargetKcal: req.preferences.energyTargetKcal ?? null };
}

/** 预算优先的理由文案——**价格未经核实时不得声称"实付最低"**（评审 P1-5） */
function budgetReason(p: PricedCandidate): string {
  if (p.effectivePrice === null) return '本轮候选中未取得可比价格';
  const amount = `¥${toYuan(p.effectivePrice).toFixed(2)}`;
  return p.priceSource === 'official' && p.verified
    ? `在预算内的候选中**官方实付最低**（${amount}，已核实）`
    : `在预算内的候选中**菜单价最低**（${amount}）——**实付未核实**，请以门店结算为准`;
}

function makePlan(
  key: Priority,
  priced: PricedCandidate,
  ctx: ReturnType<typeof buildScoreContext>,
  req: MealRequest,
  priceOf: PriceResolver,
  reason: string,
): Plan {
  const score = scoreItem(priced.item, ctx, key, undefined, priceOf);
  return {
    key,
    label: LABELS[key],
    priced,
    score,
    reason,
    explanation: explainPlan(priced, undefined, energyOptions(req)),
  };
}

/** 供上层：把所有被拒项按原因归类计数（便于如实展示） */
export function summarizeRejections(outcome: ConstraintOutcome): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of outcome.rejected) out[r.reason] = (out[r.reason] ?? 0) + 1;
  return out;
}

/**
 * 【推荐总入口】从「已分析的菜单」一路走到「三方案」。
 *
 * 完整链路（v3 整改后）：
 *   ① 硬约束过滤（**非价格条件先验**，菜单价预筛只影响价格条件）
 *   ② 对主候选池做官方计价
 *   ③ **若主池为空**（全被预算拦下），回头对「菜单价超预算」那批做官方计价，
 *      挑出「最接近且明确超出」的备选——实付可能因优惠更低，不能仅凭菜单价判死；
 *      **回补池同样要过非价格硬条件**（评审 R1：价格下降不得绕过最低蛋白/避糖）
 *   ④ 生成三方案（去重、按偏好定首选、不足则如实说明）
 *   ⑤ **最终复核**：对真正要展示的方案再报一次价；变价即重算预算/评分/解释，
 *      复核后超预算者**不得继续以「预算内」出现**（评审 R3/R4/R5）
 */
export async function recommendForMenu(
  items: readonly AnalyzedItem[],
  req: MealRequest,
  pricer: Pricer,
): Promise<{ recommendation: Recommendation; outcome: ConstraintOutcome; pricing: PricingOutcome }> {
  const outcome = applyHardConstraints(items, req);
  const budgetCents = Math.round(req.budgetCny * 100) as Cents;

  let pricing = await confirmPrices(outcome.accepted, budgetCents, pricer);

  // 主池没有任何「预算内」候选时，才回头救「菜单价超预算」那批
  if (pricing.within.length === 0 && outcome.overBudgetPrefilter.length > 0) {
    const retry = await confirmPrices(outcome.overBudgetPrefilter, budgetCents, pricer);

    // ⚠️ 回补池与主池**共用同一套非价格硬条件**（评审 R1）
    const rescued: PricedCandidate[] = [];
    const dropped: string[] = [];
    for (const p of retry.within) {
      const violation = checkNonPriceConstraints(p.item, req);
      if (violation) {
        dropped.push(`「${p.item.name}」：${violation.detail}`);
        continue;
      }
      rescued.push(p);
    }

    const receipts = [...pricing.receipts, ...retry.receipts];
    const mergedNotes = [...pricing.notes, ...retry.notes].filter((n) => !n.startsWith('本次共发起'));
    mergedNotes.push('（已对菜单价超预算者做官方计价复核）');
    if (dropped.length > 0) {
      mergedNotes.push(
        `回补复核否掉 ${dropped.length} 个候选——**价格下降不得绕过非价格硬条件**：${dropped.join('；')}`,
      );
    }
    if (rescued.length === 0) {
      mergedNotes.push('回补后仍无合格候选：**无解即明确无解，不自动放宽条件**。');
    }

    pricing = {
      within: rescued,
      nearestOver: retry.nearestOver,
      notes: [...mergedNotes, summarizeReceipts(receipts, rescued.filter((p) => p.verified).length).note],
      receipts,
      summary: summarizeReceipts(receipts, rescued.filter((p) => p.verified).length),
    };
  }

  // ④ 生成三方案
  let recommendation = buildRecommendation({ outcome, pricing, req });

  // ⑤ 最终复核——**真正执行**（此前 requoteFinal 只被定义与测试，主流程 0 处调用）
  recommendation = await finalizeWithRequote(recommendation, pricer, budgetCents, req);

  return { recommendation, outcome, pricing };
}

/**
 * 对最终入选方案做**最终官方复核**，并把结果落回卡片。
 *
 * 三条不可省：
 *   1. 复核失败/未通过对象核对 ⇒ 该方案价格标「未核实」，**不得以菜单价充当实付价**；
 *   2. 复核后超出预算 ⇒ 从「预算内方案」里撤下（评审 C：20→40 时不得仍以 20 元出现）；
 *   3. 变价后**重算评分与解释**，避免卡片上的分数与展示价对不上（评审 E）。
 */
async function finalizeWithRequote(
  recommendation: Recommendation,
  pricer: Pricer,
  budgetCents: Cents,
  req: MealRequest,
): Promise<Recommendation> {
  if (recommendation.plans.length === 0) return recommendation;

  const notes = [...recommendation.notes];
  const kept: PricedCandidate[] = [];
  const droppedNotes: string[] = [];

  for (const plan of recommendation.plans) {
    const requote = await requoteFinal(plan.priced, pricer);
    const priced = applyRequote(plan.priced, requote, budgetCents);

    const violation = checkNonPriceConstraints(priced.item, req);
    if (violation) {
      droppedNotes.push(`${plan.label}「${priced.item.name}」：${violation.detail}`);
      continue;
    }
    if (priced.effectivePrice !== null && priced.effectivePrice > budgetCents) {
      droppedNotes.push(
        `${plan.label}「${priced.item.name}」：最终复核实付 ¥${toYuan(priced.effectivePrice).toFixed(2)} 超出预算 ¥${req.budgetCny.toFixed(2)}`,
      );
      continue;
    }
    kept.push(priced);
  }

  notes.push(
    `已对 ${recommendation.plans.length} 个入选方案执行**最终官方复核**` +
      `（含完整组成指纹，见各方案收据 stage=final）。`,
  );
  if (droppedNotes.length > 0) {
    notes.push(
      `最终复核后撤下 ${droppedNotes.length} 个方案——**不以旧价充数**：${droppedNotes.join('；')}`,
    );
  }

  // 变价后重建上下文与评分：预算/评分/解释同用**复核后的价**
  const priceIndex = new Map<string, Cents | null>(kept.map((p) => [p.item.code, p.effectivePrice]));
  const priceOf: PriceResolver = (i) => priceIndex.get(i.code) ?? i.price;
  const ctx = buildScoreContext(kept.map((p) => p.item), req, priceOf);

  const plans: Plan[] = recommendation.plans
    .filter((p) => kept.some((k) => k.item.code === p.priced.item.code))
    .map((p) => {
      const priced = kept.find((k) => k.item.code === p.priced.item.code)!;
      return {
        ...p,
        priced,
        score: scoreItem(priced.item, ctx, p.key, undefined, priceOf),
        reason: p.key === 'budget' ? budgetReason(priced) : p.reason,
        explanation: explainPlan(priced, undefined, energyOptions(req)),
      };
    });

  // 复核会丢弃旧的对照句，这里在最后一张卡上补回（口径一致）
  if (plans.length >= 2) {
    const base = plans[plans.length - 1]!;
    const other = plans[0]!;
    base.explanation.statements.push('—— 与「' + other.label + '」对照 ——');
    base.explanation.statements.push(...comparePlans(base.priced, other.priced, energyOptions(req)));
  }

  let shortfallNote = recommendation.shortfallNote;
  if (plans.length < recommendation.plans.length) {
    shortfallNote =
      `最终复核后有 ${recommendation.plans.length - plans.length} 个方案不再成立（原因见「推导过程」），` +
      `故仅给出 ${plans.length} 个方案——**不拿复核前的旧价充数**。`;
  }

  return { ...recommendation, plans, shortfallNote, notes };
}

/** 应用默认预算（供测试与演示） */
export const DEFAULT_BUDGET_CENTS = (yuan: number): Cents => cents(Math.round(yuan * 100));

export type { AnalyzedItem, PricedCandidate };
