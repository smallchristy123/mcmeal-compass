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

export type MatchMethod =
  | 'code-mapping'
  | 'exact-name'
  | 'alias'
  | 'variant'
  | 'size-ambiguous'
  | 'unmatched';

/** 数据可信度分层（A 最高，D 最低；D 不给营养数字） */
export type Confidence = 'A' | 'B' | 'C' | 'D';

/** 一个「份量候选」 */
export interface SizeCandidate {
  /** 份量标识，如「中」「大」「2块」 */
  size: string;
  /** 该份量在营养表里的品名 */
  productName: string;
}

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
  /**
   * 该匹配是否含**推断**成分（如按行业默认份量映射）。
   * 结构化暴露，供上层（如套餐展开）判断可信度——**不要靠翻 notes 字符串**。
   */
  risky: boolean;
  /**
   * **份量歧义**（计划书 §5.3.3 的 `variant` 维度）：
   * 当菜单名不含份量、而营养表里同物有多个份量时，列出候选，
   * 请用户明确份量，**而不是替其猜一个**。
   */
  sizeCandidates?: SizeCandidate[];
}

/** 匹配的键（含份量维度） */
export interface MenuItemKey {
  code: string;
  name: string;
  /** 份量（可选）：用户明确指定时传入，如「中」「大」「2块」 */
  variant?: string;
}

export interface MatcherOptions {
  /** 代码映射：menuCode → 营养表 productName（最高优先级） */
  codeMapping?: Record<string, string>;
  /** 人工别名规则（见 aliases.ts） */
  aliases?: readonly AliasRule[];
  /**
   * 是否启用份量族识别（默认 true）。开启后，「薯条」这类不含份量的名称
   * 会返回「份量歧义 + 候选列表」，而非一律判为「无法匹配」。
   */
  detectSizeFamilies?: boolean;
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

/**
 * 份量词表（计划书 §5.3.3 的 `variant` 维度）
 * 麦当劳的份量差异分两类写法：**前置量词**（中薯条 / 大薯条）与**后置量词**（可乐中杯 / 麦辣鸡翅-2块）。
 */
const SIZE_WORDS = ['迷你', '特大', '超大', '小', '中', '大', '巨'] as const;
const SIZE_UNITS = '杯份条块盒包';
const LEADING_SIZE_RE = new RegExp(`^(${SIZE_WORDS.join('|')})(.+)$`);
/** 「大杯玉米杯」这类**前置量词+单位**（区别于「大玉米杯」） */
const LEADING_SIZE_UNIT_RE = new RegExp(`^(${SIZE_WORDS.join('|')})([${SIZE_UNITS}])(.+)$`);
const TRAILING_SIZE_WORD_RE = new RegExp(`^(.+?)(${SIZE_WORDS.join('|')})([${SIZE_UNITS}])$`);
const TRAILING_NUMERIC_SIZE_RE = /^(.+?)(\d+(?:块|个|只|条|片|颗|粒))$/;

export interface SizeSplit {
  /** 去掉份量后的「族名」 */
  family: string;
  /** 份量标识，如「中」「大杯」「2块」 */
  size: string;
}

/**
 * 把归一化后的名称拆成「族名 + 份量」。
 * 返回 null 表示该名称**不含份量信息**（即它本身就是一个族名）。
 *
 * 支持三种写法（皆实测所见）：
 *   · 前置量词：中薯条 / 大薯条
 *   · 前置量词+单位：大杯玉米杯 / 小杯玉米杯
 *   · 后置量词：可乐中杯 / 可乐大杯 / 麦辣鸡翅-2块
 */
export function splitSize(normalizedName: string): SizeSplit | null {
  // 先试「量词+单位」前置（较具体，须先于单纯量词判断）
  let m = LEADING_SIZE_UNIT_RE.exec(normalizedName);
  if (m) return { family: m[3]!, size: `${m[1]}${m[2]}` };

  m = LEADING_SIZE_RE.exec(normalizedName);
  if (m) return { family: m[2]!, size: m[1]! };

  m = TRAILING_SIZE_WORD_RE.exec(normalizedName);
  if (m) return { family: m[1]!, size: `${m[2]}${m[3]}` };

  m = TRAILING_NUMERIC_SIZE_RE.exec(normalizedName);
  if (m) return { family: m[1]!, size: m[2]! };

  return null;
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
  /** 族名 → 该族下各份量的条目 */
  private readonly sizeFamilies = new Map<string, { size: string; productName: string }[]>();
  private readonly detectSizeFamilies: boolean;

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
    this.detectSizeFamilies = options.detectSizeFamilies ?? true;
    if (this.detectSizeFamilies) this.buildSizeFamilies();
  }

