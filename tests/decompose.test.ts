/**
 * 套餐展开与替换校验单元测试（T1.6）
 *
 * 两条铁律必须被钉死：
 *   ① 缺失不补零——缺的字段标「不完整」，值给「已知部分之和」，绝不当 0；
 *   ② 非法替换必拒——不在该轮次选项里的替换一律拒绝，并回列允许项。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unwrapMcpData } from '../src/toon.ts';
import { cents } from '../src/money.ts';
import { toMealDetail, type MealDetail } from '../src/schema.ts';
import { NutritionMatcher } from '../src/matching.ts';
import {
  checkSubstitutions,
  selectChoices,
  computeTotals,
  decomposeMeal,
  type DecomposedComponent,
} from '../src/decompose.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';

const here = dirname(fileURLToPath(import.meta.url));
const probe = (f: string) => join(here, '..', 'docs', 'probe', f);

/** 迷你营养行工具 */
const nut = (productName: string, over: Record<string, unknown> = {}) => ({
  productName,
  nutritionDescription: null,
  energyKj: 1000,
  energyKcal: 100,
  protein: 10,
  fat: 5,
  carbohydrate: 20,
  sodium: 200,
  calcium: 50,
  ...over,
});

/** 迷你套餐工具 */
const meal = (over: Partial<MealDetail> = {}): MealDetail => ({
  code: 'M1',
  name: '测试套餐',
  rounds: [
    {
      id: 1,
      name: '主餐',
      quantity: 1,
      minQuantity: 1,
      maxQuantity: 1,
      choices: [
        { code: 'A', name: '汉堡甲', quantity: 1, maxQuantity: -1, isDefault: true, diffPrice: cents(0), supportModify: true, composition: [] },
        { code: 'B', name: '汉堡乙', quantity: 0, maxQuantity: -1, isDefault: false, diffPrice: cents(200), supportModify: false, composition: [] },
      ],
    },
    {
      id: 2,
      name: '小食',
      quantity: 1,
      minQuantity: 1,
      maxQuantity: 1,
      choices: [
        { code: 'C', name: '中薯条', quantity: 1, maxQuantity: -1, isDefault: true, diffPrice: cents(0), supportModify: false, composition: [] },
        { code: 'D', name: '大薯条', quantity: 0, maxQuantity: -1, isDefault: false, diffPrice: cents(200), supportModify: false, composition: [] },
      ],
    },
  ],
  ...over,
});

describe('selectChoices · 默认项选择', () => {
  test('无替换时选默认项', () => {
    const picked = selectChoices(meal());
    assert.deepEqual(picked.map((p) => p.choice.code), ['A', 'C']);
  });

  test('有替换时用替换项，未指定的轮次仍取默认', () => {
    const picked = selectChoices(meal(), [{ roundId: 2, choiceCode: 'D' }]);
    assert.deepEqual(picked.map((p) => p.choice.code), ['A', 'D']);
  });

  test('替换码不存在时回退默认（不静默用错项）', () => {
    const picked = selectChoices(meal(), [{ roundId: 2, choiceCode: '不存在的码' }]);
    assert.deepEqual(picked.map((p) => p.choice.code), ['A', 'C']);
  });
});

describe('checkSubstitutions · 非法替换必拒', () => {
  test('合法替换被接受', () => {
    const r = checkSubstitutions(meal(), [{ roundId: 2, choiceCode: 'D' }]);
    assert.equal(r.accepted.length, 1);
    assert.equal(r.rejected.length, 0);
  });

  test('选项不在该轮次 → 拒绝，并回列允许项', () => {
    const r = checkSubstitutions(meal(), [{ roundId: 2, choiceCode: 'A' }]); // A 属于轮次 1
    assert.equal(r.accepted.length, 0);
    assert.equal(r.rejected.length, 1);
    assert.ok(r.rejected[0]!.reason.includes('不在轮次'));
    assert.deepEqual(
      r.rejected[0]!.allowed.map((a) => a.code),
      ['C', 'D'],
    );
  });

  test('轮次不存在 → 拒绝', () => {
    const r = checkSubstitutions(meal(), [{ roundId: 99, choiceCode: 'C' }]);
    assert.equal(r.rejected.length, 1);
    assert.ok(r.rejected[0]!.reason.includes('不存在轮次'));
  });

  test('「升级套餐」这类不存在的选项被拒（不悄悄改单）', () => {
    const r = checkSubstitutions(meal(), [{ roundId: 1, choiceCode: '升级加钱' }]);
    assert.equal(r.accepted.length, 0);
    assert.equal(r.rejected[0]!.allowed.length, 2);
  });
});

