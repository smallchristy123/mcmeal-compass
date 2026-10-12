/**
 * 人工审核样本生成（外部评审 P1-1 的处置 · 计划书 §11.2）
 *
 * 评审原话：「完成至少 30 条人工审核样本，按单品/套餐/份量/饮料/新品分层统计
 *           precision、coverage、false-positive；已知错误不得进入 A/B。」
 *
 * ⚠️ **本脚本只负责"把题出好"，不负责"判卷"**——
 *    「这两条是不是同一个东西」属于人的判断，机器不得代劳。
 *    脚本产出：分层抽样表（含机器判定与理由）+ 空白的待填列；
 *    主君逐条判定后，再跑 `--score` 汇总各类精确率/覆盖率与错误样本。
 *
 * 用法：
 *   node scripts/review-samples.ts                 # 生成抽样表（≥30 条，分层）
 *   node scripts/review-samples.ts --score <已填的 csv>   # 汇总精度与错误样本
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';
import { NutritionMatcher } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { analyzeMenu, looksLikeCombo } from '../src/analyze.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** 分层定义：每层抽多少条 */
const STRATA: { key: string; label: string; take: number }[] = [
  { key: 'single-exact', label: '单品·精确命中', take: 8 },
  { key: 'single-alias', label: '单品·别名命中（含 risky 推断）', take: 4 },
  { key: 'combo-expanded', label: '套餐·展开求和', take: 8 },
  { key: 'beverage', label: '饮料（含份量歧义）', take: 4 },
  { key: 'size-ambiguous', label: '份量歧义（待用户指定）', take: 3 },
  { key: 'flavor-ambiguous', label: '口味歧义（待用户指定）', take: 3 },
  { key: 'new-item', label: '新品未收录（营养表滞后）', take: 2 },
  // v3.4（v3.3 复评）：D 级里「套餐名疑似、但详情不可用⇒降级直配」**不是**「新品滞后」，
  // 混在一层会污染覆盖率与误差解释，故单列一层（take 与 new-item 此消彼长，总数不变）。
  { key: 'detail-unavailable', label: '详情不可用（无法确认）', take: 2 },
  { key: 'non-food', label: '非食品周边（玩具/贴纸）', take: 2 },
];

const CSV_HEADER = [
  '序号',
  '分层',
  '菜单项',
  '菜单价(元)',
  '机器判定',
  '机器给出的营养来源',
  '可信度',
  '热量(kcal)',
  '【待填】判定(same/diff/unknown)',
  '【待填】差异说明',
  '【待填】审核人',
  '【待填】审核日期',
];

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * 分层归类。
 * @param matchMethod 该条的**匹配方式**（由匹配器直接给出，比从证据文本猜更可靠）
 */
export function classify(
  item: {
    name: string;
    confidence: string;
    evidence: { kind: string; label: string }[];
    sizeCandidates?: { size: string }[];
    flavorCandidates?: { flavor: string }[];
  },
  matchMethod: string,
): string | null {
  const isCombo = item.evidence.some((e) => e.kind === 'official-combo-sum');
  if ((item.sizeCandidates?.length ?? 0) >= 2) return 'size-ambiguous';
  if ((item.flavorCandidates?.length ?? 0) >= 2) return 'flavor-ambiguous';
  // 套餐展开失败时可能落到这里：先判非食品，再判既有营养
  if (/玩具|贴纸|帽|捶|挠|公仔|徽章|盲盒|手办|水手/.test(item.name)) return 'non-food';
  // v3.4（v3.3 复评）：D 级须再分——
  //   套餐名疑似却拿不到详情 → 「详情不可用（无法确认）」，**不能**记成「新品未收录」；
  //   否则会把「没有可用证据」误报为「营养表滞后」，污染分层覆盖率与误差解释。
  if (item.confidence === 'D') {
    return looksLikeCombo(item.name) ? 'detail-unavailable' : 'new-item';
  }
  if (matchMethod === 'alias' || matchMethod === 'variant') return 'single-alias';
  const isBeverage = /咖啡|可乐|雪碧|红茶|绿茶|果汁|奶茶|拿铁|美式|卡布|怡泉|纯悦|矿泉水|牛奶|柠檬茶/.test(
    item.name,
  );
  if (isBeverage) return 'beverage';
  if (isCombo) return 'combo-expanded';
  return 'single-exact';
}

