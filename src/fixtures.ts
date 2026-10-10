/**
 * 离线夹具加载（使演示**无需 Token**）
 *
 * 夹具来自 `scripts/capture-fixtures.ts` 对一次真实调用的冻结，
 * 内容均为公开菜单与营养数据。他人 clone 仓库后可直接跑：
 *
 *   node src/cli.ts --offline
 *
 * 这样「能不能跑通」不再依赖对方有没有申请到 Token——对开源项目而言，
 * 这是「可复现」与「被看见」的共同前提。
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
export const DEFAULT_FIXTURE_DIR = join(here, '..', 'docs', 'probe');

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

  return { storeCode, storeName, capturedAt, nutritionRows, menuItems, combos };
}

/** 用夹具构造一个「详情加载器」，可喂给 analyzeMenu */
export function fixtureDetailLoader(bundle: FixtureBundle) {
  return async (code: string) => bundle.combos.get(code) ?? null;
}