describe('computeTotals · 缺失不补零', () => {
  const matcher = new NutritionMatcher([
    nut('汉堡甲', { energyKcal: 500, protein: 25 }),
    nut('中薯条', { energyKcal: 300, protein: null }), // 蛋白质缺失
  ]);

  const mk = (name: string, code: string): DecomposedComponent => ({
    roundId: 1,
    roundName: 'r',
    choiceCode: code,
    choiceName: name,
    isDefault: true,
    diffPrice: null,
    quantity: 1,
    match: matcher.match({ code, name }),
  });

  test('齐全时合计正确且标完整', () => {
    const t = computeTotals([mk('汉堡甲', 'A'), mk('中薯条', 'C')]);
    assert.equal(t.energyKcal.value, 800);
    assert.equal(t.energyKcal.complete, true);
  });

  test('有组件缺该字段 → 值给已知部分之和，complete=false，且**不是 0**', () => {
    const t = computeTotals([mk('汉堡甲', 'A'), mk('中薯条', 'C')]);
    assert.equal(t.protein.value, 25); // 只有汉堡甲贡献
    assert.equal(t.protein.complete, false);
    assert.equal(t.protein.knownCount, 1);
    assert.equal(t.protein.totalCount, 2);
    assert.notEqual(t.protein.value, 0);
  });

  test('全部组件都缺该字段 → 值为 null（不是 0）', () => {
    const m2 = new NutritionMatcher([nut('x', { protein: null }), nut('y', { protein: null })]);
    const comps: DecomposedComponent[] = ['x', 'y'].map((n) => ({
      roundId: 1, roundName: 'r', choiceCode: n, choiceName: n,
      isDefault: true, diffPrice: null, quantity: 1, match: m2.match({ code: n, name: n }),
    }));
    const t = computeTotals(comps);
    assert.equal(t.protein.value, null);
    assert.notEqual(t.protein.value, 0);
    assert.equal(t.protein.complete, false);
  });

  test('数量参与合计', () => {
    const c = mk('汉堡甲', 'A');
    const t = computeTotals([{ ...c, quantity: 2 }]);
    assert.equal(t.energyKcal.value, 1000);
  });

  test('空组件 → 全部 null，不崩', () => {
    const t = computeTotals([]);
    assert.equal(t.energyKcal.value, null);
    assert.equal(t.energyKcal.complete, false);
  });
});

describe('deriveMealConfidence · 套餐可信度', () => {
  const mkMatcher = () =>
    new NutritionMatcher([nut('汉堡甲'), nut('中薯条')]);

  test('全部命中且齐全 → B（可追溯组合）', () => {
    const m = mkMatcher();
    const d = meal();
    const r = decomposeMeal({ ...d, rounds: d.rounds.map((rd) => ({
      ...rd, choices: rd.choices.filter((c) => c.isDefault),
    })) }, m);
    assert.equal(r.confidence, 'B');
  });

  test('有组件未命中 → C', () => {
    const m = new NutritionMatcher([nut('汉堡甲')]); // 中薯条不在
    const d = meal();
    const r = decomposeMeal({ ...d, rounds: d.rounds.map((rd) => ({
      ...rd, choices: rd.choices.filter((c) => c.isDefault),
    })) }, m);
    assert.equal(r.confidence, 'C');
    assert.equal(r.unmatchedComponents.length, 1);
    assert.ok(r.notes.some((n) => n.includes('未匹配到官方营养')));
  });

  test('全部未命中 → D', () => {
    const m = new NutritionMatcher([]);
    const d = meal();
    const r = decomposeMeal({ ...d, rounds: d.rounds.map((rd) => ({
      ...rd, choices: rd.choices.filter((c) => c.isDefault),
    })) }, m);
    assert.equal(r.confidence, 'D');
  });

  test('含 risky 别名 → 降为 C（配料可能不同，只到「部分可知」）', () => {
    const m = new NutritionMatcher([nut('麦辣鸡翅-2块'), nut('中薯条')], { aliases: DEFAULT_ALIASES });
    const r = decomposeMeal(
      {
        code: 'X', name: '翅桶',
        rounds: [
          { id: 1, name: '小食', quantity: 1, minQuantity: 1, maxQuantity: 1, choices: [
            { code: 'W', name: '麦辣鸡翅', quantity: 1, maxQuantity: -1, isDefault: true, diffPrice: cents(0), supportModify: false, composition: [] }] },
        ],
      },
      m,
    );
    assert.equal(r.confidence, 'C');
  });
});

