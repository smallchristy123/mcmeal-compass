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
import { applyHardConstraints } from './constraints.ts';
import type { PricedCandidate, PricingOutcome, Pricer } from './pricing.ts';
import { confirmPrices } from './pricing.ts';
import { buildScoreContext, paretoFront, scoreItem, type ScoreBreakdown } from './score.ts';
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
 * @param input 约束结果 + 计价结果 + 原始请求
 */
export function buildRecommendation(input: BuildRecommendationInput): Recommendation {
  const { outcome, pricing, req } = input;
  const notes: string[] = [];

  // 候选池：**仅预算内**者参与（全超时另走 overBudgetNote）
  const pool = pricing.within;

  if (pool.length === 0) {
    return {
      plans: [],
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

  // 归一化上下文基于全部预算内候选，保证三个方案的分数量纲一致
  const ctx = buildScoreContext(pool.map((p) => p.item), req);

  // 帕累托前沿（价格 vs 蛋白质）——作为「可靠可比集合」的一种口径
  const front = new Set(
    paretoFront(pool.map((p) => p.item), (i) => [
      { key: 'price', value: i.price === null ? Number.POSITIVE_INFINITY : toYuan(i.price), higherIsBetter: false },
      { key: 'protein', value: i.totals.protein.value ?? 0, higherIsBetter: true },
    ]).map((i) => i.code),
  );
  notes.push(`帕累托前沿（价格↓ × 蛋白质↑）共 ${front.size} 项，供「均衡」口径参考。`);

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
      makePlan('budget', budgetPick, ctx, req,
        `在预算内的候选中实付最低（${fmtPrice(budgetPick)}）`),
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
      makePlan('protein', proteinPick, ctx, req,
        `蛋白质 ${proteinPick.item.totals.protein.value}g 为候选最高` +
          (ratio === null ? '' : `（约 ${ratio.toFixed(1)} g/元）`)),
    );
  }

  // ③ 均衡优先：多指标加权最高
  const balancePick = pick((a, b) => {
    const sa = scoreItem(a.item, ctx, 'balance').total;
    const sb = scoreItem(b.item, ctx, 'balance').total;
    if (sb !== sa) return sb - sa;
    // 同分时优先落在帕累托前沿上的（取舍更干净）
    return Number(front.has(b.item.code)) - Number(front.has(a.item.code));
  });
  if (balancePick) {
    taken.add(balancePick.item.code);
    plans.push(
      makePlan('balance', balancePick, ctx, req,
        '价格与蛋白质综合权衡，无单一极端偏好（详见分量明细）'),
    );
  }

  // 方案间互相对照（第一条对比句挂在「均衡」上，便于用户看取舍）
  if (plans.length >= 2) {
    const base = plans[plans.length - 1]!;
    const other = plans[0]!;
    base.explanation.statements.push('—— 与「' + other.label + '」对照 ——');
    base.explanation.statements.push(...comparePlans(base.priced, other.priced));
  }

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
    shortfallNote,
    safetyNotice: outcome.safetyNotice,
    overBudgetNote: pricing.notes.find((n) => n.includes('超出预算')) ?? null,
    notes: [...notes, ...pricing.notes],
  };
}

function fmtPrice(p: PricedCandidate): string {
  return p.effectivePrice === null ? '价格未取得' : `¥${toYuan(p.effectivePrice).toFixed(2)}`;
}

function makePlan(
  key: Priority,
  priced: PricedCandidate,
  ctx: ReturnType<typeof buildScoreContext>,
  req: MealRequest,
  reason: string,
): Plan {
  const score = scoreItem(priced.item, ctx, key);
  return {
    key,
    label: LABELS[key],
    priced,
    score,
    reason,
    explanation: explainPlan(priced),
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
 * 完整链路（严格按计划书第 6 节的两阶段）：
 *   ① 硬约束过滤（含菜单价预筛）
 *   ② 对主候选池做官方计价
 *   ③ **若主池为空**（全被预算拦下），回头对「菜单价超预算」那批做官方计价，
 *      挑出「最接近且明确超出」的备选——因为实付可能因优惠而更低，不能仅凭菜单价判死
 *   ④ 生成三方案（去重、不足则如实说明）
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
    pricing = {
      within: retry.within,
      nearestOver: retry.nearestOver,
      notes: [...pricing.notes, ...retry.notes, '（已对菜单价超预算者做官方计价复核）'],
    };
  }

  return { recommendation: buildRecommendation({ outcome, pricing, req }), outcome, pricing };
}

/** 应用默认预算（供测试与演示） */
export const DEFAULT_BUDGET_CENTS = (yuan: number): Cents => cents(Math.round(yuan * 100));

export type { AnalyzedItem, PricedCandidate };
