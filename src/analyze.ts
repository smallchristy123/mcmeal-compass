/**
 * 营养分析（T1.5）——把「菜单项 → 带可信度的营养结论」收口成一个模块。
 *
 * 上游是两条路（见 MATCHING_NOTES.md）：
 *   · **单品**：直接匹配营养表（实测命中 31%）；
 *   · **套餐**：经 `query-meal-detail` 展开后逐件匹配再合计（实测组件命中 87.6%）。
 *
 * 本模块的职责是**把两条路统一成同一种结果形状**，让上层（推荐、展示）不必关心
 * 它到底走了哪条路——只需读 `confidence` 与 `totals`。
 *
 * 三条不可退让的规矩：
 *   1. **缺失不补零**——`totals[x].value` 只在「确实有已知值」时才给数，否则 null；
 *   2. **可信度必须真实**——D 级不给营养数字，C 级只展示已知部分；
 *   3. **必须可溯源**——每个结论都带 `evidence`，说明数字从哪来。
 */

import type { MenuItem, MealDetail, NutritionRow } from './schema.ts';
import type { Cents } from './money.ts';
import type { Confidence } from './matching.ts';
import { NutritionMatcher, assignConfidence, KEY_NUTRIENTS } from './matching.ts';
import {
  decomposeMeal,
  type NutritionTotals,
  type SubstitutionRequest,
} from './decompose.ts';

/** 结论的来源说明 */
export interface NutritionEvidence {
  kind: 'official-single' | 'official-combo-sum';
  /** 人能看懂的来源描述 */
  label: string;
}

/** 分析后的菜单项 */
export interface AnalyzedItem {
  code: string;
  name: string;
  /** 菜单价（分） */
  price: Cents | null;
  category: string | null;
  kind: 'single' | 'combo';
  /** 统一形状的营养合计（单品亦包成同一形状） */
  totals: NutritionTotals;
  confidence: Confidence;
  evidence: NutritionEvidence[];
  /** 套餐中未匹配到营养的组件名 */
  unmatchedComponents: string[];
  notes: string[];
}

const NUMERIC_FIELDS = ['energyKcal', 'protein', 'fat', 'carbohydrate', 'sodium'] as const;
type NumericField = (typeof NUMERIC_FIELDS)[number];

/** 把单条营养记录包成 NutritionTotals 形状（与套餐合计同构） */
export function totalsFromSingle(row: NutritionRow | null): NutritionTotals {
  const out = {} as NutritionTotals;
  for (const f of NUMERIC_FIELDS) {
    const v = row ? (row[f as keyof NutritionRow] as number | null) : null;
    out[f] = {
      value: v === null || v === undefined ? null : v,
      complete: v !== null && v !== undefined,
      knownCount: v === null || v === undefined ? 0 : 1,
      totalCount: row ? 1 : 0,
    };
  }
  return out;
}

/** 判断一个名称是否「疑似套餐/组合」（无法从 nutrition 表直接取到） */
const COMBO_RE = /(套餐|件套|随心选|双人餐|分享餐|快乐盒|宫格|拼盘|组合|桶)/;
export function looksLikeCombo(name: string): boolean {
  return COMBO_RE.test(name);
}

/** 分析一个单品（或无法展开的项）：直接匹配营养表 */
export function analyzeSingle(item: MenuItem, matcher: NutritionMatcher): AnalyzedItem {
  const m = matcher.match({ code: item.code, name: item.name });
  const notes = [...m.notes];

  if (!m.nutrition) {
    notes.push('未能匹配到官方营养记录——不提供营养数字（D 级）');
  }

  return {
    code: item.code,
    name: item.name,
    price: item.currentPrice,
    category: item.category ?? null,
    kind: 'single',
    totals: totalsFromSingle(m.nutrition),
    confidence: assignConfidence(m.nutrition, false),
    evidence: m.nutrition
      ? [{ kind: 'official-single', label: `官方单品营养：${m.nutrition.productName}` }]
      : [],
    unmatchedComponents: [],
    notes,
  };
}

