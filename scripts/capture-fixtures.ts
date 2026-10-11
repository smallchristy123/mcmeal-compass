/**
 * 采集夹具（**需真实 Token**）—— 写入 `work/captures/<时间戳>/`，**绝不覆盖 fixtures/**
 *
 * ## 与旧版的关键差别（P0-1 的处置）
 *
 * 旧版把采集结果直接写进 `docs/probe/`，而**测试也读那个目录**——
 * 于是「采一次数」就让测试基线漂移，别人拿到仓库后不再复现。
 *
 * 新版：采集**只落 work/captures/**（work/ 已被 .gitignore 忽略），
 * 采集完自动生成该目录的 manifest；若要把它升格为测试基线，
 * 须**人工显式**新建快照并更新断言（见 fixtures/README.md 的「如何换快照」）。
 *
 * 说明：采集内容均为**公开菜单与营养数据**，不含账号、地址、订单等个人数据。
 *
 * 用法：
 *   node scripts/capture-fixtures.ts [门店code] [--details N] [--out work/captures/<名字>]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractOriginalResponse, unwrapMcpData } from '../src/toon.ts';
import { QueryMealsDataSchema, toMenuItems } from '../src/schema.ts';
import { buildManifest, MANIFEST_NAME } from './fixture-manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** 时间戳（本地时区，形如 20261011-1812） */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

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
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'capture', version: '0.2' } },
  }),
});

const storeCode = process.argv[2] ?? '3450024';
const detailsArgIdx = process.argv.indexOf('--details');
const wantDetails = detailsArgIdx > 0 ? Number(process.argv[detailsArgIdx + 1]) : 20;
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx > 0
  ? resolve(root, process.argv[outIdx + 1] ?? '')
  : join(root, 'work', 'captures', `${stamp()}-${storeCode}`);

if (outDir.startsWith(join(root, 'fixtures'))) {
  console.error('✗ 拒绝执行：采集不得写入 fixtures/（那是不可变快照）');
  console.error('  如需新基线，请先采到 work/captures/，再人工新建快照。见 fixtures/README.md');
  process.exitCode = 1;
  throw new Error('capture 拒绝写入 fixtures/');
}

await mkdir(outDir, { recursive: true });
console.log(`采集目录：${outDir}`);

// 1) 营养表
const nutText = await call('list-nutrition-foods', {});
await writeFile(join(outDir, 'list-nutrition-foods.raw.json'), JSON.stringify({ result: { content: [{ text: nutText }] } }), 'utf-8');
console.log('✓ 营养表已保存');

// 2) 门店
const storeText = await call('query-nearby-stores', { beType: 1, searchType: 2, city: '重庆市', keyword: '观音桥' });
await writeFile(join(outDir, 'query-nearby-stores.raw.txt'), storeText, 'utf-8');
console.log('✓ 门店列表已保存');

// 3) 菜单
const menuText = await call('query-meals', { storeCode, orderType: 1, beType: 1 });
await writeFile(join(outDir, 'query-meals.raw.txt'), menuText, 'utf-8');
console.log('✓ 菜单已保存');

// 4) 套餐详情（按序取前 N 个套餐）
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
await writeFile(join(outDir, 'meal-details.bundle.json'), JSON.stringify(bundle), 'utf-8');
console.log(`✓ 套餐详情已保存（${n} 个）`);

// 5) 计价样本（与 query-meal-detail 取**同一个**套餐，使「菜单价 ↔ 详情 ↔ 官方计价」三者对齐）
const anchorCode = '9900005456';
const anchor = items.find((i) => i.code === anchorCode) ?? uniq[0] ?? items[0];
if (anchor) {
  const detailText = await call('query-meal-detail', { storeCode, orderType: 1, beType: 1, code: anchor.code });
  await writeFile(join(outDir, 'query-meal-detail.raw.txt'), detailText, 'utf-8');
  console.log(`✓ 锚点套餐详情已保存（${anchor.name}，code=${anchor.code}）`);

  const priceText = await call('calculate-price', {
    storeCode, orderType: 1, beType: 1,
    items: [{ productCode: anchor.code, quantity: 1 }],
  });
  await writeFile(join(outDir, 'calculate-price.raw.txt'), priceText, 'utf-8');
  const price = unwrapMcpData(priceText) as { price?: number };
  console.log(`✓ 计价样本已保存（${anchor.name} → ${price.price} 分）`);
}

// 6) 自动生成 manifest（供日后升格为快照时比对）
const manifest = await buildManifest(outDir);
await writeFile(join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
console.log(`✓ manifest 已生成：${JSON.stringify(manifest.counts)}`);

console.log('');
console.log('─'.repeat(64));
console.log('采集完成。**测试基线未受影响**——本次结果只落在 work/ 下。');
console.log('若要把本次数据升格为测试基线（须人工确认并同步更新断言）：');
console.log(`  git mv 不便，改为复制：cp -r ${outDir.replace(root + '\\', '')} fixtures/<新快照名>`);
console.log('  node scripts/fixture-manifest.ts --dir fixtures/<新快照名> --write');
console.log('  然后更新 tests/ 中断言、docs/ 中数字，并在 CHANGELOG 说明"为何换数据"。');
console.log('─'.repeat(64));
