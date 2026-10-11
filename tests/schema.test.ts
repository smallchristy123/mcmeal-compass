/**
 * 统一 schema 单元测试（T1.2）
 *
 * 重点：类型转换不得改变语义——
 *   · 缺失（null）绝不被填成 0；
 *   · 「元 → 分」只发生一次，且可验证；
 *   · 真实探针留档能被完整解析（回归护栏）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_DIR_PARTS } from '../src/fixtures.ts';

import { parseToon, extractOriginalResponse, unwrapMcpData } from '../src/toon.ts';
import {
  toNutritionRow,
  toNutritionRows,
  toMenuItems,
  toMealDetail,
  toPriceResult,
  QueryMealsDataSchema,
} from '../src/schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const probe = (f: string) => join(here, '..', ...FIXTURE_DIR_PARTS, f);
const readToolText = async (...seg: string[]) => {
  const raw = JSON.parse(await readFile(join(here, '..', ...seg), 'utf-8')) as {
    result: { content: { text: string }[] };
  };
  return raw.result.content[0]!.text;
};

describe('toNutritionRow · 缺失与零的区分', () => {
  test('null 保持 null', () => {
    const r = toNutritionRow({
      productName: '测试汉堡',
      nutritionDescription: null,
      energyKj: '1000',
      energyKcal: '240',
      protein: null,
      fat: '10',
      carbohydrate: '30',
      sodium: '500',
      calcium: '100',
    });
    assert.equal(r.protein, null);
    assert.equal(r.fat, 10);
  });

  test('"0" 转成数字 0，不是 null', () => {
    const r = toNutritionRow({ productName: '可乐', protein: '0', energyKcal: '147' });
    assert.equal(r.protein, 0);
    assert.notEqual(r.protein, null);
  });

  test('空串视为缺失（null），非 0', () => {
    const r = toNutritionRow({ productName: 'x', protein: '' });
    assert.equal(r.protein, null);
  });

  test('字面量 "null" 也归为缺失', () => {
    const r = toNutritionRow({ productName: 'x', nutritionDescription: 'null' });
    assert.equal(r.nutritionDescription, null);
  });

  test('名称为空的记录被拒绝（zod 抛错）', () => {
    assert.throws(() => toNutritionRow({ productName: '' }));
  });
});

describe('真实营养表留档（160 条）', () => {
  test('解析后 160 条，且 157 条 nutritionDescription 为 null', async () => {
    const env = extractOriginalResponse(
      await readToolText(...FIXTURE_DIR_PARTS, 'list-nutrition-foods.raw.json'),
    ) as { data: string };
    const { rows, skipped } = toNutritionRows(parseToon(env.data));
    assert.equal(rows.length, 160);
    assert.equal(skipped, 0);
    assert.equal(rows.filter((r) => r.nutritionDescription === null).length, 157);
    // 「麦辣鸡翅-2块」这类带连接号的名称被完整保留
    assert.ok(rows.some((r) => r.productName === '麦辣鸡翅-2块'));
    // 巨无霸数值正确
    const jw = rows.find((r) => r.productName === '巨无霸');
    assert.equal(jw?.energyKcal, 513);
    assert.equal(jw?.protein, 27);
  });
});

describe('toMenuItems · 元→分 只转一次', () => {
  test('真实菜单留档：价格已为分（单位只转一次）', async () => {
    const data = unwrapMcpData(await readFile(probe('query-meals.raw.txt'), 'utf-8'));
    const { items, missing } = toMenuItems(QueryMealsDataSchema.parse(data));
    // ⚠️ 菜单是**动态数据**：同一门店两次采集间条目数就可能变（实测 128 → 130）。
    // 故此处不做精确计数断言，改为结构性断言 + 关键样本核对。
    assert.ok(items.length >= 100, `菜单项应有上百条，实际 ${items.length}`);
    assert.equal(missing.length, 0, '分类里引用的 code 都应能在 meals 映射表中找到');

    const combo = items.find((i) => i.code === '9900005456');
    assert.equal(combo?.name, '麦辣鸡腿汉堡三件套');
    assert.equal(combo?.currentPrice, 3800); // "38" 元 → 3800 分
    assert.equal(combo?.originalPrice, 3800);
  });

  test('分类名被带上，便于展示分组', async () => {
    const data = unwrapMcpData(await readFile(probe('query-meals.raw.txt'), 'utf-8'));
    const { items } = toMenuItems(QueryMealsDataSchema.parse(data));
    assert.ok(items.every((i) => typeof i.category === 'string' && i.category.length > 0));
    assert.ok(items.some((i) => i.category === '人气热卖'));
  });
});

describe('toMealDetail · 选配轮次与差价', () => {
  test('真实套餐留档：轮次、默认项、差价均正确', async () => {
    const data = unwrapMcpData(await readFile(probe('query-meal-detail.raw.txt'), 'utf-8'));
    const d = toMealDetail(data);
    assert.equal(d.code, '9900005456');
    assert.equal(d.name, '麦辣鸡腿汉堡三件套');
    assert.ok(d.rounds.length >= 3);

    const sideRound = d.rounds.find((r) => r.name.includes('小食'));
    assert.ok(sideRound, '应存在「选择套餐内小食」轮次');

    const defaultSide = sideRound!.choices.find((c) => c.isDefault);
    assert.equal(defaultSide?.name, '中薯条');
    assert.equal(defaultSide?.diffPrice, 0); // "+ ¥0"

    const bigFries = sideRound!.choices.find((c) => c.name === '大薯条');
    assert.equal(bigFries?.diffPrice, 200); // "+ ¥2"

    const smallCorn = sideRound!.choices.find((c) => c.name === '小杯玉米杯');
    assert.equal(smallCorn?.diffPrice, -50); // "- ¥0.5"

    // 轮次约束：单选
    assert.equal(sideRound!.minQuantity, 1);
    assert.equal(sideRound!.maxQuantity, 1);
  });
});

describe('toPriceResult · 计价口径（分）', () => {
  test('真实计价留档：¥38.00 与菜单价吻合', async () => {
    const data = unwrapMcpData(await readFile(probe('calculate-price.raw.txt'), 'utf-8'));
    const p = toPriceResult(data);
    assert.equal(p.price, 3800);
    assert.equal(p.originalPrice, 3800);
    assert.equal(p.discount, 0);
    assert.equal(p.productList.length, 1);
    assert.equal(p.productList[0]!.productName, '麦辣鸡腿汉堡三件套');
    assert.equal(p.productList[0]!.subtotal, 3800);
    assert.deepEqual(
      p.takeWayList.map((t) => t.title),
      ['堂食', '外带'],
    );
  });
});
