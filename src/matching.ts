/**
 * 营养匹配（T1.4）
 *
 * 问题：菜单（query-meals）与营养表（list-nutrition-foods）是**两套独立的命名体系**，
 * 没有任何官方交叉键。必须自己建立对应关系，否则就会出现「胡乱匹配」——
 * 把「麦辣鸡腿汉堡三件套」配成「麦辣鸡腿汉堡」的营养，热量差出一个饮料+薯条。
 *
 * 四级优先级（按可信度从高到低）：
 *   1. 代码映射（code-mapping）—— 人工/预置的 menuCode → 营养品名，最可信；
 *   2. 精确名称（exact-name）—— 归一化后完全相同；
 *   3. 人工别名（alias）—— 预置别名表命中；
 *   4. 无法匹配（unmatched）—— 宁可返回「未知」，也不猜。
 *
 * 归一化（normalizeName）要处理的现实差异：全半角、空白、连接号、商标符号、大小写。
 */

import type { NutritionRow } from './schema.ts';
import { buildAliasIndex, type AliasRule } from './aliases.ts';

export type MatchMethod = 'code-mapping' | 'exact-name' | 'alias' | 'unmatched';

/** 数据可信度分层（A 最高，D 最低；D 不给营养数字） */
export type Confidence = 'A' | 'B' | 'C' | 'D';

export interface MatchResult {
  menuCode: string;
  menuName: string;
  /** 命中的营养表品名；未命中为 null */
  nutritionName: string | null;
  nutrition: NutritionRow | null;
  method: MatchMethod;
  confidence: Confidence;
  /** 本次匹配的说明（用于解释与排查） */
  notes: string[];
}

export interface MatcherOptions {
  /** 代码映射：menuCode → 营养表 productName（最高优先级） */
  codeMapping?: Record<string, string>;
  /** 人工别名规则（见 aliases.ts） */
  aliases?: readonly AliasRule[];
}

/** 关键营养字段——缺了它们，热量/宏量营养的结论就不可靠 */
export const KEY_NUTRIENTS = ['energyKcal', 'protein', 'fat', 'carbohydrate'] as const;

/**
 * 名称归一化：把「看起来不同、其实同一个」的名称拉到同一个键上。
 * 注意：**只做书写形式的规整，不改变语义**（故不删「套餐」「三件套」这类词——
 * 它们语义不同，删了就成胡乱匹配）。
 */
export function normalizeName(raw: string): string {
  if (typeof raw !== 'string') return '';
  // ⚠️ 顺序要紧：商标符号必须在 NFKC **之前**剥离。
  // 因为 NFKC 会把 ™ 规范化成字母 "TM"（实测：'麦咖啡™' → '麦咖啡tm'），
  // 那时再想删就无从辨认了。
  let s = raw.replace(/[™®©]/g, '');
  s = s.normalize('NFKC');
  s = s.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ''); // 零宽与不换行空格
  s = s.replace(/\s+/g, ''); // 去掉所有空白（含全角空格）
  s = s.replace(/[_\-—–－―]/g, ''); // 统一去掉各类连接号
  s = s.replace(/[（）()【】\[\]「」『』<>《》]/g, '');
  s = s.replace(/[·・.]/g, '');
  return s.toLowerCase();
}

/** 判断营养数据是否「齐全到足以支撑结论」 */
export function isNutritionComplete(
  n: NutritionRow | null,
  keys: readonly (keyof NutritionRow)[] = KEY_NUTRIENTS,
): boolean {
  if (!n) return false;
  return keys.every((k) => n[k] !== null && n[k] !== undefined);
}

/** 判断营养数据是否「有可用信息」（至少一个关键字段非空） */
export function hasAnyKeyNutrient(n: NutritionRow | null,
  keys: readonly (keyof NutritionRow)[] = KEY_NUTRIENTS): boolean {
  if (!n) return false;
  return keys.some((k) => n[k] !== null && n[k] !== undefined);
}

/**
 * 给出可信度分层。
 * @param nutrition 命中的营养数据（null = 未命中）
 * @param hasComposition 是否能从 query-meal-detail 取到该餐品的组成
 */
export function assignConfidence(
  nutrition: NutritionRow | null,
  hasComposition: boolean,
): Confidence {
  if (!nutrition) return 'D';
  if (!hasAnyKeyNutrient(nutrition)) return 'D';
  if (!isNutritionComplete(nutrition)) return 'C'; // 部分缺失：只展示已知部分
  return hasComposition ? 'A' : 'B';
}

export interface MatcherStats {
  total: number;
  byMethod: Record<MatchMethod, number>;
  byConfidence: Record<Confidence, number>;
  /** 命中率（非 unmatched 的占比），0–1 */
  coverage: number;
}

