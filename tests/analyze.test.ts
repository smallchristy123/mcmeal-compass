/**
 * 营养分析单元测试（T1.5）
 *
 * 重点：两条路（单品直配 / 套餐展开）**输出同一种形状**，且
 * 可信度真实、缺失不补零、失败要诚实降级。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_DIR_PARTS } from '../src/fixtures.ts';

import { parseToon, extractOriginalResponse, unwrapMcpData } from '../src/toon.ts';
import {
  toNutritionRows,
  toMenuItems,
  QueryMealsDataSchema,
  toMealDetail,
  type MenuItem,
  type NutritionRow,
  type MealDetail,
} from '../src/schema.ts';
import { NutritionMatcher } from '../src/matching.ts';
import {
  totalsFromSingle,
  analyzeSingle,
  analyzeCombo,
  analyzeMenu,
  looksLikeCombo,
  hasSolidNutrition,
} from '../src/analyze.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';

const here = dirname(fileURLToPath(import.meta.url));
const probe = (f: string) => join(here, '..', ...FIXTURE_DIR_PARTS, f);

const nut = (productName: string, over: Partial<NutritionRow> = {}): NutritionRow => ({
  productName,
  nutritionDescription: null,
  energyKj: 1000,
  energyKcal: 240,
  protein: 10,
  fat: 8,
  carbohydrate: 30,
  sodium: 500,
  calcium: 100,
  ...over,
});

const item = (code: string, name: string, price = 3800): MenuItem => ({
  code,
  name,
  image: null,
  currentPrice: price as MenuItem['currentPrice'],
  originalPrice: price as MenuItem['originalPrice'],
  canWithOrder: false,
  discountType: null,
  tags: [],
  category: '测试分类',
});

describe('looksLikeCombo · 套餐识别', () => {
  test('识别常见套餐词', () => {
    for (const n of ['麦辣鸡腿汉堡三件套', '全明星双人分享餐八件套', '人气超值四件套随心选', '麦麦周末双人餐']) {
      assert.equal(looksLikeCombo(n), true, n);
    }
  });
  test('单品不被误判', () => {
    for (const n of ['巨无霸', '麦辣鸡翅', '中薯条', '可乐中杯']) {
      assert.equal(looksLikeCombo(n), false, n);
    }
  });
});

describe('totalsFromSingle · 单品包成统一形状', () => {
  test('有数据：complete=true', () => {
    const t = totalsFromSingle(nut('巨无霸'));
    assert.equal(t.energyKcal.value, 240);
    assert.equal(t.energyKcal.complete, true);
    assert.equal(t.energyKcal.totalCount, 1);
  });

  test('字段缺失：value=null 且 complete=false（不是 0）', () => {
    const t = totalsFromSingle(nut('x', { protein: null }));
    assert.equal(t.protein.value, null);
    assert.equal(t.protein.complete, false);
    assert.notEqual(t.protein.value, 0);
  });

  test('0 是有效值：complete=true', () => {
    const t = totalsFromSingle(nut('可乐', { protein: 0 }));
    assert.equal(t.protein.value, 0);
    assert.equal(t.protein.complete, true);
  });

  test('无营养记录：全 null', () => {
    const t = totalsFromSingle(null);
    assert.equal(t.energyKcal.value, null);
    assert.equal(t.energyKcal.complete, false);
    assert.equal(t.energyKcal.totalCount, 0);
  });
});

describe('analyzeSingle', () => {
  const matcher = new NutritionMatcher([nut('巨无霸'), nut('麦辣鸡翅-2块')], { aliases: DEFAULT_ALIASES });

  test('命中：给出证据与营养', () => {
    const a = analyzeSingle(item('1', '巨无霸'), matcher);
    assert.equal(a.kind, 'single');
    assert.equal(a.confidence, 'B'); // 无组成信息故 B
    assert.equal(a.totals.energyKcal.value, 240);
    assert.equal(a.evidence[0]!.kind, 'official-single');
    assert.ok(a.evidence[0]!.label.includes('巨无霸'));
  });

  test('未命中：D 级、无营养数字、有说明', () => {
    const a = analyzeSingle(item('2', '完全不存在的东西'), matcher);
    assert.equal(a.confidence, 'D');
    assert.equal(a.totals.energyKcal.value, null);
    assert.equal(a.evidence.length, 0);
    assert.ok(a.notes.some((n) => n.includes('D 级')));
  });
});

describe('analyzeCombo', () => {
  test('套餐展开后输出 combo 形状，证据含各组件来源', () => {
    const matcher = new NutritionMatcher([nut('汉堡甲'), nut('中薯条')]);
    const detail: MealDetail = {
      code: 'C1',
      name: '甲套餐',
      rounds: [
        { id: 1, name: '主餐', quantity: 1, minQuantity: 1, maxQuantity: 1, choices: [
          { code: 'A', name: '汉堡甲', quantity: 1, maxQuantity: -1, isDefault: true, diffPrice: 0 as never, supportModify: false, composition: [] }] },
        { id: 2, name: '小食', quantity: 1, minQuantity: 1, maxQuantity: 1, choices: [
          { code: 'C', name: '中薯条', quantity: 1, maxQuantity: -1, isDefault: true, diffPrice: 0 as never, supportModify: false, composition: [] }] },
      ],
    };
    const a = analyzeCombo(item('C1', '甲套餐'), detail, matcher);
    assert.equal(a.kind, 'combo');
    assert.equal(a.confidence, 'B');
    assert.equal(a.totals.energyKcal.value, 480); // 240 + 240
    assert.equal(a.evidence.length, 3); // 1 条汇总 + 2 条组件
    assert.equal(a.evidence[0]!.kind, 'official-combo-sum');
  });
});

describe('analyzeMenu · 统管两条路', () => {
  const matcher = new NutritionMatcher([nut('巨无霸'), nut('汉堡甲'), nut('中薯条')]);
  const detail: MealDetail = {
    code: 'COMBO1', name: '甲套餐',
    rounds: [
      { id: 1, name: '主餐', quantity: 1, minQuantity: 1, maxQuantity: 1, choices: [
        { code: 'A', name: '汉堡甲', quantity: 1, maxQuantity: -1, isDefault: true, diffPrice: 0 as never, supportModify: false, composition: [] }] },
    ],
  };

  test('单品走直配、套餐走展开，汇总统计正确', async () => {
    const r = await analyzeMenu(
      [item('1', '巨无霸'), item('COMBO1', '甲套餐'), item('X', '不存在的堡')],
      matcher,
      async (code) => (code === 'COMBO1' ? detail : null),
    );
    assert.equal(r.items.length, 3);
    assert.equal(r.summary.singles, 2);
    assert.equal(r.summary.combos, 1);
    assert.equal(r.summary.byConfidence.B, 2); // 巨无霸 + 甲套餐
    assert.equal(r.summary.byConfidence.D, 1); // 不存在的堡
    assert.equal(r.summary.usable, 2);
  });

  test('去重：同一 code 只保留一条', async () => {
    const r = await analyzeMenu(
      [item('1', '巨无霸'), item('1', '巨无霸'), item('2', '巨无霸')],
      matcher,
      async () => null,
    );
    assert.equal(r.items.length, 2);
  });

  test('套餐详情拉取失败 → 诚实降级为单品直配，并记说明', async () => {
    const r = await analyzeMenu(
      [item('COMBO1', '甲套餐')],
      matcher,
      async () => { throw new Error('网络超时'); },
    );
    assert.equal(r.items[0]!.kind, 'single');
    assert.ok(r.items[0]!.notes.some((n) => n.includes('降级为直接匹配')));
    assert.ok(r.items[0]!.notes.some((n) => n.includes('网络超时')));
  });

  test('套餐详情为空轮次 → 也降级', async () => {
    const r = await analyzeMenu(
      [item('C2', '空套餐')],
      matcher,
      async () => ({ code: 'C2', name: '空套餐', rounds: [] }),
    );
    assert.equal(r.items[0]!.kind, 'single');
    assert.ok(r.items[0]!.notes.some((n) => n.includes('套餐详情不可用')));
  });

  test('limit 生效；空输入不崩', async () => {
    const r = await analyzeMenu([item('1', '巨无霸'), item('2', '巨无霸')], matcher, async () => null, { limit: 1 });
    assert.equal(r.items.length, 1);
    const e = await analyzeMenu([], matcher, async () => null);
    assert.equal(e.summary.total, 0);
    assert.equal(e.summary.usable, 0);
  });
});

describe('hasSolidNutrition · 排序门槛', () => {
  const matcher = new NutritionMatcher([nut('巨无霸'), nut('缺项堡', { protein: null })]);

  test('A/B 且关键营养齐全 → true', () => {
    assert.equal(hasSolidNutrition(analyzeSingle(item('1', '巨无霸'), matcher)), true);
  });

  test('C 级（有缺）→ false', () => {
    assert.equal(hasSolidNutrition(analyzeSingle(item('2', '缺项堡'), matcher)), false);
  });

  test('D 级 → false', () => {
    assert.equal(hasSolidNutrition(analyzeSingle(item('3', '不存在'), matcher)), false);
  });
});

describe('真实数据端到端（留档）', () => {
  test('真实菜单 + 真实套餐详情：单品行直配、套餐行走展开', async () => {
    const nutEnv = extractOriginalResponse(
      (JSON.parse(await readFile(probe('list-nutrition-foods.raw.json'), 'utf-8')) as {
        result: { content: { text: string }[] };
      }).result.content[0]!.text,
    ) as { data: string };
    const { rows } = toNutritionRows(parseToon(nutEnv.data));
    const matcher = new NutritionMatcher(rows, { aliases: DEFAULT_ALIASES });

    const { items } = toMenuItems(
      QueryMealsDataSchema.parse(unwrapMcpData(await readFile(probe('query-meals.raw.txt'), 'utf-8'))),
    );
    const detail = toMealDetail(
      unwrapMcpData(await readFile(probe('query-meal-detail.raw.txt'), 'utf-8')),
    );

    // 只分析两个代表项：一个单品（巨无霸）、一个套餐
    const jw = items.find((i) => i.name === '巨无霸')!;
    const combo = items.find((i) => i.code === '9900005456')!;

    const r = await analyzeMenu(
      [jw, combo],
      matcher,
      async (code) => (code === '9900005456' ? detail : null),
    );

    const single = r.items.find((x) => x.code === jw.code)!;
    const comboA = r.items.find((x) => x.code === combo.code)!;

    assert.equal(single.kind, 'single');
    assert.equal(single.totals.energyKcal.value, 513); // 巨无霸 513 kcal
    assert.equal(single.evidence[0]!.kind, 'official-single');

    assert.equal(comboA.kind, 'combo');
    assert.equal(comboA.confidence, 'B');
    assert.ok((comboA.totals.energyKcal.value ?? 0) > 0);
  });
});
