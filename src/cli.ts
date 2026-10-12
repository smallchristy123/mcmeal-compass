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
import { analyzeMenu, type AnalyzedItem, type DataSourceReceipt } from './analyze.ts';
import { loadFixtures, fixtureDetailLoader } from './fixtures.ts';
import { McpClient, McpError, unwrapToolData } from './mcp-client.ts';
import { createDetailLoader } from './detail-loader.ts';
import { formatCents } from './money.ts';
import { parseToon } from './toon.ts';
import { toNutritionRows, type MenuItem, type MealDetail, type NutritionRow } from './schema.ts';
import type { Priority } from './constraints.ts';
import { recommendForMenu, type Recommendation } from './recommend.ts';
import {
  buildArgsSummary,
  hashResponse,
  requestOf,
  basketOf,
  type PriceAttempt,
  type Pricer,
  type PriceRequest,
} from './pricing.ts';
import { freshnessOf } from './freshness.ts';
import { pathToFileURL } from 'node:url';

// ─────────────────── 参数解析 ───────────────────

interface CliOptions {
  offline: boolean;
  /** 显式指定的份量/口味：菜单名 → 取值 */
  variants: Record<string, string>;
  store?: string;
  city?: string;
  keyword?: string;
  top: number;
  sort: 'kcal' | 'protein' | 'price';
  json: boolean;
  /** 给定预算即进入「推荐模式」 */
  budget?: number;
  priority: Priority;
  /** 候选范围：meal=正餐候选（默认）；all=含单品/加餐 */
  scope: 'meal' | 'all';
  targetKcal?: number;
  minProtein?: number;
  avoidSugary: boolean;
  declaredAllergy: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    offline: false,
    variants: {},
    top: 15,
    sort: 'kcal',
    json: false,
    priority: 'balance',
    scope: 'meal',
    avoidSugary: false,
    declaredAllergy: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--offline': opts.offline = true; break;
      case '--variant': {
        const pair = next() ?? '';
        const idx = pair.indexOf('=');
        if (idx > 0) opts.variants[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
        break;
      }
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
      case '--scope': {
        const v = next();
        if (v === 'meal' || v === 'all') opts.scope = v;
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
  --priority budget|protein|balance   偏好（默认 balance）——**决定首选是哪个视角**（第 1 张卡）
  --scope meal|all   候选范围（默认 meal 正餐候选；all=含单品/加餐比较）
  --target-kcal <n>  本餐热量目标（不填则不参与评分，且不对热量作优劣判断）
  --min-protein <g>  最低蛋白质（**所有批次统一先验**，价格下降不得绕过）
  --avoid-sugary     避开含糖饮料（按**实际选中组件**判定；成分无法核实时不宣称满足）
  --variant <名=值>  显式指定份量/口味，可重复；例：--variant 薯条=中 --variant 新地=朱古力
  --declared-allergy 已声明过敏（触发安全闸：不再声称「安全」）
  --json             输出 JSON（含分数据源新鲜度与执行收据）

⛔ 本版本**不能下单**：create-order 未接入，下单能力已显式关闭（ORDERING_DISABLED）。
   仓库中的下单闸门（order-guard.ts）保证「未确认绝不执行」，但**不代表现在可以下单**。

协议：默认 legacy（2025-06-18，握手时代）；可用 MCD_PROTOCOL_VERSION 指定（如 2026-07-28 走无握手形态）。
`;

// ─────────────────── 取数 ───────────────────

interface Sourced {
  storeCode: string;
  storeName: string;
  capturedAt: string;
  /** 分数据源的产生时刻（评审 P1-4：菜单/营养/套餐/价格分别记录） */
  capturedAtByKind: { menu: string; nutrition: string; detail: string; price: string };
  /** 取数来源（供执行轨迹**如实**标注，评审 R7） */
  dataOrigin: { channel: 'live' | 'offline'; snapshotId?: string };
  /**
   * 取数方在**实际调用点**产生的收据（R13）：
   * 离线＝读夹具（标 OFFLINE_FIXTURE，不伪装成已调用）；在线＝真实调用（标 live/ok）。
   */
  sourceReceipts: DataSourceReceipt[];
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
  const at = new Date().toISOString();
  return {
    storeCode: b.storeCode,
    storeName: b.storeName,
    capturedAt: b.capturedAt,
    capturedAtByKind: {
      menu: b.datetimes.menu,
      nutrition: b.datetimes.nutrition,
      detail: b.datetimes.detail,
      price: b.datetimes.price,
    },
    dataOrigin: { channel: 'offline', snapshotId: b.snapshotId },
    // 读夹具也留**真实**收据：如实标 offline + OFFLINE_FIXTURE（**不**伪装成已调用）
    sourceReceipts: [
      {
        tool: 'query-meals',
        channel: 'offline',
        ok: false,
        at,
        argsSummary: 'storeCode=<已脱敏>（读本地快照）',
        errorCode: 'OFFLINE_FIXTURE',
        snapshotId: b.snapshotId,
        stage: 'menu',
        requestId: `snapshot:${b.snapshotId}#query-meals`,
      },
      {
        tool: 'list-nutrition-foods',
        channel: 'offline',
        ok: false,
        at,
        argsSummary: '（无参数；读本地快照）',
        errorCode: 'OFFLINE_FIXTURE',
        snapshotId: b.snapshotId,
        stage: 'nutrition',
        requestId: `snapshot:${b.snapshotId}#list-nutrition-foods`,
      },
    ],
    items: b.menuItems,
    nutritionRows: b.nutritionRows,
    loadDetail: fixtureDetailLoader(b),
    // 离线夹具里只有一份计价留档，不足以覆盖所有候选；故**不发起**官方计价，
    // 并如实产出一条"未发起"的收据（而不是假装已核实、更不是静默返回 null）
    price: async (item, request) => ({
      quote: null,
      receipt: {
        tool: 'calculate-price',
        argsSummary: buildArgsSummary(request?.items ?? basketOf(item)),
        at: new Date().toISOString(),
        ok: false,
        attempt: 0,
        errorCode: 'OFFLINE',
        errorMessage: '离线模式：夹具不含该候选的计价留档，未发起计价',
        durationMs: 0,
        channel: 'offline',
        stage: request?.stage ?? 'initial',
        ...(request ? { requestFingerprint: request.fingerprint } : {}),
      },
    }),
    modeLabel: `离线夹具（无需 Token · 快照 ${b.snapshotId}）`,
  };
}

