/**
 * 麦麦营养管家 · 命令行入口（最薄竖切）
 *
 * 目标：把数据层串成**一条能被人看见的链路**——
 *   门店 → 菜单 → 逐项营养分析（单品直配 / 套餐展开）→ 可读输出。
 *
 * 用法：
 *   node src/cli.ts --offline                        # 用离线夹具，**无需 Token**
 *   node src/cli.ts --city 重庆市 --keyword 观音桥    # 在线（需 MCD_MCP_TOKEN）
 *   node src/cli.ts --offline --top 30 --sort protein
 *   node src/cli.ts --offline --json                 # 供程序消费
 */

import { NutritionMatcher, type Confidence } from './matching.ts';
import { DEFAULT_ALIASES } from './aliases.ts';
import { analyzeMenu, type AnalyzedItem } from './analyze.ts';
import { loadFixtures, fixtureDetailLoader } from './fixtures.ts';
import { McpClient, McpError } from './mcp-client.ts';
import { formatCents } from './money.ts';
import { parseToon } from './toon.ts';
import { toNutritionRows, type MenuItem, type MealDetail, type NutritionRow } from './schema.ts';
import type { Priority } from './constraints.ts';
import { recommendForMenu, type Recommendation } from './recommend.ts';
import type { Pricer } from './pricing.ts';
import type { PriceResult } from './schema.ts';
import { pathToFileURL } from 'node:url';

// ─────────────────── 参数解析 ───────────────────

interface CliOptions {
  offline: boolean;
  store?: string;
  city?: string;
  keyword?: string;
  top: number;
  sort: 'kcal' | 'protein' | 'price';
  json: boolean;
  /** 给定预算即进入「推荐模式」 */
  budget?: number;
  priority: Priority;
  targetKcal?: number;
  minProtein?: number;
  avoidSugary: boolean;
  declaredAllergy: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    offline: false,
    top: 15,
    sort: 'kcal',
    json: false,
    priority: 'balance',
    avoidSugary: false,
    declaredAllergy: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--offline': opts.offline = true; break;
      case '--store': opts.store = next(); break;
      case '--city': opts.city = next(); break;
      case '--keyword': opts.keyword = next(); break;
      case '--top': opts.top = Number(next() ?? 15) || 15; break;
      case '--budget': opts.budget = Number(next()); break;
      case '--target-kcal': opts.targetKcal = Number(next()); break;
      case '--min-protein': opts.minProtein = Number(next()); break;
      case '--avoid-sugary': opts.avoidSugary = true; break;
      case '--declared-allergy': opts.declaredAllergy = true; break;
      case '--priority': {
        const v = next();
        if (v === 'budget' || v === 'protein' || v === 'balance') opts.priority = v;
        break;
      }
      case '--sort': {
        const v = next();
        if (v === 'protein' || v === 'price' || v === 'kcal') opts.sort = v;
        break;
      }
      case '--json': opts.json = true; break;
      default: break;
    }
  }
  return opts;
}

const USAGE = `
麦麦营养管家 · 门店营养速览 / 预算推荐

  概览模式
    node src/cli.ts --offline                      用离线夹具（无需 Token）
    node src/cli.ts --city 重庆市 --keyword 观音桥   在线模式（需 MCD_MCP_TOKEN）

  推荐模式（给出 --budget 即进入）
    node src/cli.ts --offline --budget 35 --priority protein
    node src/cli.ts --offline --budget 35 --min-protein 25 --avoid-sugary

可选：
  --store <code>     直接指定门店编码
  --top <n>          概览展示前 n 条（默认 15）
  --sort kcal|protein|price   概览排序（默认 kcal）
  --budget <元>      预算（给此项即输出三方案）
  --priority budget|protein|balance   偏好（默认 balance）
  --target-kcal <n>  本餐热量目标（不填则不参与评分）
  --min-protein <g>  最低蛋白质
  --avoid-sugary     避开含糖饮料
  --declared-allergy 已声明过敏（触发安全闸：不再声称「安全」）
  --json             输出 JSON
`;

// ─────────────────── 取数 ───────────────────

interface Sourced {
  storeCode: string;
  storeName: string;
  capturedAt: string;
  items: MenuItem[];
  nutritionRows: NutritionRow[];
  loadDetail: (code: string) => Promise<MealDetail | null>;
  /** 官方计价器；离线模式返回 null（上层会如实标注「未核实实付」） */
  price: Pricer;
  modeLabel: string;
}

