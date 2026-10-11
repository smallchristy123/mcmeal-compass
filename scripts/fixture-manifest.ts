/**
 * 夹具快照 manifest —— 生成与校验
 *
 * ## 为什么要有它（P0-1 的处置）
 *
 * 旧做法：`capture` 直接覆盖 `docs/probe/`，而**测试也读同一个目录**——
 * 于是「采一次数」就会让测试基线漂移，本项目的「全绿」在别人机器上不复现。
 *
 * 新契约：
 *   1. `fixtures/<snapshotId>/` 是**不可变快照**，只由人工显式新建；
 *   2. 每个快照带 `manifest.json`：来源（门店/时间/就餐方式）+ 每文件 SHA-256 + 条数统计；
 *   3. `capture` 只写 `work/captures/<timestamp>/`，**永不触碰** `fixtures/`；
 *   4. 测试读快照并**校验哈希**——文件被改即失败。
 *
 * 用法：
 *   node scripts/fixture-manifest.ts                        # 校验所有快照（CI 用，失败即非 0 退出）
 *   node scripts/fixture-manifest.ts --dir <快照目录> --write  # 为某个快照生成/刷新 manifest
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseToon, extractOriginalResponse, unwrapMcpData } from '../src/toon.ts';
import { toNutritionRows, toMenuItems, QueryMealsDataSchema, toMealDetail, RawMealDetailSchema } from '../src/schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..');
export const FIXTURES_ROOT = join(REPO_ROOT, 'fixtures');
export const MANIFEST_NAME = 'manifest.json';

/** 快照内必须存在的文件（缺一即为不完整快照） */
export const REQUIRED_FILES = [
  'list-nutrition-foods.raw.json',
  'query-meals.raw.txt',
  'query-nearby-stores.raw.txt',
  'meal-details.bundle.json',
  'calculate-price.raw.txt',
] as const;

export interface FileFingerprint {
  sha256: string;
  bytes: number;
}

export interface FixtureCounts {
  /** 营养表行数 */
  nutritionRows: number;
  /** 菜单去重前条目数（分类下逐条累计） */
  menuItems: number;
  /** 菜单去重后条目数（meals 键数） */
  menuUniqueItems: number;
  /** 套餐详情 bundle 内的条数 */
  mealDetails: number;
}

export interface FixtureManifest {
  snapshotId: string;
  /** 快照契约版本，格式变更时递增 */
  schemaVersion: 1;
  provenance: {
    storeCode: string;
    storeName: string;
    capturedAt: string;
    orderType: number;
    beType: number;
    /** 数据来源说明 */
    source: string;
    note?: string;
  };
  files: Record<string, FileFingerprint>;
  counts: FixtureCounts;
  /** 生成该 manifest 的方式，便于追溯 */
  generatedBy: string;
}

export async function sha256File(path: string): Promise<FileFingerprint> {
  const buf = await readFile(path);
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.byteLength };
}

/** 从快照目录读取并统计（所有数字皆由实际数据算出，不写死） */
export async function inspectSnapshot(dir: string): Promise<{
  files: Record<string, FileFingerprint>;
  counts: FixtureCounts;
  provenance: FixtureManifest['provenance'];
}> {
  const files: Record<string, FileFingerprint> = {};
  const entries = await readdir(dir);
  for (const name of entries.filter((n) => n !== MANIFEST_NAME).sort()) {
    const s = await stat(join(dir, name));
    if (s.isFile()) files[name] = await sha256File(join(dir, name));
  }

  const missing = REQUIRED_FILES.filter((f) => !(f in files));
  if (missing.length > 0) {
    throw new Error(`快照不完整，缺少文件：${missing.join('、')}（目录：${dir}）`);
  }

  // 营养表
  const nutRaw = JSON.parse(await readFile(join(dir, 'list-nutrition-foods.raw.json'), 'utf-8')) as {
    result: { content: { text: string }[] };
  };
  const nutEnv = extractOriginalResponse(nutRaw.result.content[0]!.text) as { data: string; datetime?: string };
  const { rows: nutritionRows } = toNutritionRows(parseToon(nutEnv.data));

  // 菜单
  const menuData = unwrapMcpData(await readFile(join(dir, 'query-meals.raw.txt'), 'utf-8'));
  const parsedMenu = QueryMealsDataSchema.parse(menuData);
  const { items: menuItems } = toMenuItems(parsedMenu);
  const menuUniqueItems = Object.keys(parsedMenu.meals ?? {}).length;

  // 门店
  let storeCode = '';
  let storeName = '';
  try {
    const payload = unwrapMcpData(await readFile(join(dir, 'query-nearby-stores.raw.txt'), 'utf-8'));
    const list = Array.isArray(payload)
      ? (payload as Record<string, unknown>[])
      : ((payload as { data?: Record<string, unknown>[] } | null)?.data ?? []);
    const first = list[0];
    if (first) {
      storeCode = String(first['storeCode'] ?? '');
      storeName = String(first['storeName'] ?? '');
    }
  } catch {
    /* 门店留档缺失不影响统计 */
  }

  // 套餐详情
  let mealDetails = 0;
  try {
    const bundle = JSON.parse(await readFile(join(dir, 'meal-details.bundle.json'), 'utf-8')) as Record<string, unknown>;
    for (const raw of Object.values(bundle)) {
      try {
        toMealDetail(RawMealDetailSchema.parse(raw));
        mealDetails++;
      } catch {
        /* 单条解析失败不计数 */
      }
    }
  } catch {
    /* 无 bundle */
  }

  return {
    files,
    counts: { nutritionRows: nutritionRows.length, menuItems: menuItems.length, menuUniqueItems, mealDetails },
    provenance: {
      storeCode,
      storeName,
      capturedAt: nutEnv.datetime ?? '',
      orderType: 1,
      beType: 1,
      source: '麦当劳中国官方 MCP（mcp.mcd.cn）一次真实调用，脱敏留档；仅含公开菜单与营养数据',
    },
  };
}

