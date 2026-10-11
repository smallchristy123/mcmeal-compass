/**
 * 离线夹具加载（使演示**无需 Token**）
 *
 * ## 契约（P0-1 之后，务必遵守）
 *
 * - 夹具位于 `fixtures/<snapshotId>/`，是**不可变快照**，只由人工显式新建；
 * - 每个快照带 `manifest.json`（来源 + 每文件 SHA-256 + 条数）；
 * - 默认加载 `fixtures/baseline-20261010-3450024`；
 *   如需换快照，设环境变量 `MCMEAL_FIXTURE=<snapshotId>`（或传 dir 参数）——**不要改旧快照**；
 * - 采集（`npm run capture`）只写 `work/captures/<时间戳>/`，**永不覆盖 fixtures/**。
 *
 * 这样「能不能跑通」既不必依赖对方申请到 Token，也不会因采一次数就让测试基线漂移。
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseToon, extractOriginalResponse, unwrapMcpData } from './toon.ts';
import {
  toNutritionRows,
  toMenuItems,
  QueryMealsDataSchema,
  RawMealDetailSchema,
  toMealDetail,
  type MenuItem,
  type MealDetail,
  type NutritionRow,
} from './schema.ts';

export interface FixtureBundle {
  /** 快照 id（目录名） */
  snapshotId: string;
  /** 采集自哪家门店 */
  storeCode: string;
  storeName: string;
  /** 采集时刻（来自响应里的 datetime） */
  capturedAt: string;
  nutritionRows: NutritionRow[];
  menuItems: MenuItem[];
  /** code → 套餐详情 */
  combos: Map<string, MealDetail>;
}

const here = dirname(fileURLToPath(import.meta.url));

/** 仓库根（src/ 的上一层） */
export const REPO_ROOT = join(here, '..');
/** 全部快照所在目录 */
export const FIXTURES_ROOT = join(REPO_ROOT, 'fixtures');
/** 默认快照 id —— 冻结于 2026-10-10，勿改；换数据须新建快照 */
export const DEFAULT_SNAPSHOT_ID = 'baseline-20261010-3450024';
/** 默认夹具目录（可用 MCMEAL_FIXTURE 覆盖） */
export const DEFAULT_FIXTURE_DIR = join(FIXTURES_ROOT, process.env['MCMEAL_FIXTURE'] ?? DEFAULT_SNAPSHOT_ID);
/**
 * 快照目录相对仓库根的路径片段——供各处 `join(repoRoot, ...FIXTURE_DIR_PARTS)` 使用，
 * 使「快照名」在整个仓库里**只有一处真相**（MCMEAL_FIXTURE 可覆盖）。
 */
export const FIXTURE_DIR_PARTS: readonly string[] = ['fixtures', process.env['MCMEAL_FIXTURE'] ?? DEFAULT_SNAPSHOT_ID];

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, 'utf-8')) as T;
}

export async function loadFixtures(dir: string = DEFAULT_FIXTURE_DIR): Promise<FixtureBundle> {
  // 营养表
  const nutRaw = await readJson<{ result: { content: { text: string }[] } }>(
    join(dir, 'list-nutrition-foods.raw.json'),
  );
  const nutEnv = extractOriginalResponse(nutRaw.result.content[0]!.text) as { data: string; datetime?: string };
  const { rows: nutritionRows } = toNutritionRows(parseToon(nutEnv.data));
  const capturedAt = nutEnv.datetime ?? '';

  // 菜单
  const menuText = await readFile(join(dir, 'query-meals.raw.txt'), 'utf-8');
  const menuData = unwrapMcpData(menuText);
  const { items: menuItems } = toMenuItems(QueryMealsDataSchema.parse(menuData));

  // 门店（query-nearby-stores 的 data 直接是数组；取第一家作展示）
  let storeCode = '';
  let storeName = '（离线夹具 · 门店未知）';
  try {
    const storePayload = unwrapMcpData(
      await readFile(join(dir, 'query-nearby-stores.raw.txt'), 'utf-8'),
    );
    // 兼容两种形状：直接数组 / { data: [...] }
    const list = Array.isArray(storePayload)
      ? (storePayload as Record<string, unknown>[])
      : ((storePayload as { data?: Record<string, unknown>[] } | null)?.data ?? []);
    const first = list[0];
    if (first) {
      storeCode = String(first['storeCode'] ?? '');
      storeName = String(first['storeName'] ?? storeName);
    }
  } catch {
    /* 门店留档缺失不影响主流程 */
  }

  // 套餐详情（可能不存在；不存在时全部走降级）
  const combos = new Map<string, MealDetail>();
  try {
    const bundle = await readJson<Record<string, unknown>>(join(dir, 'meal-details.bundle.json'));
    for (const [code, raw] of Object.entries(bundle)) {
      try {
        combos.set(code, toMealDetail(RawMealDetailSchema.parse(raw)));
      } catch {
        /* 单个套餐解析失败不影响其余 */
      }
    }
  } catch {
    /* 无 bundle */
  }

  return { snapshotId: dir.split(/[\\/]/).pop() ?? 'unknown', storeCode, storeName, capturedAt, nutritionRows, menuItems, combos };
}

/** 用夹具构造一个「详情加载器」，可喂给 analyzeMenu */
export function fixtureDetailLoader(bundle: FixtureBundle) {
  return async (code: string) => bundle.combos.get(code) ?? null;
}

/** 快照的 manifest 形状（与 scripts/fixture-manifest.ts 一致） */
export interface FixtureManifest {
  snapshotId: string;
  schemaVersion: number;
  provenance: {
    storeCode: string;
    storeName: string;
    capturedAt: string;
    orderType: number;
    beType: number;
    source: string;
    note?: string;
  };
  files: Record<string, { sha256: string; bytes: number }>;
  counts: { nutritionRows: number; menuItems: number; menuUniqueItems: number; mealDetails: number };
  generatedBy: string;
}

/** 读取快照 manifest（不存在则返回 null） */
export async function readManifest(dir: string = DEFAULT_FIXTURE_DIR): Promise<FixtureManifest | null> {
  try {
    return await readJson<FixtureManifest>(join(dir, 'manifest.json'));
  } catch {
    return null;
  }
}