/** 离线：读夹具 */
async function loadFromFixtures(): Promise<Sourced> {
  const b = await loadFixtures();
  return {
    storeCode: b.storeCode,
    storeName: b.storeName,
    capturedAt: b.capturedAt,
    items: b.menuItems,
    nutritionRows: b.nutritionRows,
    loadDetail: fixtureDetailLoader(b),
    // 离线夹具里只有一份计价留档，不足以覆盖所有候选；
    // 故返回 null，让计价环节**如实降级为「菜单价、未核实实付」**（而不是假装已核实）
    price: async () => null,
    modeLabel: '离线夹具（无需 Token）',
  };
}

/** 在线：真实 MCP */
async function loadFromMcp(opts: CliOptions): Promise<Sourced> {
  const token = process.env['MCD_MCP_TOKEN'] ?? '';
  if (!token) {
    throw new McpError('NO_TOKEN', '未设置环境变量 MCD_MCP_TOKEN');
  }
  const client = new McpClient({ url: process.env['MCD_MCP_URL'] ?? 'https://mcp.mcd.cn', token });
  const info = await client.initialize();

  let storeCode = opts.store;
  let storeName = `门店 ${storeCode ?? '未知'}`;

  if (!storeCode) {
    const city = opts.city ?? '重庆市';
    const keyword = opts.keyword ?? '';
    const stores = await client.searchStores({ city, keyword });
    if (stores.length === 0) {
      throw new McpError('BAD_RESPONSE', `未在「${city} ${keyword}」找到门店，请换个关键词`);
    }
    const first = stores[0]!;
    storeCode = first.storeCode;
    storeName = first.storeName;
  }

  const { items } = await client.getMenu({ storeCode, orderType: 1, beType: 1 });

  // 营养表（在线模式下单独取一次）
  const nutData = (await client.callTool('list-nutrition-foods', {})) as { data?: string };
  if (typeof nutData?.data !== 'string') {
    throw new McpError('BAD_RESPONSE', '营养表返回结构异常（缺 data 字段）');
  }
  const nutritionRows = toNutritionRows(parseToon(nutData.data)).rows;

  const detailCache = new Map<string, MealDetail | null>();
  const loadDetail = async (code: string) => {
    if (detailCache.has(code)) return detailCache.get(code) ?? null;
    try {
      const d = await client.getMealDetail({ storeCode: storeCode!, orderType: 1, beType: 1, code });
      detailCache.set(code, d);
      return d;
    } catch {
      detailCache.set(code, null);
      return null;
    }
  };

  const priceCache = new Map<string, PriceResult | null>();
  const price: Pricer = async (item) => {
    if (priceCache.has(item.code)) return priceCache.get(item.code) ?? null;
    try {
      const p = await client.calculatePrice({
        storeCode: storeCode!,
        orderType: 1,
        beType: 1,
        items: [{ productCode: item.code, quantity: 1 }],
      });
      priceCache.set(item.code, p);
      return p;
    } catch {
      priceCache.set(item.code, null);
      return null;
    }
  };

  return {
    storeCode,
    storeName,
    capturedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    items,
    nutritionRows,
    loadDetail,
    price,
    modeLabel: `实时调用（mcd-mcp ${info.version ?? ''}）`.trim(),
  };
}

// ─────────────────── 展示 ───────────────────

const CONF_LABEL: Record<Confidence, string> = {
  A: 'A 官方单品',
  B: 'B 可追溯组合',
  C: 'C 部分可知',
  D: 'D 无法验证',
};

const bar = (n: number, max: number, width = 20) =>
  '█'.repeat(max === 0 ? 0 : Math.max(n === 0 ? 0 : 1, Math.round((n / max) * width)));

/** 取排序用的数值：值 + 是否不完整（不完整的排后面，避免「部分合计」被当成小热量排到前头） */
function sortKey(item: AnalyzedItem, by: CliOptions['sort']): { v: number; incomplete: boolean } {
  if (by === 'price') {
    return { v: item.price ?? Number.POSITIVE_INFINITY, incomplete: item.price === null };
  }
  const t = by === 'protein' ? item.totals.protein : item.totals.energyKcal;
  if (t.value === null) return { v: Number.POSITIVE_INFINITY, incomplete: true };
  return { v: t.value, incomplete: !t.complete };
}

/**
 * 展示数值：**不完整时前置 `≥`**——因为那只是「已知部分之和」，
 * 真实值只会更大。不标出来就是把部分当全部，属于我们不接受的失实。
 */
