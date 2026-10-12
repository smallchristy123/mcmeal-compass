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
import type { Confidence, SizeCandidate, FlavorCandidate } from './matching.ts';
import { NutritionMatcher, assignConfidence, KEY_NUTRIENTS } from './matching.ts';
import { checkEnergyConsistency } from './validate.ts';
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

/**
 * 套餐组件的**结构化**留存（v3 整改，评审 R2）。
 *
 * 此前组件信息只以「展示文案」形式混在 `evidence[].label` 里，于是
 * 「已匹配成功、但含普通可乐」的组件既进不了 `unmatchedComponents`，
 * 也逃过了按名称的避糖检查。现在保留结构化组件，判定依据从「文案」回到「数据」。
 */
export interface ItemComponent {
  /** 所属轮次（如「选择套餐内饮料」） */
  roundName: string;
  /** 选项编码（供计价/组成指纹使用） */
  choiceCode: string;
  /** 选项名（判定与展示用） */
  choiceName: string;
  /** 匹配到的官方营养名；未匹配为 null */
  nutritionName: string | null;
  /** 是否匹配到官方营养（false ⇒ 该组件成分**无法核实**） */
  nutritionMatched: boolean;
  /** 匹配方式（exact/alias/variant/risky/unmatched…）——供审核与解释 */
  method: string;
  quantity: number;
}

/**
 * 数据来源的**执行事实**（v3 整改，评审 R7）。
 *
 * 由**取数方**（McpClient 或夹具加载器）产生，解释层只引用、不臆造：
 * 离线读夹具就如实记 `channel: 'offline' / ok: false`，
 * 绝不再出现「夹具加载被写成一次成功的 query-meals 调用」。
 */
