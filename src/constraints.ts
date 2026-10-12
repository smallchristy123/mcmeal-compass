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
/**
 * 候选范围：
 *   · `main-meal`（默认）——**正餐候选**：排除明确的饮品/甜品/加餐单品，
 *     避免把「¥5 圆筒冰淇淋」当作「一餐的预算优先方案」；
 *   · `all`——单品/加餐比较，把上述项一并纳入（须由用户显式选择）。
 */
export type MealScope = 'main-meal' | 'all';

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
  /** 候选范围（默认 `main-meal`：正餐候选） */
  mealScope?: MealScope;
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
  | 'sugary-drink'
  | 'sugary-unverified'
  | 'not-a-meal';

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

/**
 * 含糖饮料识别（用于 avoidSugaryDrinks）。
 *
 * ⚠️ v3 整改（评审 R2）：此前只看**商品名**与 `unmatchedComponents`——
 * 于是「已成功匹配、但组件里含普通可乐」的套餐能悄悄通过避糖筛选。
 * 现在改为**按实际选中的结构化组件**判定（见 `assessSugary`），
 * 并区分「明确无糖 / 明确含糖 / 无法核实」三态，避免误杀零糖商品。
 */
const SUGARY_RE = /(可乐|雪碧|芬达|醒目|美年达|含糖|果味饮料|冰茶|柠檬茶|橙汁|苹果汁|奶茶|拿铁|摩卡|星冰乐|麦旋风|新地)/;
/** 明确「无糖/零糖」的写法——**优先于** SUGARY_RE 判定，避免误杀 */
const SUGAR_FREE_RE = /(无糖|零度|零糖|0\s*糖|zero|纤维\+)/i;
/** 疑似「饮品」——用于判断「无法核实的组件」是否属于饮品范畴 */
const DRINK_HINT_RE = /(可乐|雪碧|芬达|醒目|美年达|饮料|饮品|茶|咖啡|汁|奶昔|冰沙|气泡|纯净水|矿泉水|水$|奶$)/;
/**
 * 明确的「非正餐」项（甜品 / 冰饮 / 饮品）——仅在 `mealScope=main-meal` 时排除。
 * 判据取自**名称与分类关键词**（可解释、可复核），不引入医学热量下限。
 */
const NON_MEAL_RE =
  /(冰淇淋|甜筒|圆筒|圣代|新地|麦旋风|麦乐酷|派$|甜品|蛋糕|曲奇|饼干|饮料|饮品|可乐|雪碧|芬达|醒目|美年达|奶茶|咖啡|拿铁|摩卡|星冰乐|茶|果汁|橙汁|苹果汁|纯牛奶|饮用水)/;

/** 三态判定：明确含糖 / 明确无糖 / 无从判断 */
export type SugaryClass = 'sugary' | 'sugar-free' | 'unknown';

export function classifySugary(name: string): SugaryClass {
  if (SUGAR_FREE_RE.test(name)) return 'sugar-free';
  if (SUGARY_RE.test(name)) return 'sugary';
  return 'unknown';
}

export interface SugaryAssessment {
  /** 是否应因避糖而被排除（含「无法核实」的情形——**不宣称满足避糖**） */
  sugary: boolean;
  /** 是否存在**无法核实**的疑似饮品组件 */
  unverified: boolean;
  /** 命中的组件/名称（供解释与审核） */
  hits: string[];
  /** 判断依据说明（直接展示） */
  detail: string;
}

/**
 * 依据**实际选中组件**做避糖判定。
 *
 * 判据（与单品、套餐同一套语义）：
 *   ① 名称（或任一已匹配组件名）命中含糖词、且未被「无糖」写法否定 → 排除；
 *   ② 存在**未匹配到营养**的疑似饮品组件 → **不能核实**，同样排除（不宣称满足避糖）；
 *   ③ 明确标注无糖/零糖者 → 不排除（原判定会误杀，此处修正）。
 */
export function assessSugary(item: AnalyzedItem): SugaryAssessment {
  const hits: string[] = [];
  let unverified = false;

  const look = (name: string, nutritionMatched: boolean, where: string): void => {
    const cls = classifySugary(name);
    if (cls === 'sugary') {
      hits.push(`${where}${name}`);
      return;
    }
    // 既非明确含糖、也非明确无糖：若属饮品范畴且组成未核实，则不能宣称满足避糖
    if (cls === 'unknown' && !nutritionMatched && DRINK_HINT_RE.test(name)) {
      unverified = true;
      hits.push(`${where}${name}（成分未知）`);
    }
  };

  look(item.name, true, '');
  for (const comp of item.components ?? []) {
    look(comp.choiceName, comp.nutritionMatched, `${comp.roundName}：`);
  }
  for (const u of item.unmatchedComponents) look(u, false, '');

  const sugary = hits.length > 0;
  return {
    sugary,
    unverified,
    hits,
    detail: sugary
      ? unverified && hits.every((h) => h.includes('成分未知'))
        ? `含**无法核实成分**的饮品组件：${hits.join('、')}——不宣称满足「避开含糖饮料」`
        : `含疑似含糖饮料：${hits.join('、')}`
      : '',
  };
}

