/**
 * 多目标评分与帕累托前沿（T2.2）
 *
 * 口径严格对齐计划书 §6.3：
 *   · 每项在**本轮候选集内**归一化到 0～1——避免单位大小扭曲（元 vs 克 vs kcal）；
 *   · **用户没指定的目标，其权重必须重归一化**，不凭空占分；
 *   · **缺项一律不得填 0 冒充事实**——该分量记为 null，其权重一并剔除；
 *   · 输出 `scoreBreakdown` 便于解释与测试；
 *   · 不把「热量越低越好」当作默认正确——`energyFit` 只在用户给出目标时才算。
 *
 * ⚠️ 这些权重是**产品内部启发式，不是医学标准**。
 */

import type { AnalyzedItem } from './analyze.ts';
import { toYuan, type Cents } from './money.ts';
import type { MealRequest, Priority } from './constraints.ts';

/** 权重表（计划书 §6.3 示例值，可调） */
export interface ScoreWeights {
  budget: number;
  protein: number;
  energyFit: number;
}

export const DEFAULT_WEIGHTS: Record<Priority, ScoreWeights> = {
  budget: { budget: 0.65, protein: 0.25, energyFit: 0.1 },
  protein: { budget: 0.2, protein: 0.65, energyFit: 0.15 },
  balance: { budget: 0.35, protein: 0.35, energyFit: 0.3 },
};

export interface ScoreBreakdown {
  /** 各分量（0–1）；null 表示**该项不可得**（数据缺失或用户未指定）——不是 0 */
  budgetScore: number | null;
  proteinScore: number | null;
  energyFit: number | null;
  /** 总分（0–1）：仅由可用分量按其**重归一化后**的权重合成 */
  total: number;
  /** 实际使用的权重（已重归一化，和恒为 1） */
  weightsUsed: ScoreWeights;
  /** 解释用：哪些分量被剔除、为何 */
  notes: string[];
}

/** 归一化上下文：本轮候选集的取值范围 */
export interface ScoreContext {
  budgetCents: Cents;
  priceMin: Cents;
  priceMax: Cents;
  proteinMin: number;
  proteinMax: number;
  energyTargetKcal: number | null;
  /** 热量容差（kcal）——|E-target| 达到此值即 energyFit=0 */
  energyToleranceKcal: number;
}

/** 从候选集构建归一化上下文 */
export function buildScoreContext(accepted: readonly AnalyzedItem[], req: MealRequest): ScoreContext {
  const prices = accepted.map((i) => i.price).filter((p): p is Cents => p !== null);
  const proteins = accepted
    .map((i) => i.totals.protein.value)
    .filter((p): p is number => p !== null);

  return {
    budgetCents: Math.round(req.budgetCny * 100) as Cents,
    priceMin: (prices.length ? Math.min(...prices) : 0) as Cents,
    priceMax: (prices.length ? Math.max(...prices) : 0) as Cents,
    proteinMin: proteins.length ? Math.min(...proteins) : 0,
    proteinMax: proteins.length ? Math.max(...proteins) : 0,
    energyTargetKcal: req.preferences.energyTargetKcal ?? null,
    // 容差默认取目标值的 30%（至少 150 kcal），仅用于「吻合度」这一软指标
    energyToleranceKcal: Math.max(150, Math.round((req.preferences.energyTargetKcal ?? 700) * 0.3)),
  };
}

/** 线性归一化；上下界相同时给 0.5（表示「本批无从区分」，而非最好或最差） */
function normalize(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return 0.5;
  if (max <= min) return 0.5;
  return Math.min(1, Math.max(0, (v - min) / (max - min)));
}

/**
 * 计算有效权重：把**不可用**的分量剔除后，对剩余权重做**重归一化**。
 * 计划书 §6.3 明确要求这一步。
 */
