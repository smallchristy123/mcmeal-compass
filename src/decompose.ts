/**
 * 套餐展开与替换校验（T1.6）
 *
 * 为什么这是主路径：实测菜单 128 条中 **50 条是套餐（39%）**，
 * 而套餐名在整个营养表里一条都找不到（直接匹配 0%）。
 * 唯一可行的路径是——**展开成组件，逐件配营养，再合计**。
 * 实测展开后组件命中 87.6%（156/178）。
 *
 * 两条铁律：
 *   1. **缺失不补零**——某组件缺蛋白质，则「蛋白质合计」标为 *不完整*，
 *      给「已知部分之和」但明确说明它不代表总值（计划书 §5.3.5）；
 *   2. **替换必须校验**——不在该轮次选项里的替换一律拒绝，并回列允许项，
 *      绝不悄悄替换（计划书 §5.3.6）。
 */

import type { MealChoice, MealDetail, MealRound } from './schema.ts';
import type { NutritionRow } from './schema.ts';
import type { Cents } from './money.ts';
import type { Confidence, MatchResult } from './matching.ts';
import type { NutritionMatcher } from './matching.ts';

/** 某营养素在套餐内的合计结果 */
export interface NutrientTotal {
  /** 已知部分之和；一个都没取到则为 null（**不是 0**） */
  value: number | null;
  /** 是否所有组件都贡献了该字段 */
  complete: boolean;
  /** 贡献了该字段的组件数 */
  knownCount: number;
  /** 参与合计的组件数 */
  totalCount: number;
}

export interface NutritionTotals {
  energyKcal: NutrientTotal;
  protein: NutrientTotal;
  fat: NutrientTotal;
  carbohydrate: NutrientTotal;
  sodium: NutrientTotal;
}

/** 展开后的一个组件 */
export interface DecomposedComponent {
  roundId: number;
  roundName: string;
  choiceCode: string;
  choiceName: string;
  isDefault: boolean;
  /** 该选项相对默认项的差价（分；可为负） */
  diffPrice: Cents | null;
  /** 选用数量（通常为 1） */
  quantity: number;
  match: MatchResult;
}

export interface DecomposedMeal {
  code: string;
  name: string;
  components: DecomposedComponent[];
  totals: NutritionTotals;
  /**
   * 套餐整体的可信度：
   *   B = 全部组件命中、营养齐全、组成已确认（对应计划书「可追溯组合」）
   *   C = 有组件未命中，或营养部分缺失，或用了含推断的别名
   *   D = 全部组件都未命中（等于取不到营养）
   */
  confidence: Confidence;
  /** 未命中的组件名（用于向用户解释「为何不完整」） */
  unmatchedComponents: string[];
  /** 说明与告警 */
  notes: string[];
}

/** 一次替换请求 */
export interface SubstitutionRequest {
  roundId: number;
  choiceCode: string;
}

export interface RejectedSubstitution {
  roundId: number;
  choiceCode: string;
  reason: string;
  /** 该轮次实际允许的选项（拒绝时必须回列，便于用户改选） */
  allowed: { code: string; name: string; isDefault: boolean }[];
}

export interface SubstitutionCheck {
  accepted: SubstitutionRequest[];
  rejected: RejectedSubstitution[];
}

const NUMERIC_FIELDS = ['energyKcal', 'protein', 'fat', 'carbohydrate', 'sodium'] as const;
type NumericField = (typeof NUMERIC_FIELDS)[number];

/**
 * 校验替换请求：只接受「该轮次选项列表里确实存在的 code」。
 * 不在列表中的，一律拒绝并回列允许项——这是「不悄悄改单」的底线。
 */
export function checkSubstitutions(
  detail: MealDetail,
  requests: readonly SubstitutionRequest[],
): SubstitutionCheck {
  const byRound = new Map(detail.rounds.map((r) => [r.id, r]));
  const accepted: SubstitutionRequest[] = [];
  const rejected: RejectedSubstitution[] = [];

  for (const req of requests) {
    const round = byRound.get(req.roundId);
    if (!round) {
      rejected.push({
        roundId: req.roundId,
        choiceCode: req.choiceCode,
        reason: `套餐「${detail.name}」不存在轮次 id=${req.roundId}`,
        allowed: [],
      });
      continue;
    }
    const hit = round.choices.find((c) => c.code === req.choiceCode);
    if (!hit) {
      rejected.push({
        roundId: req.roundId,
        choiceCode: req.choiceCode,
        reason: `选项 ${req.choiceCode} 不在轮次「${round.name}」的允许范围内`,
        allowed: round.choices.map((c) => ({ code: c.code, name: c.name, isDefault: c.isDefault })),
      });
      continue;
    }
    accepted.push(req);
  }

  return { accepted, rejected };
}