function fmtCell(v: number | null, unit: string, complete = true): string {
  if (v === null) return '—';
  return `${complete ? '' : '≥'}${v}${unit}`;
}

export function renderText(
  src: Sourced,
  items: AnalyzedItem[],
  summary: Awaited<ReturnType<typeof analyzeMenu>>['summary'],
  opts: CliOptions,
): string {
  const L: string[] = [];
  const line = '═'.repeat(64);

  L.push(line);
  L.push('麦麦营养管家 · 门店营养速览');
  L.push(line);
  L.push(`门店    ${src.storeName}${src.storeCode ? `（${src.storeCode}）` : ''}`);
  L.push(`数据    ${src.capturedAt}　·　${src.modeLabel}`);
  L.push(`菜单    ${src.items.length} 项 → 去重后 ${summary.total} 项`);
  L.push(`        其中套餐 ${summary.combos} 项 · 单品 ${summary.singles} 项`);
  L.push('');

  L.push('【营养可信度分布】');
  const maxC = Math.max(...Object.values(summary.byConfidence), 1);
  for (const c of ['A', 'B', 'C', 'D'] as Confidence[]) {
    const n = summary.byConfidence[c];
    L.push(`  ${CONF_LABEL[c].padEnd(14, ' ')} ${String(n).padStart(4)}  ${bar(n, maxC)}`);
  }
  const pct = summary.total === 0 ? 0 : (summary.usable / summary.total) * 100;
  L.push(`  ${'─'.repeat(34)}`);
  L.push(`  可用（非 D 级）  ${summary.usable} / ${summary.total} = ${pct.toFixed(1)}%`);
  L.push(`  完整可信（A/B）  ${summary.solid} / ${summary.total}`);
  L.push('');

  const usable = items
    .filter((i) => i.confidence !== 'D')
    .slice()
    .sort((a, b) => {
      const ka = sortKey(a, opts.sort);
      const kb = sortKey(b, opts.sort);
      if (ka.incomplete !== kb.incomplete) return ka.incomplete ? 1 : -1; // 不完整的沉底
      return ka.v - kb.v;
    });

  const sortLabel = { kcal: '热量', protein: '蛋白质', price: '价格' }[opts.sort];
  L.push(`【有官方营养依据的条目 · 按${sortLabel}升序 · 前 ${Math.min(opts.top, usable.length)} 条】`);
  L.push('   #  名称                        价格       热量      蛋白   脂肪   碳水   级别');
  usable.slice(0, opts.top).forEach((it, i) => {
    const name = it.name.length > 22 ? `${it.name.slice(0, 21)}…` : it.name;
    L.push(
      `  ${String(i + 1).padStart(2)}  ${name.padEnd(24)}` +
        `${(it.price === null ? '—' : formatCents(it.price)).padStart(8)}  ` +
        `${fmtCell(it.totals.energyKcal.value, ' kcal', it.totals.energyKcal.complete).padStart(10)}  ` +
        `${fmtCell(it.totals.protein.value, 'g', it.totals.protein.complete).padStart(6)}  ` +
        `${fmtCell(it.totals.fat.value, 'g', it.totals.fat.complete).padStart(5)}  ` +
        `${fmtCell(it.totals.carbohydrate.value, 'g', it.totals.carbohydrate.complete).padStart(5)}   ${it.confidence}`,
    );
  });
  const anyPartial = usable.slice(0, opts.top).some((it) => !it.totals.energyKcal.complete);
  if (anyPartial) {
    L.push('  （`≥` 表示该套餐有组件未匹配到官方营养，此数仅为**已知部分之和**，真实值只会更大）');
  }
  L.push('');

  const ambiguous = items.filter((i) => (i.sizeCandidates?.length ?? 0) >= 2);
  if (ambiguous.length > 0) {
    L.push(`【需明确份量后才能给营养 · 共 ${ambiguous.length} 项】`);
    for (const it of ambiguous) {
      L.push(`  · ${it.name}　可选份量：${it.sizeCandidates!.map((c) => c.size).join(' / ')}`);
    }
    L.push('  （这类不是「不知道」，而是「等你补一个份量」——本项目不替你猜）');
    L.push('');
  }

  const unknown = items.filter((i) => i.confidence === 'D' && (i.sizeCandidates?.length ?? 0) < 2);
  if (unknown.length > 0) {
    L.push(`【无法给出营养数字的条目 · 共 ${unknown.length} 项 · 列前 8】`);
    for (const it of unknown.slice(0, 8)) {
      const why = it.unmatchedComponents.length > 0 ? `未收录：${it.unmatchedComponents.join('、')}` : '营养表未收录';
      L.push(`  · ${it.name}　（${why}）`);
    }
    if (unknown.length > 8) L.push(`  …另有 ${unknown.length - 8} 项`);
    L.push('');
  }

  L.push('说明：');
  L.push('  · 只展示有官方依据的数字；未匹配到官方营养的条目一律不给数字（D 级），绝不填 0。');
  L.push('  · 套餐营养由 query-meal-detail 展开后逐件求和；有缺项时只给「已知部分」（标 ≥）。');
  L.push('  · 本页为公开菜单与营养数据的展示，不构成医疗或营养建议；以官方渠道为准。');
  L.push(line);
  return L.join('\n');
}