/** 在线：真实 MCP */
async function loadFromMcp(opts: CliOptions): Promise<Sourced> {
  const token = process.env['MCD_MCP_TOKEN'] ?? '';
  if (!token) {
    throw new McpError('NO_TOKEN', '未设置环境变量 MCD_MCP_TOKEN');
  }
  const client = new McpClient({
    url: process.env['MCD_MCP_URL'] ?? 'https://mcp.mcd.cn',
    token,
    // 协议口径可由环境变量指定；默认 legacy（对 mcp.mcd.cn 实测可用）
    ...(process.env['MCD_PROTOCOL_VERSION'] ? { protocolVersion: process.env['MCD_PROTOCOL_VERSION'] } : {}),
  });
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

  // 取数收据在**真实调用点**产生（R13）：成功即 ok=true，失败会抛错并被上层捕获
  const sourceReceipts: DataSourceReceipt[] = [];
  const { items } = await client.getMenu({ storeCode, orderType: 1, beType: 1 });
  sourceReceipts.push({
    tool: 'query-meals',
    channel: 'live',
    ok: true,
    at: new Date().toISOString(),
    argsSummary: 'storeCode=<已脱敏>',
    stage: 'menu',
    requestId: 'live#query-meals',
  });

  // 营养表（在线模式下单独取一次）
  // ⚠️ `callTool` 已拆包：返回值**就是 TOON 字符串**；旧代码再取一层 `.data` 会报「缺 data 字段」
  // （真实端点实测踩到——离线夹具不经过此路径，故长期未暴露）
  const nutToon = unwrapToolData(await client.callTool('list-nutrition-foods', {}));
  if (typeof nutToon !== 'string') {
    throw new McpError('BAD_RESPONSE', '营养表返回结构异常（既非 TOON 字符串，也无 data 字段）');
  }
  sourceReceipts.push({
    tool: 'list-nutrition-foods',
    channel: 'live',
    ok: true,
    at: new Date().toISOString(),
    argsSummary: '（无参数）',
    stage: 'nutrition',
    requestId: 'live#list-nutrition-foods',
  });
  const nutritionRows = toNutritionRows(parseToon(nutToon)).rows;

  // 套餐详情加载器：失败**抛出**原始错误（不吞错），并缓存「成功/失败」两态
  const loadDetail = createDetailLoader(client, storeCode!);

  // 缓存键必须含**门店 / 取餐方式 / 商品与数量 / 组成指纹 / 时间窗**——
  // 只按商品码缓存是错的：同一商品在不同门店、不同时间窗、不同组成的报价可能不同（P0-3 / R4）
  const PRICE_WINDOW_MS = 5 * 60_000;
  const priceCache = new Map<string, PriceAttempt>();
  const cacheKeyOf = (request: PriceRequest) =>
    `${storeCode}|1|1|${request.fingerprint}|${Math.floor(Date.now() / PRICE_WINDOW_MS)}`;

  const price: Pricer = async (item, request) => {
    const req: PriceRequest = request ?? requestOf(item, 'initial');
    const key = cacheKeyOf(req);
    // 最终复核**强制绕过缓存**（复核的意义就是"当下再问一次"）；
    // 普通确认可命中缓存，命中时如实标 channel=cache，不虚报为一次新请求。
    const bypassCache = req.stage === 'final';
    const hit = bypassCache ? undefined : priceCache.get(key);
    if (hit) return { ...hit, receipt: { ...hit.receipt, channel: 'cache' } };

    const started = Date.now();
    const base = {
      tool: 'calculate-price' as const,
      argsSummary: buildArgsSummary(req.items),
      at: new Date().toISOString(),
      stage: req.stage,
      requestFingerprint: req.fingerprint,
    };
    try {
      const p = await client.calculatePrice({
        storeCode: storeCode!,
        orderType: 1,
        beType: 1,
        items: req.items.map((l) => ({ productCode: l.productCode, quantity: l.quantity })),
      });
      const attempt: PriceAttempt = {
        quote: p,
        receipt: {
          ...base,
          ok: true,
          attempt: 1,
          responseHash: hashResponse(p),
          durationMs: Date.now() - started,
          channel: 'live',
        },
      };
      priceCache.set(key, attempt);
      return attempt;
    } catch (e) {
      const err = e as { code?: string; message?: string; status?: number };
      const attempt: PriceAttempt = {
        quote: null,
        receipt: {
          ...base,
          ok: false,
          attempt: 1,
          ...(err.code === undefined ? {} : { errorCode: err.code }),
          errorMessage: err.message ?? String(e),
          durationMs: Date.now() - started,
          channel: 'live',
        },
      };
      // 失败也**如实缓存**（含失败原因），避免同一时间窗内反复打同一个必败的请求
      priceCache.set(key, attempt);
      return attempt;
    }
  };

  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return {
    storeCode,
    storeName,
    capturedAt: nowIso,
    // 在线模式的四类数据都产生于本次调用（价格单独用报价收据的时刻）
    capturedAtByKind: { menu: nowIso, nutrition: nowIso, detail: nowIso, price: nowIso },
    dataOrigin: { channel: 'live' },
    sourceReceipts,
    items,
    nutritionRows,
    loadDetail,
    price,
    modeLabel: `实时调用（mcd-mcp ${info.version ?? ''} · 协议 ${info.protocolVersion}/${info.era}）`.trim(),
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
  {
    // ⚠️ 新鲜度：过期的数据**只能作历史样例**，不得以"当前可售/实时价格"的口吻输出
    const f = freshnessOf(src.capturedAt, 'menu');
    L.push(`时效    ${f.note}`);
    if (f.status !== 'fresh') {
      L.push('⛔ 上方数据**不是**「当前可售」状态，也**不是**实时价格——仅作历史样例演示。');
    }
  }
  L.push(`菜单    ${src.items.length} 项 → 去重后 ${summary.total} 项`);
  L.push(`        其中套餐 ${summary.combos} 项 · 单品 ${summary.singles} 项`);
  if (summary.dataAnomalies > 0) {
    L.push(`        ⚠️ 另有 ${summary.dataAnomalies} 项因**营养数据异常**（如 kJ/kcal 换算不符）被排除在完整推荐之外`);
  }
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

  const sizedItems = items.filter((i) => (i.sizeCandidates?.length ?? 0) >= 2);
  const flavoredItems = items.filter((i) => (i.flavorCandidates?.length ?? 0) >= 2);
  if (sizedItems.length > 0) {
    L.push(`【需明确份量后才能给营养 · 共 ${sizedItems.length} 项】`);
    for (const it of sizedItems) {
      L.push(`  · ${it.name}　可选份量：${it.sizeCandidates!.map((c) => c.size).join(' / ')}`);
    }
    L.push('  （这类不是「不知道」，而是「等你补一个份量」——本项目不替你猜）');
    L.push('  指定方式：--variant ' + (sizedItems[0]!.name) + '=' + (sizedItems[0]!.sizeCandidates![0]!.size));
    L.push('');
  }
  if (flavoredItems.length > 0) {
    L.push(`【需明确口味后才能给营养 · 共 ${flavoredItems.length} 项】`);
    for (const it of flavoredItems) {
      L.push(`  · ${it.name}　可选口味：${it.flavorCandidates!.map((c) => c.flavor).join(' / ')}`);
    }
    L.push('  （口味不同就是**不同的东西**——热量与配方都可能不同，绝不互相顶替）');
    L.push('  指定方式：--variant ' + (flavoredItems[0]!.name) + '=' + (flavoredItems[0]!.flavorCandidates![0]!.flavor));
    L.push('');
  }

  const unknown = items.filter(
    (i) => i.confidence === 'D' && (i.sizeCandidates?.length ?? 0) < 2 && (i.flavorCandidates?.length ?? 0) < 2,
  );
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
  {
    const f = freshnessOf(src.capturedAt, 'menu');
    L.push(`时效    ${f.note}`);
    if (f.status !== 'fresh') {
      L.push('⛔ 本结果基于**历史样例数据**，不代表当前可售，价格亦未经实时核价。');
    }
  }
  L.push(
    `预算    ¥${(opts.budget ?? 0).toFixed(2)}　·　偏好 ${PR_LABEL[opts.priority]}　·　` +
      `范围 ${opts.scope === 'all' ? '单品/加餐比较' : '正餐候选'}`,
  );
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
      L.push(`【方案 ${i + 1} · ${p.label}${i === 0 ? '（首选）' : ''}】`);
      L.push(`  名称    ${it.name}（${it.kind === 'combo' ? `套餐·${it.evidence.length - 1} 项组成` : '单品'}）`);
      const srcLabel =
        p.priced.priceSource === 'official' && p.priced.verified
          ? '（官方计价已核实）'
          : p.priced.priceSource === 'official-unverified'
            ? '（初次报价；最终复核未成功——未核实，不代表当前实付）'
            : '（菜单价，未核实实付）';
      L.push(
        `  实付    ${p.priced.effectivePrice === null ? '—' : formatCents(p.priced.effectivePrice)}` +
          srcLabel,
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
  L.push(`【偏好如何生效】${rec.primaryNote}`);
  L.push('');
  if (rec.notes.length > 0) {
    L.push('【推导过程】');
    for (const n of rec.notes) L.push(`  · ${n}`);
    L.push('');
  }

  L.push('说明：');
  L.push('  · 所有数值均由程序计算；缺失一律标 — 或 ≥，绝不填 0 冒充。');
  L.push('  · 权重为**排序偏好（内部启发式）**，不是医学标准，也不构成营养建议。');
  L.push('  · 官方计价未取得时以菜单价计，并明确标注「未核实实付」。');
  L.push('  · ⛔ 本版本**不能下单**：create-order 未接入，下单已显式关闭（ORDERING_DISABLED）。');
  L.push(line);
  return L.join('\n');
}

/** 分数据源的新鲜度（评审 P1-4：文本要给，**JSON 也要给**） */
export function freshnessReport(src: Sourced): {
  generatedAt: string;
  capturedAt: Record<string, string>;
  sources: Record<string, ReturnType<typeof freshnessOf>>;
} {
  return {
    generatedAt: new Date().toISOString(),
    capturedAt: { ...src.capturedAtByKind },
    sources: {
      menu: freshnessOf(src.capturedAtByKind.menu, 'menu'),
      nutrition: freshnessOf(src.capturedAtByKind.nutrition, 'nutrition'),
      'combo-detail': freshnessOf(src.capturedAtByKind.detail, 'combo-detail'),
      price: freshnessOf(src.capturedAtByKind.price, 'price'),
    },
  };
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
  // 把「菜单名 → 份量/口味」的用户指定，翻译成「菜单 code → 取值」
  const variantsByCode: Record<string, string> = {};
  if (Object.keys(opts.variants).length > 0) {
    for (const it of src.items) {
      const v = opts.variants[it.name];
      if (v !== undefined) variantsByCode[it.code] = v;
    }
  }

  const { items, summary } = await analyzeMenu(src.items, matcher, src.loadDetail, {
    concurrency: 6,
    // 取数来源如实下传：离线即 offline（解释层的工具轨迹据此标注，评审 R7）
    source: {
      channel: src.dataOrigin.channel,
      at: new Date().toISOString(),
      ...(src.dataOrigin.snapshotId === undefined ? {} : { snapshotId: src.dataOrigin.snapshotId }),
    },
    // 取数收据来自**实际调用点**（R13）；套餐详情的收据由 analyzeMenu 在调用处补写
    sourceReceipts: src.sourceReceipts,
    ...(onProgress ? { onProgress } : {}),
    ...(Object.keys(variantsByCode).length > 0 ? { variants: variantsByCode } : {}),
  });

  const freshness = freshnessReport(src);

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
          mealScope: opts.scope === 'all' ? 'all' : 'main-meal',
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
          freshness,
          request: {
            budgetCny: opts.budget,
            priority: opts.priority,
            scope: opts.scope,
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
        freshness,
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
    variants: {},
    top: 15,
    sort: 'kcal',
    json: false,
    priority: 'balance',
    scope: 'meal',
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
