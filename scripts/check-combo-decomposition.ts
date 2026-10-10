/**
 * 套餐展开验证（T1.4 / T1.6 配套，**需真实 Token**）
 *
 * 断言一件事：**套餐不能直接配营养，必须先展开成组件**。
 * 实测（2026-10-10）：
 *   - 套餐直接匹配营养 → 0%（营养表只含单品，套餐名根本不在其中）；
 *   - 经 query-meal-detail 展开后逐件匹配 → 85%（17/20）。
 *
 * 用法（需 ~/.workbuddy/mcp.json 内已配好 mcd-mcp 的 Token）：
 *   node scripts/check-combo-decomposition.ts [门店code]
 *
 * 这是「开放失败模式」的一部分：未命中的组件会被如实列出（新品未收录、非食品周边等）。
 */

import { readFile } from 'node:fs/promises';
import { parseToon, extractOriginalResponse, unwrapMcpData } from '../src/toon.ts';
import { toNutritionRows, toMenuItems, QueryMealsDataSchema, toMealDetail } from '../src/schema.ts';
import { NutritionMatcher } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';

const cfg = JSON.parse(await readFile(process.env.USERPROFILE + '/.workbuddy/mcp.json','utf-8'));
const mcd = cfg.mcpServers['mcd-mcp'];
const H = {'Content-Type':'application/json','Accept':'application/json, text/event-stream','Authorization':mcd.headers.Authorization};
let id = 0;
async function call(name:string, args:unknown) {
  const r = await fetch(mcd.url, {method:'POST', headers:H,
    body: JSON.stringify({jsonrpc:'2.0', id:++id, method:'tools/call', params:{name, arguments:args}})});
  const j = await r.json() as any;
  return j.result?.content?.[0]?.text ?? '';
}
await fetch(mcd.url, {method:'POST', headers:H,
  body: JSON.stringify({jsonrpc:'2.0',id:++id,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'p',version:'0'}}})});

const nutEnv = extractOriginalResponse((JSON.parse(await readFile('./docs/probe/list-nutrition-foods.raw.json','utf-8')).result.content[0].text)) as any;
const { rows: nutRows } = toNutritionRows(parseToon(nutEnv.data));
const menuData = unwrapMcpData(await readFile('./docs/probe/query-meals.raw.txt','utf-8'));
const { items } = toMenuItems(QueryMealsDataSchema.parse(menuData));
const matcher = new NutritionMatcher(nutRows, { aliases: DEFAULT_ALIASES });

const combos = items.filter(i=>/(套餐|件套|随心选|双人餐|分享餐)/.test(i.name));
console.log('套餐总数:', combos.length, '| 抽 5 个验证「展开→取营养」这条路\n');

let ok = 0, totalComp = 0, hitComp = 0;
for (const c of combos.slice(0,5)) {
  const detail = toMealDetail(unwrapMcpData(await call('query-meal-detail',
    {storeCode:'3450024', orderType:1, beType:1, code:c.code})));
  const lines: string[] = [];
  for (const r of detail.rounds) {
    const def = r.choices.find(x=>x.isDefault) ?? r.choices[0];
    if (!def) { lines.push(`   · ${r.name}: (无选项)`); continue; }
    totalComp++;
    const m = matcher.match({code:def.code, name:def.name});
    if (m.method!=='unmatched') hitComp++;
    lines.push(`   · ${r.name}: ${def.name} → ${m.method==='unmatched'?'✗ 未匹配':`✓ ${m.nutritionName}`}`);
  }
  console.log(`【${c.name}】¥${((c.currentPrice??0)/100).toFixed(2)}  轮次 ${detail.rounds.length}`);
  console.log(lines.join('\n'));
  console.log('');
  ok++;
}
console.log(`展开成功: ${ok}/5 个套餐`);
console.log(`组件营养命中: ${hitComp}/${totalComp} = ${(hitComp/totalComp*100).toFixed(1)}%`);