// ─────────────────── 主流程 ───────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const opts = parseArgs(argv);

  let src: Sourced;
  try {
    src = opts.offline ? await loadFromFixtures() : await loadFromMcp(opts);
  } catch (e) {
    const err = e as McpError;
    process.stderr.write(`\n[取数失败] ${err.message}\n`);
    if (err.hint) process.stderr.write(`提示：${err.hint}\n\n`);
    process.exitCode = 1;
    return;
  }

  const out = await runAnalysis(src, opts, (done, total) => {
    if (!opts.json && process.stderr.isTTY && Date.now() - lastTick > 400) {
      lastTick = Date.now();
      process.stderr.write(`\r  分析中 ${done}/${total}`);
    }
  });
  if (!opts.json && process.stderr.isTTY) process.stderr.write(`\r${' '.repeat(30)}\r`);
  process.stdout.write(out);
}

let lastTick = 0;

/** 渲染三方案（决策内核的可读出口） */
export function renderRecommendation(rec: Recommendation, src: Sourced, opts: CliOptions): string {
  const L: string[] = [];
  const line = '═'.repeat(64);
  const PR_LABEL: Record<Priority, string> = { budget: '预算优先', protein: '蛋白质优先', balance: '均衡优先' };

  L.push(line);
  L.push('麦麦营养管家 · 三方案推荐');
  L.push(line);
  L.push(`门店    ${src.storeName}${src.storeCode ? `（${src.storeCode}）` : ''}`);
  L.push(`数据    ${src.capturedAt}　·　${src.modeLabel}`);
  L.push(`预算    ¥${(opts.budget ?? 0).toFixed(2)}　·　偏好 ${PR_LABEL[opts.priority]}`);
  const extras: string[] = [];
  if (opts.minProtein !== undefined) extras.push(`最低蛋白 ${opts.minProtein}g`);
  if (opts.targetKcal !== undefined) extras.push(`热量目标 ${opts.targetKcal} kcal`);
  if (opts.avoidSugary) extras.push('避开含糖饮料');
  if (extras.length) L.push(`条件    ${extras.join('　·　')}`);
  L.push('');

  if (rec.safetyNotice) {
    L.push('⚠️ 【安全提示 · 必读】');
    L.push(`  ${rec.safetyNotice}`);
    L.push('');
  }

  if (rec.plans.length === 0) {
    L.push('【结果】');
    L.push(`  ${rec.shortfallNote ?? '没有可用方案。'}`);
    if (rec.overBudgetNote) {
      L.push('');
      L.push('【备选（需你明确同意才算数）】');
      L.push(`  ${rec.overBudgetNote}`);
    }
    L.push('');
  } else {
    rec.plans.forEach((p, i) => {
      const it = p.priced.item;
      const t = it.totals;
      L.push(`【方案 ${i + 1} · ${p.label}】`);
      L.push(`  名称    ${it.name}（${it.kind === 'combo' ? `套餐·${it.evidence.length - 1} 项组成` : '单品'}）`);
      L.push(
        `  实付    ${p.priced.effectivePrice === null ? '—' : formatCents(p.priced.effectivePrice)}` +
          `${p.priced.priceSource === 'official' ? '（官方计价已核实）' : '（菜单价，未核实实付）'}`,
      );
      const fmt = (v: number | null, u: string, complete = true) =>
        v === null ? '—' : `${complete ? '' : '≥'}${v}${u}`;
      L.push(
        `  营养    ${fmt(t.energyKcal.value, ' kcal', t.energyKcal.complete)}　·　` +
          `蛋白 ${fmt(t.protein.value, 'g', t.protein.complete)}　·　` +
          `脂肪 ${fmt(t.fat.value, 'g', t.fat.complete)}　·　` +
          `碳水 ${fmt(t.carbohydrate.value, 'g', t.carbohydrate.complete)}　·　` +
          `钠 ${fmt(t.sodium.value, 'mg', t.sodium.complete)}（可信度 ${it.confidence}）`,
      );
      L.push(`  理由    ${p.reason}`);
      L.push(
        `  分量    ${[
          p.score.budgetScore === null ? '价格—' : `价格 ${(p.score.budgetScore * 100).toFixed(0)}`,
          p.score.proteinScore === null ? '蛋白—' : `蛋白 ${(p.score.proteinScore * 100).toFixed(0)}`,
          p.score.energyFit === null ? '热量吻合—' : `热量吻合 ${(p.score.energyFit * 100).toFixed(0)}`,
        ].join(' · ')}（综合 ${(p.score.total * 100).toFixed(0)}/100）`,
      );
      L.push(`  依据    ${p.explanation.evidenceIds.join('　')}`);
      for (const s of p.explanation.statements) L.push(`  ${s}`);
      L.push('');
    });
  }

  if (rec.shortfallNote && rec.plans.length > 0) {
    L.push(`【说明】${rec.shortfallNote}`);
    L.push('');
  }
  if (rec.notes.length > 0) {
    L.push('【推导过程】');
    for (const n of rec.notes) L.push(`  · ${n}`);
    L.push('');
  }

  L.push('说明：');
  L.push('  · 所有数值均由程序计算；缺失一律标 — 或 ≥，绝不填 0 冒充。');
  L.push('  · 权重为产品内部启发式，**不是医学标准**，也不构成营养建议。');
  L.push('  · 官方计价未取得时以菜单价计，并明确标注「未核实实付」。');
  L.push(line);
  return L.join('\n');
}