/** 营养匹配器：构建一次索引，反复匹配 */
export class NutritionMatcher {
  private readonly byNormalizedName = new Map<string, NutritionRow>();
  private readonly aliasIndex: Map<string, AliasRule>; // 归一化别名 → 规则
  private readonly codeMapping: Record<string, string>;
  private readonly nutritionIndex = new Map<string, NutritionRow>(); // 原品名 → row

  constructor(nutritionRows: readonly NutritionRow[], options: MatcherOptions = {}) {
    for (const row of nutritionRows) {
      const key = normalizeName(row.productName);
      if (key === '') continue;
      // 同名冲突时保留第一条（并可通过 getConflicts 查看）
      if (!this.byNormalizedName.has(key)) this.byNormalizedName.set(key, row);
      this.nutritionIndex.set(row.productName, row);
    }
    this.codeMapping = options.codeMapping ?? {};
    this.aliasIndex = buildAliasIndex(options.aliases ?? [], normalizeName);
  }

  /** 营养表里归一化后重名的条目（用于排查数据质量） */
  getConflicts(): { key: string; names: string[] }[] {
    const groups = new Map<string, string[]>();
    for (const name of this.nutritionIndex.keys()) {
      const k = normalizeName(name);
      const arr = groups.get(k) ?? [];
      arr.push(name);
      groups.set(k, arr);
    }
    return [...groups.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([key, names]) => ({ key, names }));
  }

  /** 匹配单个菜单项 */
  match(menuItem: { code: string; name: string }, hasComposition = false): MatchResult {
    const notes: string[] = [];
    const base = {
      menuCode: menuItem.code,
      menuName: menuItem.name,
      notes,
    };

    // 优先级 1：代码映射
    const mappedName = this.codeMapping[menuItem.code];
    if (mappedName) {
      const row = this.nutritionIndex.get(mappedName) ?? null;
      if (row) {
        notes.push(`代码映射命中：${menuItem.code} → ${mappedName}`);
        return {
          ...base,
          nutritionName: row.productName,
          nutrition: row,
          method: 'code-mapping',
          confidence: assignConfidence(row, hasComposition),
        };
      }
      notes.push(`代码映射指向「${mappedName}」，但营养表中未找到该品名，降级继续匹配`);
    }

    const key = normalizeName(menuItem.name);

    // 优先级 2：精确名称
    const exact = this.byNormalizedName.get(key);
    if (exact) {
      notes.push(`精确名称命中（归一化后同为「${key}」）`);
      return {
        ...base,
        nutritionName: exact.productName,
        nutrition: exact,
        method: 'exact-name',
        confidence: assignConfidence(exact, hasComposition),
      };
    }

    // 优先级 3：人工别名
    const rule = this.aliasIndex.get(key);
    if (rule) {
      const row = this.nutritionIndex.get(rule.nutrition) ?? null;
      if (row) {
        notes.push(`别名命中：${menuItem.name} → ${rule.nutrition}（${rule.note}）`);
        const base0 = assignConfidence(row, hasComposition);
        // 含推断成分的映射，可信度上限压到 B——诚实标注「此处有推断」
        const confidence: Confidence = rule.risky && base0 === 'A' ? 'B' : base0;
        if (rule.risky && base0 === 'A') notes.push('该映射含份量推断，可信度由 A 降为 B');
        return {
          ...base,
          nutritionName: row.productName,
          nutrition: row,
          method: 'alias',
          confidence,
        };
      }
      notes.push(`别名指向「${rule.nutrition}」，但营养表中未找到该品名，判为未匹配`);
    }

    // 优先级 4：不猜
    notes.push('未命中任何规则——按「未知」处理，不给营养数字');
    return {
      ...base,
      nutritionName: null,
      nutrition: null,
      method: 'unmatched',
      confidence: 'D',
    };
  }

  /** 批量匹配并统计 */
  matchAll(
    menuItems: readonly { code: string; name: string }[],
    hasCompositionOf: (code: string) => boolean = () => false,
  ): { results: MatchResult[]; stats: MatcherStats } {
    const results = menuItems.map((m) => this.match(m, hasCompositionOf(m.code)));
    return { results, stats: summarize(results) };
  }
}

/** 汇总匹配结果 */
export function summarize(results: readonly MatchResult[]): MatcherStats {
  const byMethod: Record<MatchMethod, number> = {
    'code-mapping': 0,
    'exact-name': 0,
    alias: 0,
    unmatched: 0,
  };
  const byConfidence: Record<Confidence, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of results) {
    byMethod[r.method]++;
    byConfidence[r.confidence]++;
  }
  const total = results.length;
  const matched = total - byMethod.unmatched;
  return {
    total,
    byMethod,
    byConfidence,
    coverage: total === 0 ? 0 : matched / total,
  };
}
