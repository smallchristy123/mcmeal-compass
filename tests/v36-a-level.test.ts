/**
 * v3.6 · A 级可达性回归（甲案）
 *
 * 背景：v3.3 复评指出「当前真实案例的 A 级数量为 0，但文档中的 A 级定义仍与实现不一致」，
 * 并建议**修实现使 A 可达**，同时**补一个真正可达的回归用例**。
 *
 * 甲案语义（与 README「A 官方单品 / B 可追溯组合」对齐）：
 *   · **A** = 官方单品**精确直配**（`code-mapping` / `exact-name`）、营养完整、**不含推断**；
 *   · **B** = 组合求和，或含推断/别名/变体/份量匹配；
 *   · **C** = 部分可知；**D** = 无可用信息（不给数字）。
 *
 * 修前 `hasComposition ? 'A' : 'B'` 使 A **对单品永远不可达**，故本文件的首要断言是「**A 真能到达**」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { type NutritionRow } from '../src/schema.ts';
import { NutritionMatcher, assignConfidence } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { analyzeSingle, analyzeMenu } from '../src/analyze.ts';
import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';

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

const item = (code: string, name: string) => ({
  code,
  name,
  image: null,
  currentPrice: 2000 as never,
  originalPrice: 2000 as never,
  canWithOrder: false,
  discountType: null,
  tags: [] as string[],
  category: '测试分类',
});

describe('v3.6 甲案 · A 级可达性（复评第 5 条）', () => {
  test('① 官方单品精确直配、完整、无推断 ⇒ **A**（此前不可达）', () => {
    const m = new NutritionMatcher([nut('巨无霸')]);
    const a = analyzeSingle(item('1', '巨无霸'), m);
    assert.equal(a.confidence, 'A', '精确直配的完整单品应为最高档 A');
  });

  test('② 含推断（risky 别名）⇒ **不升 A**，落 B', () => {
    const m = new NutritionMatcher([nut('麦辣鸡翅-2块')], {
      aliases: [{ alias: '麦辣鸡翅', nutrition: '麦辣鸡翅-2块', note: '按 2 块计', risky: true }],
    });
    const a = analyzeSingle(item('2', '麦辣鸡翅'), m);
    assert.notEqual(a.confidence, 'A', '含推断成分不得进最高档');
    assert.equal(a.confidence, 'B');
  });

  test('③ 精确命中但营养不完整 ⇒ C（不给 A）', () => {
    const m = new NutritionMatcher([nut('半数据堡', { protein: null })]);
    const a = analyzeSingle(item('3', '半数据堡'), m);
    assert.equal(a.confidence, 'C');
  });

  test('④ 未命中 ⇒ D，且不给营养数字', () => {
    const m = new NutritionMatcher([nut('巨无霸')]);
    const a = analyzeSingle(item('4', '完全不存在的东西'), m);
    assert.equal(a.confidence, 'D');
    assert.equal(a.totals.energyKcal.value, null);
  });

  test('⑤ 判据本身：精确且完整无推断 ⇒ A；别名或 risky ⇒ B；组合求和 ⇒ B', () => {
    const n = nut('X');
    assert.equal(assignConfidence(n, { method: 'exact-name', risky: false }), 'A');
    assert.equal(assignConfidence(n, { method: 'code-mapping', risky: false }), 'A');
    assert.equal(assignConfidence(n, { method: 'alias', risky: true }), 'B');
    assert.equal(assignConfidence(n, { method: 'exact-name', risky: true }), 'B', 'risky 即使精确也不进 A');
    assert.equal(assignConfidence(n, { method: 'variant', risky: false }), 'B');
    assert.equal(assignConfidence(n, { hasComposition: true }), 'A', '组件级（有官方组成）保留旧行为');
  });

  test('⑥ 可达性实测：快照内 A 级数量 > 0，且 A 级全部是单品', async () => {
    const b = await loadFixtures();
    const m = new NutritionMatcher(b.nutritionRows, { aliases: DEFAULT_ALIASES });
    const { items } = await analyzeMenu(b.menuItems, m, fixtureDetailLoader(b), {});
    const aLevel = items.filter((i) => i.confidence === 'A');
    assert.ok(aLevel.length > 0, '快照内必须存在 A 级（否则本档仍是死代码）');
    assert.ok(
      aLevel.every((i) => i.kind === 'single'),
      'A 级应仅为「官方单品直配」；组合求和归 B',
    );
    // 组合求和的套餐不得进 A
    const combos = items.filter((i) => i.kind === 'combo' && i.confidence === 'A');
    assert.equal(combos.length, 0, '套餐（组合求和）不得为 A');
  });
});