/**
 * 跑分析并产出最终输出文本。
 * **导出**以便测试进程内直接调用（本沙箱禁止 spawn 子进程，子进程测试跑不了）。
 */
export async function runAnalysis(
  src: Sourced,
  opts: CliOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const matcher = new NutritionMatcher(src.nutritionRows, { aliases: DEFAULT_ALIASES });
  const { items, summary } = await analyzeMenu(src.items, matcher, src.loadDetail, {
    concurrency: 6,
    ...(onProgress ? { onProgress } : {}),
  });

  // 推荐模式
  if (opts.budget !== undefined) {
    const { recommendation } = await recommendForMenu(
      items,
      {
        budgetCny: opts.budget,
        orderMode: 'pickup',
        storeCode: src.storeCode,
        preferences: {
          priority: opts.priority,
          avoidSugaryDrinks: opts.avoidSugary,
          energyTargetKcal: opts.targetKcal ?? null,
          minimumProteinGrams: opts.minProtein ?? null,
        },
        safety: { allergyDeclared: opts.declaredAllergy },
      },
      src.price,
    );
    if (opts.json) {
      return `${JSON.stringify(
        {
          store: { code: src.storeCode, name: src.storeName },
          capturedAt: src.capturedAt,
          mode: src.modeLabel,
          request: {
            budgetCny: opts.budget,
            priority: opts.priority,
            energyTargetKcal: opts.targetKcal ?? null,
            minimumProteinGrams: opts.minProtein ?? null,
            avoidSugaryDrinks: opts.avoidSugary,
            declaredAllergy: opts.declaredAllergy,
          },
          recommendation,
        },
        null,
        2,
      )}\n`;
    }
    return `${renderRecommendation(recommendation, src, opts)}\n`;
  }

  if (opts.json) {
    return `${JSON.stringify(
      {
        store: { code: src.storeCode, name: src.storeName },
        capturedAt: src.capturedAt,
        mode: src.modeLabel,
        summary,
        items,
      },
      null,
      2,
    )}\n`;
  }
  return `${renderText(src, items, summary, opts)}\n`;
}

/** 供测试：直接跑离线模式并返回输出 */
export async function runOfflineForTest(args: Partial<CliOptions> = {}): Promise<string> {
  const opts: CliOptions = {
    offline: true,
    top: 15,
    sort: 'kcal',
    json: false,
    priority: 'balance',
    avoidSugary: false,
    declaredAllergy: false,
    ...args,
  };
  const src = await loadFromFixtures();
  return runAnalysis(src, opts);
}

export { parseArgs, loadFromFixtures };
export type { CliOptions, Sourced };

// 仅在**直接执行**本文件时才跑主流程（被 import 时不跑）
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main();
}