export interface DataSourceReceipt {
  tool: 'query-meals' | 'query-meal-detail' | 'list-nutrition-foods';
  /** live = 本次真实调用；offline = 读本地夹具；history = 引用历史快照留档 */
  channel: 'live' | 'offline' | 'history';
  ok: boolean;
  at: string;
  argsSummary: string;
  errorCode?: string;
  /** 离线/历史来源须写明快照 id，便于核对"这份数据是哪个快照" */
  snapshotId?: string;
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
  /**
   * **结构化组件**（套餐展开后实际选中的那些；单品为空/缺省）——
   * 避糖判定、组成指纹与解释均以此为准，不以展示文案为准。
   */
  components?: ItemComponent[];
  /** 取数执行事实（由取数方产生；缺省表示"无执行证据"，解释层不得臆造） */
  sourceTrace?: DataSourceReceipt[];
  /**
   * **份量歧义候选**（计划书 §5.3.3 的 variant）：
   * 有值时表示「该名称对应多种份量，需用户明确后才能给营养」——
   * 这不是「不知道」，而是「等你补一个输入」。
   */
  sizeCandidates?: SizeCandidate[];
  /** **口味歧义候选**（与份量同类：等用户补一个输入） */
  flavorCandidates?: FlavorCandidate[];
  /**
   * **数据异常**（如 kJ/kcal 换算不符）：该条记录本身有问题，
   * 已据此降级可信度，且**不得**进入完整营养推荐。
   */
  dataAnomalies?: string[];
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

/** 取数来源上下文：让「分析」能够如实地把执行事实写进结果（评审 R7） */
export interface DataSourceContext {
  channel: 'live' | 'offline' | 'history';
  /** 取数时刻（ISO 或响应里的 datetime） */
  at: string;
  /** 离线/历史来源须标明快照 id */
  snapshotId?: string;
}

/** 由来源上下文生成**如实**的工具轨迹（live 才 ok:true） */
function sourceReceipts(
  tools: readonly ('query-meals' | 'query-meal-detail' | 'list-nutrition-foods')[],
  source: DataSourceContext | undefined,
  argsSummary = 'storeCode=<已脱敏>',
): DataSourceReceipt[] | undefined {
  if (!source) return undefined;
  const live = source.channel === 'live';
  return tools.map((tool) => ({
    tool,
    channel: source.channel,
    ok: live,
    at: source.at,
    argsSummary,
    ...(live
      ? {}
      : {
          errorCode:
            source.channel === 'offline' ? 'OFFLINE_FIXTURE' : 'HISTORY_SNAPSHOT',
          snapshotId: source.snapshotId,
        }),
  }));
}

/**
 * 分析一个单品（或无法展开的项）：直接匹配营养表。
 *
 * @param variant 用户**显式指定**的份量或口味（计划书 §5.3.3 的 `variant` 维度）。
 *   指定后匹配器会走 `variant` 优先级；不指定则遇到歧义时**列候选请用户选**。
 * @param source 取数来源（缺省则不留执行轨迹——**不留 ≠ 谎报成功**）
 */
export function analyzeSingle(
  item: MenuItem,
  matcher: NutritionMatcher,
  variant?: string,
  source?: DataSourceContext,
): AnalyzedItem {
  const m = matcher.match({ code: item.code, name: item.name, ...(variant ? { variant } : {}) });
  const notes = [...m.notes];

  if (!m.nutrition) {
    notes.push('未能匹配到官方营养记录——不提供营养数字（D 级）');
  }

  // kJ/kcal 换算一致性（计划书 §5.3.7）：不一致即视为数据异常，降级且不入完整推荐
  const dataAnomalies: string[] = [];
  let confidence = assignConfidence(m.nutrition, false);
  if (m.nutrition) {
    const check = checkEnergyConsistency(m.nutrition);
    if (check.status === 'inconsistent') {
      dataAnomalies.push(`${m.nutrition.productName}：${check.detail}`);
      notes.push(`⚠️ 该条营养数据换算不一致，已降级为 C（不再参与完整营养推荐）`);
      if (confidence === 'A' || confidence === 'B') confidence = 'C';
    }
  }

  const trace = sourceReceipts(['query-meals'], source);
  return {
    code: item.code,
    name: item.name,
    price: item.currentPrice,
    category: item.category ?? null,
    kind: 'single',
    totals: totalsFromSingle(m.nutrition),
    confidence,
    evidence: m.nutrition
      ? [{ kind: 'official-single', label: `官方单品营养：${m.nutrition.productName}` }]
      : [],
    unmatchedComponents: [],
    ...(trace ? { sourceTrace: trace } : {}),
    ...(m.sizeCandidates ? { sizeCandidates: m.sizeCandidates } : {}),
    ...(m.flavorCandidates ? { flavorCandidates: m.flavorCandidates } : {}),
    ...(dataAnomalies.length > 0 ? { dataAnomalies } : {}),
    notes,
  };
}

/** 分析一个套餐：展开后逐件匹配再合计 */
export function analyzeCombo(
  item: MenuItem,
  detail: MealDetail,
  matcher: NutritionMatcher,
  substitutions: readonly SubstitutionRequest[] = [],
  source?: DataSourceContext,
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

  // 结构化组件留存（评审 R2）：判定避糖 / 生成组成指纹都以此为准
  const components: ItemComponent[] = d.components.map((c) => ({
    roundName: c.roundName,
    choiceCode: c.choiceCode,
    choiceName: c.choiceName,
    nutritionName: c.match.nutrition?.productName ?? null,
    nutritionMatched: c.match.nutrition !== null,
    method: c.match.method,
    quantity: c.quantity,
  }));

  const trace = sourceReceipts(['query-meals', 'query-meal-detail'], source);

  // 逐个组件做 kJ/kcal 换算校验——任一组件的记录不可信，整份合计就不可信
  const dataAnomalies: string[] = [];
  const notes = [...d.notes];
  let confidence = d.confidence;
  for (const c of d.components) {
    if (!c.match.nutrition) continue;
    const check = checkEnergyConsistency(c.match.nutrition);
    if (check.status === 'inconsistent') {
      dataAnomalies.push(`${c.match.nutrition.productName}：${check.detail}`);
    }
  }
  if (dataAnomalies.length > 0) {
    notes.push(
      `⚠️ 有 ${dataAnomalies.length} 个组件的营养数据换算不一致，整份合计已降级为 C（不参与完整营养推荐）`,
    );
    if (confidence === 'A' || confidence === 'B') confidence = 'C';
  }

  return {
    code: item.code,
    name: item.name,
    price: item.currentPrice,
    category: item.category ?? null,
    kind: 'combo',
    totals: d.totals,
    confidence,
    evidence,
    unmatchedComponents: d.unmatchedComponents,
    components,
    ...(trace ? { sourceTrace: trace } : {}),
    ...(dataAnomalies.length > 0 ? { dataAnomalies } : {}),
    notes,
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
  /** 触发「数据异常」（如 kJ/kcal 换算不符）而被降级的条目数 */
  dataAnomalies: number;
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
  /**
   * 用户显式指定的份量/口味：`{ 菜单code: '中' | '朱古力' | ... }`（计划书 §5.3.3）。
   * 未指定的条目若遇歧义，照常列候选请用户选——**不替其猜测**。
   */
  variants?: Record<string, string>;
  /**
   * 取数来源（评审 R7）：传入后，每条结果都会带上**如实的**工具轨迹。
   * 不传则不留轨迹——**不留轨迹好过臆造一条成功的调用**。
   */
  source?: DataSourceContext;
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
  const { concurrency = 4, limit, dedupe = true, onProgress, variants, source } = options;
  const variantOf = (code: string): string | undefined => variants?.[code];

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
            results[idx] = analyzeCombo(item, detail, matcher, [], source);
            onProgress?.(++done, list.length);
            continue;
          }
          // 展开不了 → 降级为单品直配
          results[idx] = analyzeSingle(item, matcher, variantOf(item.code), source);
          results[idx]!.notes.push('套餐详情不可用，已降级为「直接匹配」——结果可能不完整');
        } catch (e) {
          results[idx] = analyzeSingle(item, matcher, variantOf(item.code), source);
          results[idx]!.notes.push(
            `套餐详情获取失败（${e instanceof Error ? e.message : String(e)}），已降级为直接匹配`,
          );
        }
        onProgress?.(++done, list.length);
        continue;
      }

      results[idx] = analyzeSingle(item, matcher, variantOf(item.code), source);
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
      dataAnomalies: results.filter((i) => (i.dataAnomalies?.length ?? 0) > 0).length,
    },
  };
}

/** 取「关键营养是否齐全」——供排序门槛使用（A/B 才进有数值约束的推荐） */
export function hasSolidNutrition(item: AnalyzedItem): boolean {
  if (item.confidence !== 'A' && item.confidence !== 'B') return false;
  return KEY_NUTRIENTS.every((f) => item.totals[f as NumericField].value !== null);
}
