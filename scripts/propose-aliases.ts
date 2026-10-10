/**
 * 别名候选提案（**离线，只提案不落库**）
 *
 * 为什么这样设计：计划书 §5.3.4 明确要求「经**人工审核**的别名表」。
 * 故本工具只做一件事——**把疑似同一物的配对摆到人面前**，附上差异在哪，
 * 由人判断是否收进 `src/aliases.ts`。**绝不自动写入**。
 *
 * 用法：node scripts/propose-aliases.ts [--min-score 0.6]
 */

import { NutritionMatcher, normalizeName } from '../src/matching.ts';
import { DEFAULT_ALIASES, type AliasRule } from '../src/aliases.ts';
import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';
import { analyzeMenu } from '../src/analyze.ts';

/** 最长公共前缀长度 */
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * 相似度（0–1）：以「最长公共前缀 / 较短串长度」为主，并对包含关系给满分。
 * 之所以用前缀而非编辑距离：中式商品名的差异几乎都在**后缀**
 * （份量、包装、规格），前缀一致正是同一物的强信号。
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.includes(b) || b.includes(a)) return 0.95;
  const shorter = a.length <= b.length ? a : b;
  return commonPrefix(a, b) / shorter.length;
}

const minScore = (() => {
  const i = process.argv.indexOf('--min-score');
  return i > 0 ? Number(process.argv[i + 1]) : 0.6;
})();

const bundle = await loadFixtures();
const matcher = new NutritionMatcher(bundle.nutritionRows, { aliases: DEFAULT_ALIASES });

const { items } = await analyzeMenu(bundle.menuItems, matcher, fixtureDetailLoader(bundle));

// 收集「未匹配」的名称：既含单项，也含套餐里未匹配的组件
const misses = new Set<string>();
for (const it of items) {
  if (it.confidence === 'D' && (it.sizeCandidates?.length ?? 0) < 2) misses.add(it.name);
  for (const c of it.unmatchedComponents) {
    const name = c.includes('：') ? c.split('：').pop()!.trim() : c;
    misses.add(name);
  }
}

const nutNames = bundle.nutritionRows.map((r) => r.productName);

interface Proposal {
  menuName: string;
  nutritionName: string;
  score: number;
  reason: string;
  /** 是否为「套餐名配单品」这类**必须拒绝**的诱饵 */
  trap: boolean;
}

/** 套餐/组合关键词——这些名称**绝不能**映射到单品营养（这正是「胡乱匹配」的典型） */
const COMBO_TRAP_RE = /(套餐|件套|随心选|双人餐|分享餐|快乐盒|宫格|拼盘|组合|桶|任选)/;

const proposals: Proposal[] = [];

for (const miss of misses) {
  const a = normalizeName(miss);
  if (a === '') continue;

  let best: { name: string; score: number } | null = null;
  for (const nut of nutNames) {
    const b = normalizeName(nut);
    const s = similarity(a, b);
    if (!best || s > best.score) best = { name: nut, score: s };
  }
  if (best && best.score >= minScore && best.score < 1) {
    const b = normalizeName(best.name);
    const p = commonPrefix(a, b);
    const diffA = a.slice(p);
    const diffB = b.slice(p);
    const reason =
      a.includes(b) || b.includes(a)
        ? `包含关系（${a.includes(b) ? '菜单名更长' : '营养表名更长'}）`
        : `前缀相同「${(a.slice(0, p) || '（无）').slice(-8)}」，菜单多「${diffA || '—'}」、营养表多「${diffB || '—'}」`;
    proposals.push({
      menuName: miss,
      nutritionName: best.name,
      score: best.score,
      reason,
      // 菜单名是套餐、而候选是单品 → 这是诱饵，绝不能采纳
      trap: COMBO_TRAP_RE.test(miss) && !COMBO_TRAP_RE.test(best.name),
    });
  }
}

proposals.sort((x, y) => Number(x.trap) - Number(y.trap) || y.score - x.score);

const traps = proposals.filter((p) => p.trap);
const usable = proposals.filter((p) => !p.trap);

console.log('═'.repeat(72));
console.log('别名候选提案 —— 仅供人工审核，**不自动写入**');
console.log('═'.repeat(72));
console.log(`扫描：${misses.size} 个未匹配名称 × ${nutNames.length} 条营养记录，阈值 ${minScore}`);
console.log(`候选：${proposals.length} 组（其中 ${traps.length} 组是**必须拒绝的诱饵**）\n`);

if (traps.length > 0) {
  console.log('⚠️ 以下候选**必须拒绝**（相似度高，但语义完全不同）：');
  console.log('   把「三件套/四件套」配成单品营养，正是计划书要防的「胡乱匹配」——');
  console.log('   一个四件套的热量 ≈ 单品 + 薯条 + 饮料，差出数倍。\n');
  for (const p of traps.slice(0, 12)) {
    console.log(`  ✗【${(p.score * 100).toFixed(0)}%】菜单「${p.menuName}」 ←→ 营养表「${p.nutritionName}」`);
  }
  if (traps.length > 12) console.log(`  …另有 ${traps.length - 12} 组同类诱饵`);
  console.log('');
}

console.log('─'.repeat(72));
console.log('可提交人工审核的候选（**仍须确认份量/规格一致**）：\n');
for (const p of usable) {
  console.log(`  ?【${(p.score * 100).toFixed(0)}%】菜单「${p.menuName}」 ←→ 营养表「${p.nutritionName}」`);
  console.log(`        差异：${p.reason}`);
}
console.log('');
console.log('─'.repeat(72));
console.log('如何采纳（**须先人工确认是同一物**，尤其注意份量/规格是否一致）：');
console.log('  在 src/aliases.ts 的 DEFAULT_ALIASES 中追加：');
console.log("    { alias: '菜单名', nutrition: '营养表品名', note: '依据…', risky: true }");
console.log('  若份量/规格不确定，务必标 risky: true —— 它会把可信度上限压到 B。');
console.log('═'.repeat(72));

console.log('\n当前已收录的别名规则：');
for (const r of DEFAULT_ALIASES as readonly AliasRule[]) {
  console.log(`  · ${r.alias} → ${r.nutrition}${r.risky ? '（risky）' : ''}`);
}