/** 生成 manifest 内容 */
export async function buildManifest(dir: string): Promise<FixtureManifest> {
  const { files, counts, provenance } = await inspectSnapshot(dir);
  return {
    snapshotId: dir.split(/[\\/]/).pop() ?? 'unknown',
    schemaVersion: 1,
    provenance,
    files,
    counts,
    generatedBy: 'scripts/fixture-manifest.ts',
  };
}

export interface VerifyIssue {
  file: string;
  kind: 'missing' | 'hash-mismatch' | 'extra' | 'count-mismatch';
  detail: string;
}

/** 校验快照与 manifest 是否一致（任何不一致都算失败） */
export async function verifySnapshot(dir: string): Promise<VerifyIssue[]> {
  const issues: VerifyIssue[] = [];
  let manifest: FixtureManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, MANIFEST_NAME), 'utf-8')) as FixtureManifest;
  } catch {
    return [{ file: MANIFEST_NAME, kind: 'missing', detail: '快照缺少 manifest.json' }];
  }

  const { files, counts } = await inspectSnapshot(dir);

  for (const [name, fp] of Object.entries(manifest.files)) {
    const actual = files[name];
    if (!actual) {
      issues.push({ file: name, kind: 'missing', detail: 'manifest 中有记录，但文件不存在' });
      continue;
    }
    if (actual.sha256 !== fp.sha256) {
      issues.push({
        file: name,
        kind: 'hash-mismatch',
        detail: `SHA-256 不符：期望 ${fp.sha256.slice(0, 12)}…，实际 ${actual.sha256.slice(0, 12)}…`,
      });
    }
  }

  for (const name of Object.keys(files)) {
    if (!(name in manifest.files)) {
      issues.push({ file: name, kind: 'extra', detail: '文件存在但 manifest 未记录（快照被擅自追加）' });
    }
  }

  for (const [key, expected] of Object.entries(manifest.counts)) {
    const actual = (counts as unknown as Record<string, number>)[key];
    if (actual !== expected) {
      issues.push({
        file: MANIFEST_NAME,
        kind: 'count-mismatch',
        detail: `统计项 ${key}：manifest 记 ${expected}，实际 ${actual}`,
      });
    }
  }

  return issues;
}

/** 列出 fixtures/ 下的全部快照目录 */
export async function listSnapshots(): Promise<string[]> {
  try {
    const entries = await readdir(FIXTURES_ROOT, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// ─────────────────── CLI ───────────────────

const isDirectRun = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href ||
  (process.argv[1] ?? '').endsWith('fixture-manifest.ts');

if (isDirectRun) {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const targetDir = dirIdx >= 0 ? resolve(REPO_ROOT, args[dirIdx + 1] ?? '') : null;

  if (targetDir && args.includes('--write')) {
    const manifest = await buildManifest(targetDir);
    await writeFile(join(targetDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    console.log(`✓ 已写入 ${join(targetDir, MANIFEST_NAME)}`);
    console.log(`  门店 ${manifest.provenance.storeCode} ${manifest.provenance.storeName}`);
    console.log(`  采集 ${manifest.provenance.capturedAt}`);
    console.log(`  统计 ${JSON.stringify(manifest.counts)}`);
    console.log('  文件：');
    for (const [n, f] of Object.entries(manifest.files)) console.log(`    ${f.sha256.slice(0, 12)}…  ${n}`);
  } else {
    const snapshots = targetDir ? [targetDir] : (await listSnapshots()).map((n) => join(FIXTURES_ROOT, n));
    if (snapshots.length === 0) {
      console.error('✗ fixtures/ 下没有快照');
      process.exitCode = 1;
    } else {
      let failed = 0;
      for (const dir of snapshots) {
        const issues = await verifySnapshot(dir);
        const name = dir.split(/[\\/]/).pop();
        if (issues.length === 0) {
          console.log(`✓ ${name} —— 与 manifest 一致`);
        } else {
          failed++;
          console.error(`✗ ${name} —— ${issues.length} 处不一致：`);
          for (const i of issues) console.error(`    [${i.kind}] ${i.file}：${i.detail}`);
        }
      }
      if (failed > 0) {
        console.error('\n夹具快照校验失败。若确需新数据，请**新建**快照（不要改旧快照）：');
        console.error('  npm run capture                       # 采到 work/captures/<时间戳>/');
        console.error('  node scripts/fixture-manifest.ts --dir fixtures/<新快照名> --write');
        process.exitCode = 1;
      }
    }
  }
}
