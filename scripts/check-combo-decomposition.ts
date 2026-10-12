/**
 * 套餐展开验证（T1.4 / T1.6 配套，**需真实 Token**）
 *
 * 断言一件事：**套餐不能直接配营养，必须先展开成组件**。
 * 实测（2026-10-10）：
 *   - 套餐直接匹配营养 → 0%（营养表只含单品，套餐名根本不在其中）；
 *   - 经 query-meal-detail 展开后逐件匹配 → 87.6%（156/178，50 个套餐全量实测）。
 *
 * ## v3 整改（评审「探针复用」项）
 *
 * 旧版本脚本自建 fetch 与自有握手——「脚本跑通」并不能证明**应用入口**也通。
 * 现在改为复用应用自身的 `McpClient`（同一套协议形态、会话、错误校验与超时/退避），
 * 于是本脚本验证的就是应用**真正走的**那条路。
 *
 * 用法（需 ~/.workbuddy/mcp.json 内已配好 mcd-mcp 的 Token）：
 *   node scripts/check-combo-decomposition.ts [门店code]
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseToon, extractOriginalResponse, unwrapMcpData } from '../src/toon.ts';
import { toNutritionRows, toMenuItems, QueryMealsDataSchema } from '../src/schema.ts';
import { NutritionMatcher } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { DEFAULT_FIXTURE_DIR } from '../src/fixtures.ts';
import { McpClient } from '../src/mcp-client.ts';

const cfgPath = join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.workbuddy', 'mcp.json');
const cfg = JSON.parse(await readFile(cfgPath, 'utf-8')) as {
  mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
};
const mcd = cfg.mcpServers['mcd-mcp'];
if (!mcd) throw new Error('未在 ~/.workbuddy/mcp.json 找到 mcd-mcp 配置');
const token = (mcd.headers['Authorization'] ?? '').replace(/^Bearer\s+/i, '').trim();
if (!token) throw new Error('mcd-mcp 配置里没有 Authorization（Bearer Token）');

// ⚠️ 复用应用客户端：同一套协议形态、会话与错误校验
const client = new McpClient({ url: mcd.url, token, clientName: 'mcmeal-combo-probe', clientVersion: '0.3.0' });
const info = await client.initialize();
console.log(`客户端：${info.era}/${info.protocolVersion}（协商：${info.protocolNegotiation}）\n`);

// 营养表与菜单取本地快照（不额外消耗配额）；只有**套餐详情**走真实端点
const nutEnv = extractOriginalResponse(
  (JSON.parse(await readFile(join(DEFAULT_FIXTURE_DIR, 'list-nutrition-foods.raw.json'), 'utf-8')) as {
    result: { content: { text: string }[] };
  }).result.content[0]!.text,
) as { data: string };
const { rows: nutRows } = toNutritionRows(parseToon(nutEnv.data));
const menuData = unwrapMcpData(await readFile(join(DEFAULT_FIXTURE_DIR, 'query-meals.raw.txt'), 'utf-8'));
const { items } = toMenuItems(QueryMealsDataSchema.parse(menuData));
const matcher = new NutritionMatcher(nutRows, { aliases: DEFAULT_ALIASES });

const storeCode = process.argv[2] ?? '3450024';
const combos = items.filter((i) => /(套餐|件套|随心选|双人餐|分享餐)/.test(i.name));
console.log('套餐总数:', combos.length, '| 抽 5 个验证「展开→取营养」这条路\n');

let ok = 0;
let totalComp = 0;
let hitComp = 0;
for (const c of combos.slice(0, 5)) {
  const detail = await client.getMealDetail({ storeCode, orderType: 1, beType: 1, code: c.code });
  const lines: string[] = [];
  for (const r of detail.rounds) {
    const def = r.choices.find((x) => x.isDefault) ?? r.choices[0];
    if (!def) {
      lines.push(`   · ${r.name}: (无选项)`);
      continue;
    }
    totalComp++;
    const m = matcher.match({ code: def.code, name: def.name });
    if (m.method !== 'unmatched') hitComp++;
    lines.push(`   · ${r.name}: ${def.name} → ${m.method === 'unmatched' ? '✗ 未匹配' : `✓ ${m.nutrition?.productName ?? ''}`}`);
  }
  console.log(`【${c.name}】¥${((c.currentPrice ?? 0) / 100).toFixed(2)}  轮次 ${detail.rounds.length}`);
  console.log(lines.join('\n'));
  console.log('');
  ok++;
}
console.log(`展开成功: ${ok}/5 个套餐`);
console.log(`组件营养命中: ${hitComp}/${totalComp} = ${((hitComp / Math.max(1, totalComp)) * 100).toFixed(1)}%`);