/** 分析一个套餐：展开后逐件匹配再合计 */
export function analyzeCombo(
  item: MenuItem,
  detail: MealDetail,
  matcher: NutritionMatcher,
  substitutions: readonly SubstitutionRequest[] = [],
): AnalyzedItem {
  const d = decomposeMeal(detail, matcher, substitutions);
  const evidence: NutritionEvidence[] = [
    {
      kind: 'official-combo-sum',
      label: `官方套餐组成求和：${detail.name}（${d.components.length} 项）`,
    },
  ];
  for (const c of d.components) {
    if (c.match.nutrition) {
      evidence.push({
        kind: 'official-single',
        label: `${c.roundName}：${c.choiceName} → ${c.match.nutrition.productName}`,
      });
    }
  }

  return {
    code: item.code,
    name: item.name,
    price: item.currentPrice,
    category: item.category ?? null,
    kind: 'combo',
    totals: d.totals,
    confidence: d.confidence,
    evidence,
    unmatchedComponents: d.unmatchedComponents,
    notes: d.notes,
  };
}

/** 套餐详情加载器（由 MCP 客户端提供；测试中可注入假实现） */
export type ComboDetailLoader = (code: string) => Promise<MealDetail | null>;

export interface MenuAnalysisSummary {
  total: number;
  singles: number;
  combos: number;
  byConfidence: Record<Confidence, number>;
  /** 有可用营养数字的条目（confidence !== 'D'） */
  usable: number;
  /** 其中「完整可信」的条目（A 或 B） */
  solid: number;
}

export interface MenuAnalysis {
  items: AnalyzedItem[];
  summary: MenuAnalysisSummary;
}

export interface AnalyzeMenuOptions {
  /** 并发拉取套餐详情的上限（默认 4，避免打爆限流） */
  concurrency?: number;
  /** 只分析前 N 个（调试用） */
  limit?: number;
  /** 是否对同名同码项去重（默认 true） */
  dedupe?: boolean;
  /** 进度回调（便于 CLI 显示） */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 分析整份菜单。
 *
 * 单品直接匹配；疑似套餐的先拉 `query-meal-detail` 再展开。
 * 拉取失败或该码根本展开不了时，**降级为单品直配**（诚实降级，不假装是套餐）。
 */
export async function analyzeMenu(
  items: readonly MenuItem[],
  matcher: NutritionMatcher,
  loadDetail: ComboDetailLoader,
  options: AnalyzeMenuOptions = {},
): Promise<MenuAnalysis> {
  const { concurrency = 4, limit, dedupe = true, onProgress } = options;

  let list = [...items];
  if (dedupe) {
    const seen = new Set<string>();
    list = list.filter((i) => (seen.has(i.code) ? false : (seen.add(i.code), true)));
  }
  if (limit !== undefined) list = list.slice(0, limit);

  const results: AnalyzedItem[] = new Array(list.length);
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= list.length) return;
      const item = list[idx]!;

      if (looksLikeCombo(item.name)) {
        try {
          const detail = await loadDetail(item.code);
          if (detail && detail.rounds.length > 0) {
            results[idx] = analyzeCombo(item, detail, matcher);
            onProgress?.(++done, list.length);
            continue;
          }
          // 展开不了 → 降级为单品直配
          results[idx] = analyzeSingle(item, matcher);
          results[idx]!.notes.push('套餐详情不可用，已降级为「直接匹配」——结果可能不完整');
        } catch (e) {
          results[idx] = analyzeSingle(item, matcher);
          results[idx]!.notes.push(
            `套餐详情获取失败（${e instanceof Error ? e.message : String(e)}），已降级为直接匹配`,
          );
        }
        onProgress?.(++done, list.length);
        continue;
      }

      results[idx] = analyzeSingle(item, matcher);
      onProgress?.(++done, list.length);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));

  const byConfidence: Record<Confidence, number> = { A: 0, B: 0, C: 0, D: 0 };
  let singles = 0;
  let combos = 0;
  for (const r of results) {
    byConfidence[r.confidence]++;
    if (r.kind === 'combo') combos++;
    else singles++;
  }

  return {
    items: results,
    summary: {
      total: results.length,
      singles,
      combos,
      byConfidence,
      usable: results.length - byConfidence.D,
      solid: byConfidence.A + byConfidence.B,
    },
  };
}

/** 取「关键营养是否齐全」——供排序门槛使用（A/B 才进有数值约束的推荐） */
export function hasSolidNutrition(item: AnalyzedItem): boolean {
  if (item.confidence !== 'A' && item.confidence !== 'B') return false;
  return KEY_NUTRIENTS.every((f) => item.totals[f as NumericField].value !== null);
}