/** 判断某候选是否含疑似含糖饮料（保留旧口径，内部改用组件级判定） */
export function looksSugary(item: AnalyzedItem): boolean {
  return assessSugary(item).sugary;
}

/** 是否属「明确的非正餐」项（甜品/冰饮/饮品） */
export function isNonMealItem(item: AnalyzedItem): boolean {
  if (NON_MEAL_RE.test(item.name)) return true;
  const category = item.category ?? '';
  return NON_MEAL_RE.test(category);
}

/** 一条「非价格硬条件」的违反记录 */
export interface ConstraintViolation {
  reason: RejectReason;
  detail: string;
}

/**
 * 【v3 核心】**非价格**硬条件的统一判定。
 *
 * 为什么必须独立成函数：v2 的病根是「菜单价超预算 → 先 continue 掉」，
 * 而最低蛋白/避糖检查排在其后——于是**回补池（菜单价超预算者）绕过了一切非价格条件**。
 * 现在主池、回补池、最终卡片**共用这一套**（评审 R1 的要求：
 * 「非价格硬条件统一先验，报价只影响价格条件」）。
 */
export function checkNonPriceConstraints(item: AnalyzedItem, req: MealRequest): ConstraintViolation | null {
  // ① 数据达标：只有 A/B 且关键营养齐全者，才允许进有数值约束的推荐
  if (!hasSolidNutrition(item)) {
    return {
      reason: 'data-insufficient',
      detail:
        item.confidence === 'C'
          ? '营养仅部分可知，无法参与「达标」判定'
          : item.confidence === 'D'
            ? '未匹配到官方营养记录'
            : '关键营养有缺项',
    };
  }

  // ② 最低蛋白
  const minProtein = req.preferences.minimumProteinGrams ?? null;
  if (minProtein !== null) {
    const p = item.totals.protein.value;
    if (p === null || p < minProtein) {
      return {
        reason: 'below-min-protein',
        detail: p === null ? '蛋白质数据缺失' : `蛋白质 ${p}g 低于下限 ${minProtein}g`,
      };
    }
  }

  // ③ 避开含糖饮料（按实际组件判定）
  //    顺序说明：用户**显式声明**的条件先于产品默认的「正餐范围」——
  //    用户开了避糖，就该在拒绝原因里如实写「含糖」，而不是含糊地写「不算正餐」。
  if (req.preferences.avoidSugaryDrinks) {
    const a = assessSugary(item);
    if (a.sugary) {
      return {
        reason: a.unverified ? 'sugary-unverified' : 'sugary-drink',
        detail: a.detail,
      };
    }
  }

  // ④ 正餐范围（默认开启）：把甜品/冰饮/饮品挡在「正餐候选」之外
  const scope = req.preferences.mealScope ?? 'main-meal';
  if (scope === 'main-meal' && isNonMealItem(item)) {
    return {
      reason: 'not-a-meal',
      detail: '属饮品/甜品/加餐，不计入「正餐候选」（如需比较单品加餐，请显式选择 all 范围）',
    };
  }

  return null;
}

/**
 * 硬约束过滤。
 *
 * **顺序即语义（v3 整改，评审 R1）**：
 *   ① 非价格硬条件（数据达标 / 正餐范围 / 最低蛋白 / 避糖）——先在**全量候选**上验，
 *      不因「菜单价超预算」而跳过；
 *   ② 菜单价预筛——只影响价格条件，落选者进 `overBudgetPrefilter` 留待官方计价复核。
 *
 * ⚠️ 反向也成立：`accepted` 与 `overBudgetPrefilter` 中的每一项，都**已通过同一套非价格硬条件**。
 *
 * @param items 已分析（带可信度与营养）的候选
 * @param req 用户请求
 */
export function applyHardConstraints(
  items: readonly AnalyzedItem[],
  req: MealRequest,
): ConstraintOutcome {
  const budget = Math.round(req.budgetCny * 100) as Cents;

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
    // 关 ②【非价格硬条件，统一先验】——数据达标 / 正餐范围 / 最低蛋白 / 避糖
    // ⚠️ 顺序是关键：v2 把这些排在「菜单价预筛」之后，导致回补池绕过全部非价格条件（R1）。
    const violation = checkNonPriceConstraints(item, req);
    if (violation) {
      if (violation.reason === 'data-insufficient') dataInsufficient.push(item);
      rejected.push({ item, reason: violation.reason, detail: violation.detail });
      continue;
    }

    // 关 ③：**菜单价预筛**——只用于缩小候选，不作最终判定
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

    accepted.push(item);
  }

  return { accepted, rejected, dataInsufficient, overBudgetPrefilter, safetyBlocked, safetyNotice };
}