export function effectiveWeights(
  priority: Priority,
  availability: { budget: boolean; protein: boolean; energyFit: boolean },
  base: ScoreWeights = DEFAULT_WEIGHTS[priority],
): { weights: ScoreWeights; notes: string[] } {
  const notes: string[] = [];
  const raw = {
    budget: availability.budget ? base.budget : 0,
    protein: availability.protein ? base.protein : 0,
    energyFit: availability.energyFit ? base.energyFit : 0,
  };
  if (!availability.budget) notes.push('价格不可得，其权重已剔除');
  if (!availability.protein) notes.push('蛋白质不可得，其权重已剔除（不以 0 冒充）');
  if (!availability.energyFit) notes.push('用户未指定本餐热量目标，其权重已重新分配');

  const sum = raw.budget + raw.protein + raw.energyFit;
  if (sum <= 0) {
    // 三项都不可用：退化为等权（并如实说明）
    notes.push('所有目标分量均不可用，退化为等权处理');
    return { weights: { budget: 1 / 3, protein: 1 / 3, energyFit: 1 / 3 }, notes };
  }
  return {
    weights: { budget: raw.budget / sum, protein: raw.protein / sum, energyFit: raw.energyFit / sum },
    notes,
  };
}

/** 对单个候选评分 */
export function scoreItem(
  item: AnalyzedItem,
  ctx: ScoreContext,
  priority: Priority,
  base: ScoreWeights = DEFAULT_WEIGHTS[priority],
): ScoreBreakdown {
  const price = item.price;
  const protein = item.totals.protein.value;
  const kcal = item.totals.energyKcal.value;
  const target = ctx.energyTargetKcal;

  const budgetScore = price === null ? null : 1 - normalize(price, ctx.priceMin, ctx.priceMax);
  const proteinScore = protein === null ? null : normalize(protein, ctx.proteinMin, ctx.proteinMax);
  const energyFit =
    target === null || kcal === null
      ? null
      : 1 - Math.min(1, Math.abs(kcal - target) / ctx.energyToleranceKcal);

  const { weights, notes } = effectiveWeights(
    priority,
    { budget: budgetScore !== null, protein: proteinScore !== null, energyFit: energyFit !== null },
    base,
  );

  let total = 0;
  if (budgetScore !== null) total += budgetScore * weights.budget;
  if (proteinScore !== null) total += proteinScore * weights.protein;
  if (energyFit !== null) total += energyFit * weights.energyFit;

  return {
    budgetScore,
    proteinScore,
    energyFit,
    total,
    weightsUsed: weights,
    notes,
  };
}

// ─────────────────── 帕累托前沿 ───────────────────

export interface Objective {
  key: string;
  value: number;
  /** true = 越大越好（如蛋白质）；false = 越小越好（如价格） */
  higherIsBetter: boolean;
}

/** a 是否支配 b：在所有目标上不差，且至少一个更好 */
function dominates(a: readonly Objective[], b: readonly Objective[]): boolean {
  let strictlyBetter = false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    const ax = x.higherIsBetter ? x.value : -x.value;
    const by = y.higherIsBetter ? y.value : -y.value;
    if (ax < by) return false; // 有一项更差 → 不支配
    if (ax > by) strictlyBetter = true;
  }
  return strictlyBetter;
}

/**
 * 求帕累托前沿（不被任何其他候选支配的那些）。
 * 计划书 §6.2：先做前沿，再按偏好权重排序——而不是直接对所有项打分。
 */
export function paretoFront<T>(items: readonly T[], objectivesOf: (t: T) => Objective[]): T[] {
  const scored = items.map((it) => ({ it, obj: objectivesOf(it) }));
  return scored
    .filter(({ obj }, i) =>
      !scored.some((other, j) => j !== i && dominates(other.obj, obj)),
    )
    .map((s) => s.it);
}

/**
 * 候选在「价格 vs 蛋白质」上的默认目标函数：
 * 价格越低越好，蛋白质越高越好（钠在某些模式下也可纳入，此处保持最小集）。
 */
export function defaultObjectives(item: AnalyzedItem): Objective[] {
  return [
    { key: 'price', value: item.price === null ? Number.POSITIVE_INFINITY : toYuan(item.price), higherIsBetter: false },
    { key: 'protein', value: item.totals.protein.value ?? 0, higherIsBetter: true },
  ];
}