async function generate(): Promise<void> {
  const b = await loadFixtures();
  const matcher = new NutritionMatcher(b.nutritionRows, { aliases: DEFAULT_ALIASES });
  const { items } = await analyzeMenu(b.menuItems, matcher, fixtureDetailLoader(b), {});

  // 分层归类
  const buckets = new Map<string, typeof items>();
  for (const it of items) {
    const key = classify(it, matcher.match({ code: it.code, name: it.name }).method);
    if (!key) continue;
    const arr = buckets.get(key) ?? [];
    arr.push(it);
    buckets.set(key, arr);
  }

  const rows: (string | number | null)[][] = [];
  let idx = 0;
  const chosenByStratum: Record<string, number> = {};

  for (const s of STRATA) {
    const pool = buckets.get(s.key) ?? [];
    // 抽样：均匀取，避免只抽到同一批名字
    const step = Math.max(1, Math.floor(pool.length / s.take));
    const picked: typeof pool = [];
    for (let i = 0; i < pool.length && picked.length < s.take; i += step) picked.push(pool[i]!);
    chosenByStratum[s.label] = picked.length;

    for (const it of picked) {
      idx++;
      rows.push([
        idx,
        s.label,
        it.name,
        it.price === null ? '—' : (it.price / 100).toFixed(2),
        it.kind === 'combo' ? '套餐展开求和' : '单品直配',
        it.evidence.map((e) => e.label).join('；') || '（无）',
        it.confidence,
        it.totals.energyKcal.value === null ? '—' : it.totals.energyKcal.value,
        '',
        '',
        '',
        '',
      ]);
    }
  }

  const outDir = resolve(root, '..', 'outputs');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, '人工审核样本-2026-10-11.csv');
  const csv = [CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  await writeFile(outPath, `\uFEFF${csv}\n`, 'utf-8'); // BOM：Excel 打开不乱码

  console.log('═'.repeat(72));
  console.log('人工审核样本（计划书 §11.2 / 评审 P1-1）');
  console.log('═'.repeat(72));
  console.log(`快照：${b.snapshotId}　门店：${b.storeCode} ${b.storeName}`);
  console.log(`抽样：${rows.length} 条（要求 ≥30）`);
  console.log('');
  console.log('分层构成：');
  for (const [k, v] of Object.entries(chosenByStratum)) console.log(`  ${k.padEnd(28)} ${String(v).padStart(3)}`);
  console.log('');
  console.log(`已写出：${outPath}`);
  console.log('');
  console.log('怎么判（请主君逐条填「判定」列）：');
  console.log('  same    = 机器给的营养来源，与菜单项**确为同一物**（份量/口味/规格一致）');
  console.log('  diff    = 不是同一物（如四件套配成单品、不同口味、不同份量）→ 记为**误配**');
  console.log('  unknown = 无法判断（缺官方信息）→ 既不算对也不算错，单列');
  console.log('');
  console.log('填完后汇总：');
  console.log(`  node scripts/review-samples.ts --score "${outPath}"`);
  console.log('═'.repeat(72));
}

/** 汇总已填表格：按分层算 precision / coverage，并列出错误样本 */
async function score(csvPath: string): Promise<void> {
  const text = (await readFile(csvPath, 'utf-8')).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };

  const body = lines.slice(1).map(parseLine);
  const verdictIdx = CSV_HEADER.indexOf('【待填】判定(same/diff/unknown)');
  const layerIdx = CSV_HEADER.indexOf('分层');

  const byLayer = new Map<string, { same: number; diff: number; unknown: number; blank: number }>();
  const errors: string[] = [];

  for (const row of body) {
    const layer = row[layerIdx] ?? '(未分层)';
    const v = (row[verdictIdx] ?? '').trim().toLowerCase();
    const rec = byLayer.get(layer) ?? { same: 0, diff: 0, unknown: 0, blank: 0 };
    if (v === 'same') rec.same++;
    else if (v === 'diff') {
      rec.diff++;
      errors.push(`  ✗ [${layer}] ${row[2]} ← ${row[5]}`);
    } else if (v === 'unknown') rec.unknown++;
    else rec.blank++;
    byLayer.set(layer, rec);
  }

  console.log('═'.repeat(72));
  console.log('人工审核汇总（precision 按分层）');
  console.log('═'.repeat(72));
  console.log('分层'.padEnd(30) + '已判  一致  误配  无法判  未填   精确率');
  let totalSame = 0;
  let totalDiff = 0;
  let totalUnknown = 0;
  let totalBlank = 0;
  for (const [layer, r] of byLayer) {
    const judged = r.same + r.diff;
    const p = judged === 0 ? null : r.same / judged;
    totalSame += r.same;
    totalDiff += r.diff;
    totalUnknown += r.unknown;
    totalBlank += r.blank;
    console.log(
      layer.padEnd(28) +
        String(judged).padStart(5) +
        String(r.same).padStart(6) +
        String(r.diff).padStart(6) +
        String(r.unknown).padStart(8) +
        String(r.blank).padStart(6) +
        (p === null ? '      —' : `${(p * 100).toFixed(1).padStart(8)}%`),
    );
  }
  const judgedTotal = totalSame + totalDiff;
  console.log('─'.repeat(72));
  console.log(
    `总体：已判 ${judgedTotal} 条（一致 ${totalSame} / 误配 ${totalDiff}），无法判 ${totalUnknown}，未填 ${totalBlank}` +
      (judgedTotal === 0 ? '' : `　精确率 ${((totalSame / judgedTotal) * 100).toFixed(1)}%`),
  );

  if (errors.length > 0) {
    console.log('');
    console.log('⚠️ 误配清单（**这些必须从 A/B 级剔除**，并补进别名表"禁配"或匹配规则）：');
    console.log(errors.join('\n'));
  } else if (judgedTotal > 0) {
    console.log('');
    console.log('✅ 已判样本中**没有误配**。');
  }
  if (totalBlank > 0) {
    console.log('');
    console.log(`ℹ️ 还有 ${totalBlank} 条未填——**未填不算通过**，不得拿"已填部分全对"当结论。`);
  }
  console.log('═'.repeat(72));
}

// ─────────────── CLI ───────────────

const scoreIdx = process.argv.indexOf('--score');
if (scoreIdx >= 0) {
  const p = process.argv[scoreIdx + 1];
  if (!p) {
    console.error('用法：node scripts/review-samples.ts --score <已填的 csv 路径>');
    process.exitCode = 1;
  } else {
    await score(resolve(p));
  }
} else {
  await generate();
}
