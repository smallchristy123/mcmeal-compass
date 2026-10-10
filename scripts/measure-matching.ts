/**
 * 匹配质量量尺（T1.4 配套工具）
 *
 * 拿真实数据量一遍「菜单 ↔ 营养」的匹配情况，直接输出命中率与失败清单。
 * 用途：
 *   - 开发时判断匹配规则是否够用（对应里程碑 M1「匹配准确率」门槛）；
 *   - 对外作为「可复现的失败模式说明」——诚实展示哪些配不上、为什么。
 *
 * 用法（在仓库根目录）：
 *   node scripts/measure-matching.ts
 *
 * 数据来源：docs/probe/ 下的脱敏实测留档（公开菜单数据，无隐私）。
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseToon, extractOriginalResponse } from '../src/toon.ts';
import { toNutritionRows, toMenuItems, QueryMealsDataSchema } from '../src/schema.ts';
import { NutritionMatcher, normalizeName, type MatchResult } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const probe = (f: string) => join(root, 'docs', 'probe', f);

/** 从 MCP 工具留档中取出原始 JSON */
async function loadEnvelope(file: string): Promise<unknown> {
  if (file.endsWith('.json')) {
    const raw = JSON.parse(await readFile(file, 'utf-8')) as {
      result: { content: { text: string }[] };
    };
    return extractOriginalResponse(raw.result.content[0]!.text);
  }
  const text = await readFile(file, 'utf-8');
  return extractOriginalResponse(text);
}

const nutEnv = (await loadEnvelope(probe('list-nutrition-foods.raw.json'))) as { data: string };
const nutTable = parseToon(nutEnv.data);
const { rows: nutritionRows, skipped } = toNutritionRows(nutTable);

const menuEnv = (await loadEnvelope(probe('query-meals.raw.txt'))) as { data: unknown };
const menuData = QueryMealsDataSchema.parse(menuEnv.data);
const { items, missing } = toMenuItems(menuData);

const matcher = new NutritionMatcher(nutritionRows, { aliases: DEFAULT_ALIASES });
const { results, stats } = matcher.matchAll(items);
const conflicts = matcher.getConflicts();

/** 疑似套餐/组合（需要经 query-meal-detail 展开才能取营养） */
const COMBO_RE = /(套餐|件套|随心选|双人餐|分享餐|快乐盒|精选|宫格|拼盘|组合|桶)/;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const line = '─'.repeat(56);

console.log(line);
console.log('麦麦营养管家 · 匹配质量量尺');
console.log(line);
console.log(`营养表        : ${nutritionRows.length} 条（跳过无名行 ${skipped}）`);
console.log(`菜单餐品      : ${items.length} 条（缺映射表 ${missing.length}）`);
console.log(`营养表重名    : ${conflicts.length} 组`);
console.log(line);
console.log(`整体命中率    : ${pct(stats.coverage)}（${stats.total - stats.byMethod.unmatched}/${stats.total}）`);

const combos = results.filter((r) => COMBO_RE.test(r.menuName));
const singles = results.filter((r) => !COMBO_RE.test(r.menuName));
const rate = (list: MatchResult[]) => {
  const hit = list.filter((r) => r.method !== 'unmatched').length;
  return list.length === 0 ? '—' : `${pct(hit / list.length)}（${hit}/${list.length}）`;
};
console.log(`  ├ 单品项      : ${rate(singles)}`);
console.log(`  └ 套餐/组合项 : ${rate(combos)}  ← 需经 query-meal-detail 展开后取营养`);
console.log('');
console.log('按匹配方式：');
for (const [k, v] of Object.entries(stats.byMethod)) {
  console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}`);
}
console.log('');
console.log('按可信度分层：');
for (const [k, v] of Object.entries(stats.byConfidence)) {
  console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}`);
}

const show = (title: string, list: MatchResult[]) => {
  if (list.length === 0) return;
  console.log('');
  console.log(`${title}（${list.length}）`);
  for (const r of list) console.log(`  · ${r.menuName}`);
};

console.log('');
console.log(line);
show('未匹配清单', results.filter((r) => r.method === 'unmatched'));
show('按别名命中', results.filter((r) => r.method === 'alias'));
show('按代码映射命中', results.filter((r) => r.method === 'code-mapping'));

if (conflicts.length > 0) {
  console.log('');
  console.log('营养表归一化后重名：');
  for (const c of conflicts) console.log(`  · ${c.names.join(' / ')}`);
}
console.log(line);