describe('decomposeMeal · 真实套餐留档', () => {
  test('麦辣鸡腿汉堡三件套：展开 3 轮，合计正确，可信度 B', async () => {
    const detail = toMealDetail(unwrapMcpData(await readFile(probe('query-meal-detail.raw.txt'), 'utf-8')));

    // 用真实营养表
    const { parseToon, extractOriginalResponse } = await import('../src/toon.ts');
    const { toNutritionRows } = await import('../src/schema.ts');
    const nutEnv = extractOriginalResponse(
      (JSON.parse(await readFile(probe('list-nutrition-foods.raw.json'), 'utf-8')) as {
        result: { content: { text: string }[] };
      }).result.content[0]!.text,
    ) as { data: string };
    const { rows } = toNutritionRows(parseToon(nutEnv.data));
    const matcher = new NutritionMatcher(rows, { aliases: DEFAULT_ALIASES });

    const r = decomposeMeal(detail, matcher);
    assert.equal(r.code, '9900005456');
    assert.equal(r.components.length, 3);
    assert.equal(r.unmatchedComponents.length, 0);

    // 默认组合：麦辣鸡腿汉堡 + 中薯条 + 可乐中杯
    assert.deepEqual(
      r.components.map((c) => c.choiceName),
      ['麦辣鸡腿汉堡', '中薯条', '可乐中杯'],
    );

    // 热量应等于三者之和
    const sum = r.components.reduce((a, c) => a + (c.match.nutrition?.energyKcal ?? 0), 0);
    assert.equal(r.totals.energyKcal.value, sum);
    assert.equal(r.totals.energyKcal.complete, true);
    assert.ok(sum > 0);
  });

  test('替换为大薯条：接受并反映在组件上；非法替换被拒', async () => {
    const detail = toMealDetail(unwrapMcpData(await readFile(probe('query-meal-detail.raw.txt'), 'utf-8')));
    const { parseToon, extractOriginalResponse } = await import('../src/toon.ts');
    const { toNutritionRows } = await import('../src/schema.ts');
    const nutEnv = extractOriginalResponse(
      (JSON.parse(await readFile(probe('list-nutrition-foods.raw.json'), 'utf-8')) as {
        result: { content: { text: string }[] };
      }).result.content[0]!.text,
    ) as { data: string };
    const { rows } = toNutritionRows(parseToon(nutEnv.data));
    const matcher = new NutritionMatcher(rows, { aliases: DEFAULT_ALIASES });

    const sideRound = detail.rounds.find((x) => x.name.includes('小食'))!;
    const bigFries = sideRound.choices.find((c) => c.name === '大薯条')!;

    const ok = decomposeMeal(detail, matcher, [{ roundId: sideRound.id, choiceCode: bigFries.code }]);
    const sideComp = ok.components.find((c) => c.roundId === sideRound.id)!;
    assert.equal(sideComp.choiceName, '大薯条');
    assert.equal(sideComp.diffPrice, 200); // +¥2

    const bad = decomposeMeal(detail, matcher, [{ roundId: sideRound.id, choiceCode: '不存在' }]);
    assert.ok(bad.notes.some((n) => n.includes('已拒绝替换')));
    // 被拒后仍用默认项
    assert.equal(bad.components.find((c) => c.roundId === sideRound.id)!.choiceName, '中薯条');
  });
});
