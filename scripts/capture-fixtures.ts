/**
 * 采集离线夹具（**需真实 Token**）
 *
 * 目的：把一次真实调用**冻结**下来，使他人 clone 仓库后**无需自己的 Token 也能跑通演示**
 * （`node src/cli.ts --offline`）。这是「可复现」与「被看见」两件事的共同前提。
 *
 * 说明：采集内容均为**公开菜单与营养数据**，不含任何账号、地址、订单等个人数据。
 *
 * 用法：
 *   node scripts/capture-fixtures.ts [门店code] [--details N]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractOriginalResponse, unwrapMcpData } from '../src/toon.ts';
import { QueryMealsDataSchema, toMenuItems } from '../src/schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const probeDir = join(root, 'docs', 'probe');

const cfgPath = join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.workbuddy', 'mcp.json');
const cfg = JSON.parse(await readFile(cfgPath, 'utf-8')) as {
  mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
};
const mcd = cfg.mcpServers['mcd-mcp'];
if (!mcd) throw new Error('未在 ~/.workbuddy/mcp.json 找到 mcd-mcp 配置');

const H = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: mcd.headers['Authorization'] ?? '',
};

let seq = 0;
async function call(name: string, args: unknown): Promise<string> {
  const res = await fetch(mcd.url, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = (await res.json()) as { result?: { content?: { text?: string }[] } };
  return j.result?.content?.[0]?.text ?? '';
}

await fetch(mcd.url, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: ++seq,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'capture', version: '0.1' } },
  }),
});

const storeCode = process.argv[2] ?? '3450024';
const detailsArgIdx = process.argv.indexOf('--details');
const wantDetails = detailsArgIdx > 0 ? Number(process.argv[detailsArgIdx + 1]) : 20;

await mkdir(probeDir, { recursive: true });

// 1) 营养表
const nutText = await call('list-nutrition-foods', {});
await writeFile(join(probeDir, 'list-nutrition-foods.raw.json'), JSON.stringify({ result: { content: [{ text: nutText }] } }), 'utf-8');
console.log('✓ 营养表已保存');

// 2) 门店
const storeText = await call('query-nearby-stores', { beType: 1, searchType: 2, city: '重庆市', keyword: '观音桥' });
await writeFile(join(probeDir, 'query-nearby-stores.raw.txt'), storeText, 'utf-8');
console.log('✓ 门店列表已保存');

// 3) 菜单
const menuText = await call('query-meals', { storeCode, orderType: 1, beType: 1 });
await writeFile(join(probeDir, 'query-meals.raw.txt'), menuText, 'utf-8');
console.log('✓ 菜单已保存');

// 4) 套餐详情（按序取前 N 个套餐；同时产生「该门店推荐单品」的计价样本）
const { items } = toMenuItems(QueryMealsDataSchema.parse(unwrapMcpData(menuText)));
const COMBO_RE = /(套餐|件套|随心选|双人餐|分享餐|快乐盒|宫格|拼盘|组合|桶)/;
const combos = items.filter((i) => COMBO_RE.test(i.name));
const seen = new Set<string>();
const uniq = combos.filter((c) => (seen.has(c.code) ? false : (seen.add(c.code), true)));

const bundle: Record<string, unknown> = {};
let n = 0;
for (const c of uniq.slice(0, wantDetails)) {
  const t = await call('query-meal-detail', { storeCode, orderType: 1, beType: 1, code: c.code });
  bundle[c.code] = unwrapMcpData(t);
  n++;
  process.stdout.write(`\r  采集套餐详情 ${n}/${Math.min(wantDetails, uniq.length)}`);
}
console.log('');
await writeFile(join(probeDir, 'meal-details.bundle.json'), JSON.stringify(bundle), 'utf-8');
console.log(`✓ 套餐详情已保存（${n} 个）`);

// 5) 计价样本（与 query-meal-detail.raw.txt 取**同一个套餐**，
//    这样「菜单价 ↔ 套餐详情 ↔ 官方计价」三者对齐，便于交叉校验单位）
const anchorCode = '9900005456';
const anchor = items.find((i) => i.code === anchorCode) ?? uniq[0] ?? items[0];
if (anchor) {
  // 5a) 单份套餐详情（供测试直接读取；与 bundle 中的同码内容一致）
  const detailText = await call('query-meal-detail', { storeCode, orderType: 1, beType: 1, code: anchor.code });
  await writeFile(join(probeDir, 'query-meal-detail.raw.txt'), detailText, 'utf-8');
  console.log(`✓ 锚点套餐详情已保存（${anchor.name}，code=${anchor.code}）`);

  // 5b) 计价样本（同一套餐 → 菜单价 / 详情 / 计价三者对齐，便于交叉校验单位）
  const priceText = await call('calculate-price', {
    storeCode, orderType: 1, beType: 1,
    items: [{ productCode: anchor.code, quantity: 1 }],
  });
  await writeFile(join(probeDir, 'calculate-price.raw.txt'), priceText, 'utf-8');
  const price = unwrapMcpData(priceText) as { price?: number };
  console.log(`✓ 计价样本已保存（${anchor.name} → ${price.price} 分）`);
}

console.log('\n全部完成。夹具目录：docs/probe/');