/** 按「默认项 + 已接受的替换」确定每一轮选中的选项 */
export function selectChoices(
  detail: MealDetail,
  accepted: readonly SubstitutionRequest[] = [],
): { round: MealRound; choice: MealChoice }[] {
  const subByRound = new Map(accepted.map((s) => [s.roundId, s.choiceCode]));
  const picked: { round: MealRound; choice: MealChoice }[] = [];

  for (const round of detail.rounds) {
    const wantCode = subByRound.get(round.id);
    let choice: MealChoice | undefined;
    if (wantCode) choice = round.choices.find((c) => c.code === wantCode);
    if (!choice) choice = round.choices.find((c) => c.isDefault);
    if (!choice) choice = round.choices[0];
    if (choice) picked.push({ round, choice });
  }
  return picked;
}

/** 把若干组件的营养值合计；缺失字段标为不完整，**绝不当成 0** */
export function computeTotals(components: readonly DecomposedComponent[]): NutritionTotals {
  const totalCount = components.length;
  const totals = {} as NutritionTotals;

  for (const field of NUMERIC_FIELDS) {
    let sum = 0;
    let knownCount = 0;
    for (const comp of components) {
      const row: NutritionRow | null = comp.match.nutrition;
      const v = row ? (row[field] as number | null) : null;
      if (v === null || v === undefined) continue;
      sum += v * (comp.quantity || 1);
      knownCount++;
    }
    totals[field] = {
      value: knownCount === 0 ? null : sum,
      complete: totalCount > 0 && knownCount === totalCount,
      knownCount,
      totalCount,
    };
  }
  return totals;
}

/** 由组件可信度推导套餐整体可信度 */
function deriveMealConfidence(components: readonly DecomposedComponent[]): Confidence {
  if (components.length === 0) return 'D';

  const unmatched = components.filter((c) => c.match.method === 'unmatched').length;
  if (unmatched === components.length) return 'D';
  if (unmatched > 0) return 'C'; // 部分可知

  const allComplete = components.every((c) => {
    const n = c.match.nutrition;
    return n !== null && NUMERIC_FIELDS.every((f) => n[f] !== null && n[f] !== undefined);
  });
  const anyRisky = components.some((c) => c.match.risky);
  if (!allComplete) return 'C';
  if (anyRisky) return 'C'; // 含推断 ⇒ 配料可能不同 ⇒ 只到「部分可知」
  return 'B'; // 可追溯组合
}

/**
 * 展开一个套餐。
 *
 * @param detail 由 `toMealDetail` 转好的套餐详情
 * @param matcher 营养匹配器
 * @param substitutions 可选：替换请求（会先经 checkSubstitutions 校验）
 */
export function decomposeMeal(
  detail: MealDetail,
  matcher: NutritionMatcher,
  substitutions: readonly SubstitutionRequest[] = [],
): DecomposedMeal {
  const notes: string[] = [];
  const check = checkSubstitutions(detail, substitutions);
  for (const rej of check.rejected) {
    notes.push(`已拒绝替换：${rej.reason}（允许项：${rej.allowed.map((a) => a.name).join('、')}）`);
  }

  const picked = selectChoices(detail, check.accepted);
  const components: DecomposedComponent[] = picked.map(({ round, choice }) => {
    // 有官方组成信息（supportModify 或能取到组成）即视为「组成已确认」
    const hasComposition = choice.supportModify || (choice.composition?.length ?? 0) > 0;
    return {
      roundId: round.id,
      roundName: round.name,
      choiceCode: choice.code,
      choiceName: choice.name,
      isDefault: choice.isDefault,
      diffPrice: choice.diffPrice,
      quantity: choice.quantity || 1,
      match: matcher.match({ code: choice.code, name: choice.name }, hasComposition),
    };
  });

  if (components.length === 0) {
    notes.push('该套餐没有任何可展开的轮次——无法计算营养');
  }

  const unmatchedComponents = components
    .filter((c) => c.match.method === 'unmatched')
    .map((c) => `${c.roundName}：${c.choiceName}`);

  const totals = computeTotals(components);
  const confidence = deriveMealConfidence(components);

  if (unmatchedComponents.length > 0) {
    notes.push(`有 ${unmatchedComponents.length} 项未匹配到官方营养，故完整总量未知，仅展示已知部分`);
  }
  const incomplete = NUMERIC_FIELDS.filter((f) => !totals[f].complete);
  if (incomplete.length > 0 && unmatchedComponents.length === 0) {
    notes.push(`以下营养项未覆盖全部组件，合计不代表总值：${incomplete.join('、')}`);
  }

  return {
    code: detail.code,
    name: detail.name,
    components,
    totals,
    confidence,
    unmatchedComponents,
    notes,
  };
}