  /**
   * 构建「份量族」索引：把同名不同份量的营养条目归到一族。
   * 例：中薯条 / 大薯条 / 小薯条 / 迷你薯条 → 族名「薯条」，四个份量。
   */
  private buildSizeFamilies(): void {
    for (const row of this.nutritionIndex.values()) {
      const norm = normalizeName(row.productName);
      // 含份量词的名称 → 归入其族；不含份量的名称 → 自身即族名
      const split = splitSize(norm);
      const family = split ? split.family : norm;
      const size = split ? split.size : '';
      const arr = this.sizeFamilies.get(family) ?? [];
      arr.push({ size, productName: row.productName });
      this.sizeFamilies.set(family, arr);
    }
  }

  /** 取某名称对应的份量候选（≥2 个才算歧义） */
  getSizeCandidates(nameOrFamily: string): SizeCandidate[] {
    const key = normalizeName(nameOrFamily);
    const fam = this.sizeFamilies.get(key);
    if (!fam) return [];
    const sized = fam.filter((f) => f.size !== '');
    if (sized.length < 2) return [];
    // 按常见份量顺序排（小→大），便于展示
    const order = ['迷你', '小', '小杯', '中', '中杯', '大', '大杯', '特大', '超大'];
    return sized
      .map((f) => ({ size: f.size, productName: f.productName }))
      .sort((a, b) => {
        const ia = order.indexOf(a.size);
        const ib = order.indexOf(b.size);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
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

  /** 匹配单个菜单项（可显式指定份量 variant） */
  match(menuItem: MenuItemKey, hasComposition = false): MatchResult {
    const notes: string[] = [];
    const base = {
      menuCode: menuItem.code,
      menuName: menuItem.name,
      notes,
      risky: false,
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

    // 优先级 2：显式份量（计划书 §5.3.3 的 variant）
    // 用户/上游若已给出份量，则按「份量+名」「名+份量」两种写法找精确项。
    if (menuItem.variant) {
      const v = normalizeName(menuItem.variant);
      for (const composed of [v + key, key + v]) {
        const row = this.byNormalizedName.get(composed);
        if (row) {
          notes.push(`按指定份量「${menuItem.variant}」命中：${row.productName}`);
          return {
            ...base,
            nutritionName: row.productName,
            nutrition: row,
            method: 'variant',
            confidence: assignConfidence(row, hasComposition),
          };
        }
      }
      notes.push(`已指定份量「${menuItem.variant}」，但营养表中无对应条目，继续按普通规则匹配`);
    }

    // 优先级 3：精确名称
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

    // 优先级 4：人工别名
    const rule = this.aliasIndex.get(key);
    if (rule) {
      const row = this.nutritionIndex.get(rule.nutrition) ?? null;
      if (row) {
        if (rule.risky) {
          notes.push(`别名命中（含份量推断）：${menuItem.name} → ${rule.nutrition}。依据：${rule.note}`);
        } else {
          notes.push(`别名命中：${menuItem.name} → ${rule.nutrition}（${rule.note}）`);
        }
        const base0 = assignConfidence(row, hasComposition);
        // 含推断成分的映射，可信度上限压到 B——诚实标注「此处有推断」
        const confidence: Confidence = rule.risky && base0 === 'A' ? 'B' : base0;
        if (rule.risky && base0 === 'A') notes.push('可信度由 A 降为 B（因含推断成分）');
        return {
          ...base,
          nutritionName: row.productName,
          nutrition: row,
          method: 'alias',
          confidence,
          risky: rule.risky ?? false,
        };
      }
      notes.push(`别名指向「${rule.nutrition}」，但营养表中未找到该品名，判为未匹配`);
    }

    // 优先级 5：**份量歧义**——同名有多个份量，请用户明确，而非替他猜一个
    if (this.detectSizeFamilies) {
      const candidates = this.getSizeCandidates(key);
      if (candidates.length >= 2) {
        notes.push(
          `该名称在官方营养表里对应 ${candidates.length} 种份量（${candidates.map((c) => c.size).join('/')}），` +
            '**需明确份量后才能给出营养**——此处不替用户猜测',
        );
        return {
          ...base,
          nutritionName: null,
          nutrition: null,
          method: 'size-ambiguous',
          confidence: 'D',
          sizeCandidates: candidates,
        };
      }
    }

    // 优先级 6：不猜
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
    menuItems: readonly MenuItemKey[],
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
    variant: 0,
    'size-ambiguous': 0,
    unmatched: 0,
  };
  const byConfidence: Record<Confidence, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of results) {
    byMethod[r.method]++;
    byConfidence[r.confidence]++;
  }
  const total = results.length;
  // 「份量歧义」不算未命中——它是「可解但需用户补一个输入」，统计上单列
  const matched = total - byMethod.unmatched - byMethod['size-ambiguous'];
  return {
    total,
    byMethod,
    byConfidence,
    coverage: total === 0 ? 0 : matched / total,
  };
}
