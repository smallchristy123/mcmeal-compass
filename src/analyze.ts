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
 * 数据来源的**执行事实**（v3 整改，评审 R7；R13 补强）。
 *
 * 由**取数方**（McpClient 或夹具加载器）在**实际调用点**产生，解释层只引用、不臆造：
 * 离线读夹具就如实记 `channel: 'offline' / ok: false`，
 * 绝不再出现「夹具加载被写成一次成功的 query-meals 调用」，
 * 也**不按"live 上下文"推断某次调用成功**。
 */
export interface DataSourceReceipt {
  tool: 'query-meals' | 'query-meal-detail' | 'list-nutrition-foods';
  /** live = 本次真实调用；offline = 读本地夹具；history = 引用历史快照留档 */
  channel: 'live' | 'offline' | 'history';
  ok: boolean;
  at: string;
  argsSummary: string;
  errorCode?: string;
  /** 失败说明（脱敏后） */
  errorMessage?: string;
  /** 离线/历史来源须写明快照 id，便于核对"这份数据是哪个快照" */
  snapshotId?: string;
  /** 数据获取阶段（R13）：菜单 / 营养 / 套餐详情 */
  stage?: 'menu' | 'nutrition' | 'combo-detail';
  /** 本地关联号：同一条数据的多次调用可据此关联（R13） */
  requestId?: string;
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

/**
 * **主件**识别（v3.2；源自 35 条分层样本复核——该样本为 AI 辅助预填，待主君确认）：
 * 汉堡/主食类若未收录，整份套餐的「已知部分之和」会**严重偏低**
 * （实例：龙焰芝士棒鸡腿堡三件套 436 kcal 只等于「中薯条 289 + 可乐 147」，汉堡本体缺失）。
 */
const STAPLE_RE = /(汉堡|主食|主餐|主件|肉夹|堡|卷|饭|面|披萨|巨无霸|麦香鸡|麦香鱼|鸡排)/;
/** 非食品周边（玩具/贴纸/搪胶等）——不计入「主件缺失」判定，避免误伤 */
const NON_FOOD_RE = /(玩具|贴纸|帽|捶|挠|公仔|徽章|盲盒|手办|水手)/;
/**
 * 轮次名里含「并列的小食/配菜/饮品」时，**轮次名不足以判定主件**
 * （实例：「选择主食/小食」这个轮次里可能选到薯条、麦乐鸡——它们不是主件）。
 */
const MIXED_ROUND_RE = /(小食|配菜|副食|饮品|饮料|甜品|冰品|沙拉|汤)/;

/**
 * 某个未匹配组件是否属于「主件」（决定是否还敢给营养数字）。
 *
 * v3.3（复评 P1/P2）：**优先按 choiceName 判定**；仅当选项名不是主件、且轮次语义明确
 * （**不含**「小食/配菜」这类并列项）时，才用轮次名兜底。
 * 修前写法 `STAPLE_RE.test(roundName) || STAPLE_RE.test(choiceName)` 会把
 * 「选择主食/小食 + 中薯条」误判为主件缺失，导致整单降 D、营养数字被清空。
 */
export function isStapleComponent(roundName: string, choiceName: string): boolean {
  if (NON_FOOD_RE.test(choiceName) || NON_FOOD_RE.test(roundName)) return false;
  // ① 选项名明确是主件 → 是（优先看选项本身）
  if (STAPLE_RE.test(choiceName)) return true;
  // ② 选项名不是主件时，只有轮次语义明确才兜底；含并列小食的轮次名不作主件信号
  if (MIXED_ROUND_RE.test(roundName)) return false;
  return STAPLE_RE.test(roundName);
}

/** 把合计整体「抹平为零缺失」——用于「不给数字」的情形（**不是**填 0） */
function blankTotals(totals: NutritionTotals): NutritionTotals {
  const out = {} as NutritionTotals;
  for (const f of NUMERIC_FIELDS) {
    out[f] = { value: null, complete: false, knownCount: 0, totalCount: totals[f].totalCount };
  }
  return out;
}

/** 取数来源上下文：让「分析」能够如实地把执行事实写进结果（评审 R7） */
export interface DataSourceContext {
  channel: 'live' | 'offline' | 'history';
  /** 取数时刻（ISO 或响应里的 datetime） */
  at: string;
  /** 离线/历史来源须标明快照 id */
  snapshotId?: string;
}

/**
 * 由来源上下文生成**兜底**的工具轨迹（live 才 ok:true）。
 *
 * ⚠️ R13：这只是**没有真实收据时**的退路。正常路径应由取数方在实际调用点产生收据
 * （`options.sourceReceipts`），或由 `analyzeMenu` 在**调用套餐详情处**按实际结果产生。
 * **不得**用「live 上下文」去推断一次具体调用成功。
 */
/**
 * 由来源上下文生成**兜底**的工具轨迹。
 *
 * ⚠️ R13 / v3.3（复评 P2）：这只是**没有真实收据时**的退路，而且**永远不得合成 `ok:true`**——
 * 那等于报告一次「没有发生过的成功调用」。取数方应在真实调用点产生收据
 * （`options.sourceReceipts`，或 `analyzeMenu` 在详情调用处产生的 detailReceipt）；
 * 若渠道是 `live` 却没有真实收据，如实记 `LIVE_RECEIPT_MISSING`（**不是**成功）；
 * 离线/历史来源记 `OFFLINE_FIXTURE` / `HISTORY_SNAPSHOT`，同样不是成功。
 */
function synthReceipts(
  tools: readonly ('query-meals' | 'query-meal-detail' | 'list-nutrition-foods')[],
  source: DataSourceContext | undefined,
  argsSummary = 'storeCode=<已脱敏>',
): DataSourceReceipt[] | undefined {
  if (!source) return undefined;
  const live = source.channel === 'live';
  return tools.map((tool) => ({
    tool,
    channel: source.channel,
    // ← 合成即「无真实收据」：一律 ok=false，绝不因「上下文是 live」就报成功（v3.3）
    ok: false,
    at: source.at,
    argsSummary,
    errorCode: live
      ? 'LIVE_RECEIPT_MISSING'
      : source.channel === 'offline'
        ? 'OFFLINE_FIXTURE'
        : 'HISTORY_SNAPSHOT',
    ...(live || source.snapshotId === undefined ? {} : { snapshotId: source.snapshotId }),
  }));
}

/**
 * 分析一个单品（或无法展开的项）：直接匹配营养表。
 *
 * @param variant 用户**显式指定**的份量或口味（计划书 §5.3.3 的 `variant` 维度）。
 *   指定后匹配器会走 `variant` 优先级；不指定则遇到歧义时**列候选请用户选**。
 * @param source 取数来源（缺省则不留执行轨迹——**不留 ≠ 谎报成功**）
 * @param receipts 取数方在**实际调用点**产生的收据（优先使用；缺省才退回按来源兜底合成）
 */
export function analyzeSingle(
  item: MenuItem,
  matcher: NutritionMatcher,
  variant?: string,
  source?: DataSourceContext,
  receipts?: DataSourceReceipt[],
): AnalyzedItem {
  const m = matcher.match({ code: item.code, name: item.name, ...(variant ? { variant } : {}) });
  const notes = [...m.notes];

  if (!m.nutrition) {
    notes.push('未能匹配到官方营养记录——不提供营养数字（D 级）');
  }

  // kJ/kcal 换算一致性（计划书 §5.3.7）：不一致即视为数据异常，降级且不入完整推荐
  const dataAnomalies: string[] = [];
  // v3.6（甲案）：把「匹配方式」与「是否含推断」一并交给判据，
  // 使 **A 级（官方单品精确直配且无推断）真正可达**——此前该档对单品永远关闭。
  let confidence = assignConfidence(m.nutrition, { method: m.method, risky: m.risky });
  if (m.nutrition) {
    const check = checkEnergyConsistency(m.nutrition);
    if (check.status === 'inconsistent') {
      dataAnomalies.push(`${m.nutrition.productName}：${check.detail}`);
      notes.push(`⚠️ 该条营养数据换算不一致，已降级为 C（不再参与完整营养推荐）`);
      if (confidence === 'A' || confidence === 'B') confidence = 'C';
    }
  }

  const trace = receipts ?? synthReceipts(['query-meals'], source);
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
  receipts?: DataSourceReceipt[],
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

  const trace = receipts ?? synthReceipts(['query-meals', 'query-meal-detail'], source);

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

  // ── 主件未收录 ⇒ **不给营养数字**（v3.2；源自 35 条分层样本复核：AI 辅助预填，待主君确认）──
  // 为什么必须这么严：漏掉主件时「已知部分之和」会低到误导（436 kcal 里没有汉堡），
  // `≥` 标记不足以抵消；按铁律「信息不足时坦率少给」，此时**不提供数字**并降为 D。
  const stapleMissing = d.components.filter(
    (c) => c.match.method === 'unmatched' && isStapleComponent(c.roundName, c.choiceName),
  );
  let totals = d.totals;
  if (stapleMissing.length > 0) {
    totals = blankTotals(d.totals);
    confidence = 'D';
    notes.push(
      `主件未收录：${stapleMissing.map((c) => c.choiceName).join('、')} 在官方营养表中**没有对应条目**，` +
        `已知组件之和**不具代表性**（会让热量严重偏低）——故本项**不提供营养数字**（D 级），` +
        `仅可确认其组成与价格。`,
    );
  }

  return {
    code: item.code,
    name: item.name,
    price: item.currentPrice,
    category: item.category ?? null,
    kind: 'combo',
    totals,
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
   * 取数来源（评审 R7）：传入后，本条结果会带上**如实的**工具轨迹。
   * 不传则不留轨迹——**不留轨迹好过臆造一条成功的调用**。
   */
  source?: DataSourceContext;
  /**
   * 取数方在**实际调用点**产生的收据（菜单 / 营养表等）——R13 要求收据来自真实调用处。
   * 传入后作为每条结果的轨迹基底；**缺省才**退回按 `source` 兜底合成。
   */
  sourceReceipts?: DataSourceReceipt[];
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

  // 轨迹基底：优先用取数方在真实调用点产生的收据；缺省才按来源兜底合成（R13）
  const baseReceipts =
    options.sourceReceipts ?? synthReceipts(['query-meals'], source) ?? [];
  let detailSeq = 0;

  /** 在**套餐详情的实际调用点**产生收据：成功 / 空详情 / 失败都可区分（R13） */
  const detailReceipt = (
    code: string,
    ok: boolean,
    errorCode?: string,
    errorMessage?: string,
  ): DataSourceReceipt => {
    const channel = source?.channel ?? 'live';
    // 离线/历史来源**不是真实调用**——即使成功展开，也不得记成 ok:true（R7/R13）
    const live = channel === 'live';
    const effectiveOk = ok && live;
    return {
      tool: 'query-meal-detail',
      channel,
      ok: effectiveOk,
      at: new Date().toISOString(),
      argsSummary: `code=${code}（storeCode=<已脱敏>）`,
      stage: 'combo-detail' as const,
      requestId: `${code}#${++detailSeq}`,
      ...(effectiveOk
        ? {}
        : { errorCode: errorCode ?? (live ? 'DETAIL_LOAD_FAILED' : 'OFFLINE_FIXTURE') }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
      ...(source?.snapshotId === undefined ? {} : { snapshotId: source.snapshotId }),
    };
  };
  const traceOf = (extra?: DataSourceReceipt): DataSourceReceipt[] =>
    extra ? [...baseReceipts, extra] : [...baseReceipts];

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
            // 成功展开：写入**成功**收据（含实际商品码与关联号）
            const receipt = detailReceipt(item.code, true);
            results[idx] = analyzeCombo(item, detail, matcher, [], source, traceOf(receipt));
            onProgress?.(++done, list.length);
            continue;
          }
          // 空详情：可区分的状态，不是"成功"
          const receipt = detailReceipt(
            item.code,
            false,
            'EMPTY_DETAIL',
            '套餐详情为空或无可展开轮次',
          );
          results[idx] = analyzeSingle(item, matcher, variantOf(item.code), source, traceOf(receipt));
          results[idx]!.notes.push('套餐详情不可用，已降级为「直接匹配」——结果可能不完整');
        } catch (e) {
          // 抛错：写入**失败**收据（此前这里只写 notes，轨迹里没有真实失败记录——R13）
          const err = e as { code?: string; message?: string };
          const receipt = detailReceipt(
            item.code,
            false,
            err.code ?? 'DETAIL_LOAD_FAILED',
            err.message ?? String(e),
          );
          results[idx] = analyzeSingle(item, matcher, variantOf(item.code), source, traceOf(receipt));
          results[idx]!.notes.push(
            `套餐详情获取失败（${err.message ?? String(e)}），已降级为直接匹配`,
          );
        }
        onProgress?.(++done, list.length);
        continue;
      }

      results[idx] = analyzeSingle(item, matcher, variantOf(item.code), source, traceOf());
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
