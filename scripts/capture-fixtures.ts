/**
 * 采集夹具（**需真实 Token**）—— 写入 `work/captures/<runId>/`，**绝不覆盖 fixtures/**
 *
 * ## 与旧版的关键差别（P0-1 的处置）
 *
 * 旧版把采集结果直接写进 `docs/probe/`，而**测试也读那个目录**——
 * 于是「采一次数」就让测试基线漂移，别人拿到仓库后不再复现。
 * 新版：采集**只落 work/captures/**（work/ 已被 .gitignore 忽略），采集完自动生成 manifest。
 *
 * ## v3 整改（外部评审「采集路径保护」项）
 *
 *   1. **写入保护前置**：路径校验在**读凭据之前**、**任何网络调用之前**完成
 *      （旧版把校验摆在两处网络调用之后，等于先连了网再判断能不能写）；
 *   2. **大小写与路径边界**：Windows 下 `Fixtures` / `FIXTURES` 指向同一目录，
 *      旧版的大小写敏感 `startsWith` 会被绕过 —— 现在统一 `normalize` + 小写比较，
 *      并同时用 `path.relative` 判断包含关系（判据见 src/capture-guard.ts）；
 *   3. **独立 runId，禁止覆盖**：旧版目录名只到分钟，同一分钟重采会**覆盖**前一次；
 *      现在 runId 含秒与短随机串，且目标目录已存在即**拒绝执行**。
 *
 * 说明：采集内容均为**公开菜单与营养数据**，不含账号、地址、订单等个人数据。
 *
 * 用法：
 *   node scripts/capture-fixtures.ts [门店code] [--details N] [--out work/captures/<名字>]
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unwrapMcpEnvelope } from '../src/toon.ts';
import { QueryMealsDataSchema, toMenuItems } from '../src/schema.ts';
import { McpClient } from '../src/mcp-client.ts';
import { buildManifest, MANIFEST_NAME } from './fixture-manifest.ts';
import { forbiddenWrite } from '../src/capture-guard.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** 时间戳（本地时区，形如 20261011-1812-07）＋ 3 位随机串，保证同一分钟也不撞名 */
function runId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const suffix = Math.random().toString(36).slice(2, 5);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${p(d.getSeconds())}-${suffix}`;
}

/** 目标目录已存在且非空 → 拒绝（**禁止覆盖**） */
export async function ensureFreshDir(outDir: string): Promise<string | null> {
  try {
    const st = await stat(outDir);
    if (st.isDirectory()) return `目标目录已存在，拒绝覆盖：${outDir}（每次采集都应是新目录）`;
    return `目标路径已被文件占用：${outDir}`;
  } catch {
    return null; // 不存在 → 可以新建
  }
}

// ─────────────────── ① 先解析参数、校验写入路径（**先于读凭据与网络**） ───────────────────

const storeCode = process.argv[2] ?? '3450024';
const detailsArgIdx = process.argv.indexOf('--details');
const wantDetails = detailsArgIdx > 0 ? Number(process.argv[detailsArgIdx + 1]) : 20;
const outIdx = process.argv.indexOf('--out');
const outDir =
  outIdx > 0
    ? resolve(root, process.argv[outIdx + 1] ?? '')
    : join(root, 'work', 'captures', `${runId()}-${storeCode}`);

const forbidden = forbiddenWrite(outDir, root);
if (forbidden) {
  console.error(`✗ 拒绝执行：${forbidden}`);
  console.error('  如需新基线，请先采到 work/captures/，再人工新建快照。见 fixtures/README.md');
  process.exitCode = 1;
  throw new Error('capture 拒绝写入受保护目录');
}
const exists = await ensureFreshDir(outDir);
if (exists) {
  console.error(`✗ 拒绝执行：${exists}`);
  process.exitCode = 1;
  throw new Error('capture 拒绝覆盖已存在的采集目录');
}

// ─────────────────── ② 校验通过后，才读凭据并复用应用客户端 ───────────────────

const cfgPath = join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.workbuddy', 'mcp.json');
const cfg = JSON.parse(await readFile(cfgPath, 'utf-8')) as {
  mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
};
const mcd = cfg.mcpServers['mcd-mcp'];
if (!mcd) throw new Error('未在 ~/.workbuddy/mcp.json 找到 mcd-mcp 配置');

const authHeader = mcd.headers['Authorization'] ?? '';
const token = authHeader.replace(/^Bearer\s+/i, '').trim();
if (!token) throw new Error('mcd-mcp 配置里没有 Authorization（Bearer Token）');

/**
 * **复用应用自身的 `McpClient`**（评审「探针复用」项）：
 * 旧版脚本自建 fetch + 自有握手，于是「脚本跑通」并不能证明应用入口也通；
 * 现在采集与运行时走同一条客户端路径（同一套错误校验、协议形态与会话处理）。
 */
const client = new McpClient({ url: mcd.url, token, clientName: 'mcmeal-compass-capture', clientVersion: '0.3.0' });
const info = await client.initialize();
console.log(`客户端：${info.era}/${info.protocolVersion}（协商：${info.protocolNegotiation}）`);
console.log(`采集目录：${outDir}`);

await mkdir(outDir, { recursive: true });

const call = (name: string, args: Record<string, unknown>) => client.callToolRaw(name, args);

// 1) 营养表
const nutText = await call('list-nutrition-foods', {});
await writeFile(
  join(outDir, 'list-nutrition-foods.raw.json'),
  JSON.stringify({ result: { content: [{ text: nutText }] } }, null, 0),
  'utf-8',
);
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
const { items } = toMenuItems(QueryMealsDataSchema.parse(unwrapMcpEnvelope(menuText).data));
const COMBO_RE = /(套餐|件套|随心选|双人餐|分享餐|快乐盒|宫格|拼盘|组合|桶)/;
const combos = items.filter((i) => COMBO_RE.test(i.name));
const seen = new Set<string>();
const uniq = combos.filter((c) => (seen.has(c.code) ? false : (seen.add(c.code), true)));

const bundle: Record<string, unknown> = {};
let n = 0;
for (const c of uniq.slice(0, wantDetails)) {
  const t = await call('query-meal-detail', { storeCode, orderType: 1, beType: 1, code: c.code });
  bundle[c.code] = unwrapMcpEnvelope(t).data;
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
    storeCode,
    orderType: 1,
    beType: 1,
    items: [{ productCode: anchor.code, quantity: 1 }],
  });
  await writeFile(join(outDir, 'calculate-price.raw.txt'), priceText, 'utf-8');
  const price = unwrapMcpEnvelope(priceText).data as { price?: number };
  console.log(`✓ 计价样本已保存（${anchor.name} → ${price.price} 分）`);
}

// 6) 自动生成 manifest（供日后升格为快照时比对）
const manifest = await buildManifest(outDir);
await writeFile(join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
console.log(`✓ manifest 已生成：${JSON.stringify(manifest.counts)}`);

console.log('');
console.log('─'.repeat(64));
console.log(`本次 runId 目录：${outDir}`);
console.log('采集完成。**测试基线未受影响**——本次结果只落在 work/ 下。');
console.log('若要把本次数据升格为测试基线（须人工确认并同步更新断言）：');
console.log(`  cp -r ${outDir.replace(root + sep, '')} fixtures/<新快照名>`);
console.log('  node scripts/fixture-manifest.ts --dir fixtures/<新快照名> --write');
console.log('  然后更新 tests/ 中断言、docs/ 中数字，并在 CHANGELOG 说明"为何换数据"。');
console.log('─'.repeat(64));
