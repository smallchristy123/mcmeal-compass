/**
 * 硬约束与结构可行性过滤（T2.1）
 *
 * 对应计划书 §6.2「第 1 阶段」。三道关：
 *   ① **可售且结构合法**——当前门店在售、数据能取到；
 *   ② **数据达标**——只有 A/B 级才允许进入**有数值约束**的推荐
 *      （C 级只展示已知部分，D 级不给数字——它们不能参与「达标」判定）；
 *   ③ **用户硬条件**——预算、最低蛋白、避开含糖饮料等。
 *
 * ⚠️ 一条不可退让的安全底线（计划书 §6.2 第 4 条）：
 *   **当用户声明严重过敏或需严格避开某成分，而数据无法可靠验证时，
 *   绝不返回「安全可食用」的推荐**——转为如实说明信息不足。
 */

import type { AnalyzedItem } from './analyze.ts';
import { hasSolidNutrition } from './analyze.ts';
import { toYuan, type Cents } from './money.ts';

// ─────────────────── 用户输入模型（计划书 §6.1） ───────────────────

export type Priority = 'budget' | 'protein' | 'balance';
export type OrderMode = 'pickup' | 'delivery' | 'drive-through';

export interface UserPreferences {
  /** 目标偏好：预算 / 蛋白质 / 均衡 */
  priority: Priority;
  /** 是否避开含糖饮料 */
  avoidSugaryDrinks?: boolean;
  /** 本餐热量目标（kcal）——**仅在用户明确给出时才有值**，不默认低热量 */
  energyTargetKcal?: number | null;
  /** 最低蛋白质（g） */
  minimumProteinGrams?: number | null;
  /** 钠偏好 */
  sodiumPreference?: 'unspecified' | 'low';
}

export interface SafetyInput {
  /** 是否声明了过敏 */
  allergyDeclared?: boolean;
  /** 是否需要专业膳食指导 */
  requiresProfessionalDiet?: boolean;
}

export interface MealRequest {
  budgetCny: number;
  orderMode: OrderMode;
  storeCode: string;
  mealTime?: string;
  preferences: UserPreferences;
  safety?: SafetyInput;
}

// ─────────────────── 过滤结果 ───────────────────

export type RejectReason =
  | 'data-insufficient'
  | 'over-budget'
  | 'below-min-protein'
  | 'sugary-drink';

export interface RejectedItem {
  item: AnalyzedItem;
  reason: RejectReason;
  /** 人能看懂的说明 */
  detail: string;
}

export interface ConstraintOutcome {
  /** 通过全部硬约束、且数据达标的候选 */
  accepted: AnalyzedItem[];
  /** 被拒的候选及原因（如实列出，便于解释与调试） */
  rejected: RejectedItem[];
  /** 仅「数据不足」而被拒的（这些可进「信息不完整」区展示，但不进数值榜单） */
  dataInsufficient: AnalyzedItem[];
  /**
   * **菜单价**超出预算、因而暂不进入主候选池的那些。
   *
   * 为什么不直接判死：菜单价只用于**预筛**（计划书 §6.2），实付可能因优惠而更低。
   * 故这些要先留着——若主池最终为空，再对它们走官方计价，挑出
   * 「**最接近预算且明确超出**」的备选（§6.2 第 3 条）。
   */
  overBudgetPrefilter: AnalyzedItem[];
  /** 安全闸：为 true 时**不得**给出任何「安全可食用」结论 */
  safetyBlocked: boolean;
  /** 安全闸触发时的说明（直接展示给用户） */
  safetyNotice: string | null;
}

/** 含糖饮料识别（用于 avoidSugaryDrinks） */
const SUGARY_RE = /(可乐|雪碧|芬达|醒目|美年达|含糖|果味饮料|冰茶|柠檬茶|橙汁|苹果汁|奶茶|拿铁|摩卡|星冰乐|麦旋风|新地)/;

/** 判断某候选是否含疑似含糖饮料 */
export function looksSugary(item: AnalyzedItem): boolean {
  if (SUGARY_RE.test(item.name)) return true;
  return item.unmatchedComponents.some((c) => SUGARY_RE.test(c));
}

/**
 * 硬约束过滤。
 *
 * @param items 已分析（带可信度与营养）的候选
 * @param req 用户请求
 */
export function applyHardConstraints(
  items: readonly AnalyzedItem[],
  req: MealRequest,
): ConstraintOutcome {
  const budget = Math.round(req.budgetCny * 100) as Cents;
  const minProtein = req.preferences.minimumProteinGrams ?? null;

  // ── 安全闸：声明过敏 / 需专业指导时，绝不声称「安全」 ──
  const safety = req.safety ?? {};
  const safetyBlocked = Boolean(safety.allergyDeclared || safety.requiresProfessionalDiet);
  const safetyNotice = safetyBlocked
    ? '你已声明过敏或需要专业膳食指导。本项目**不掌握完整的过敏原与交叉接触信息**，' +
      '因此**无法保证任何组合对你「安全」**。以下结果仅供了解餐品的基础营养构成，' +
      '**不构成安全结论**；请以门店与官方渠道的过敏原信息为准，并咨询专业人员。'
    : null;

  const accepted: AnalyzedItem[] = [];
  const rejected: RejectedItem[] = [];
  const dataInsufficient: AnalyzedItem[] = [];
  const overBudgetPrefilter: AnalyzedItem[] = [];

  for (const item of items) {
    // 关 ②：数据达标——只有 A/B 且关键营养齐全者，才允许进有数值约束的推荐
    if (!hasSolidNutrition(item)) {
      dataInsufficient.push(item);
      rejected.push({
        item,
        reason: 'data-insufficient',
        detail:
          item.confidence === 'C'
            ? '营养仅部分可知，无法参与「达标」判定'
            : item.confidence === 'D'
              ? '未匹配到官方营养记录'
              : '关键营养有缺项',
      });
      continue;
    }

    // 关 ③-a：**菜单价预筛**——只用于缩小候选，不作最终判定
    // （实付可能因优惠更低；若主池为空，这些将走官方计价挑「最接近者」）
    if (item.price !== null && item.price > budget) {
      overBudgetPrefilter.push(item);
      rejected.push({
        item,
        reason: 'over-budget',
        detail: `菜单价 ¥${toYuan(item.price).toFixed(2)} 超出预算 ¥${req.budgetCny.toFixed(2)}（待官方计价复核）`,
      });
      continue;
    }

    // 关 ③-b：最低蛋白
    if (minProtein !== null) {
      const p = item.totals.protein.value;
      if (p === null || p < minProtein) {
        rejected.push({
          item,
          reason: 'below-min-protein',
          detail: p === null ? '蛋白质数据缺失' : `蛋白质 ${p}g 低于下限 ${minProtein}g`,
        });
        continue;
      }
    }

    // 关 ③-c：避开含糖饮料
    if (req.preferences.avoidSugaryDrinks && looksSugary(item)) {
      rejected.push({
        item,
        reason: 'sugary-drink',
        detail: '含疑似含糖饮料（或套餐含此类组件）',
      });
      continue;
    }

    accepted.push(item);
  }

  return { accepted, rejected, dataInsufficient, overBudgetPrefilter, safetyBlocked, safetyNotice };
}
