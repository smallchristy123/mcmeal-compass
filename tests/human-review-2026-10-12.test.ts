/**
 * 分层样本（2026-10-12）发现的误配 → 回归测试
 *
 * 来源：35 条分层样本（`outputs/人工审核样本-2026-10-11-已填-2026-10-12.csv`）。
 * ⚠️ 该表由 **AI（尼可·莱恩）辅助复核预填**，**待主君确认**——
 * 不得表述为「主君亲判」或「人工审核已完成」（v3.2 复评指出）。
 * 判定结果：一致 18 / **误配 3** / 无法判 14，总体精确率 85.7%。
 *
 * 三条误配**同一病根**：套餐的**主件**（汉堡/松饼主件）未收录于官方营养表 →
 * 「已知组件之和」严重偏低（436 kcal 只等于「中薯条 + 可乐」），会误导用户。
 *
 * 处置（v3.2）：主件未收录 ⇒ **不给营养数字**（D 级）并写明原因；
 * 非食品组件（帽子等）不计入此判定，避免误伤。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';
import { NutritionMatcher } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { analyzeMenu, isStapleComponent, type AnalyzedItem } from '../src/analyze.ts';

const analyze = async (): Promise<AnalyzedItem[]> => {
  const b = await loadFixtures();
  const matcher = new NutritionMatcher(b.nutritionRows, { aliases: DEFAULT_ALIASES });
  const { items } = await analyzeMenu(b.menuItems, matcher, fixtureDetailLoader(b), {});
  return items;
};

describe('分层样本复核 2026-10-12 · 主件未收录的套餐不得给营养数字', () => {
  const diffCases = ['龙焰芝士棒鸡腿堡三件套', '枫糖风味厚松饼猪柳蛋堡三件套', '龙焰鸡腿堡四件套'];

  test('三条被判定为 diff 的套餐：D 级、无营养数字、且写明原因', async () => {
    const items = await analyze();
    for (const name of diffCases) {
      const it = items.find((i) => i.name === name);
      assert.ok(it, `快照中应有「${name}」`);
      assert.equal(it!.confidence, 'D', `${name} 应降为 D 级`);
      assert.equal(it!.totals.energyKcal.value, null, `${name} 不得再给出热量数字`);
      assert.equal(it!.totals.protein.value, null, `${name} 不得再给出蛋白数字`);
      assert.ok(
        it!.notes.some((n) => n.includes('主件未收录')),
        `${name} 必须写明"主件未收录"的原因`,
      );
    }
  });

  test('主件齐全的套餐不受影响（仍给数字）', async () => {
    const items = await analyze();
    const ok = items.find((i) => i.name === '人气超值四件套随心选');
    assert.ok(ok, '快照中应有该套餐');
    assert.ok((ok!.totals.energyKcal.value ?? 0) > 0, '主件齐全者应保留数字');
    assert.ok(['A', 'B', 'C'].includes(ok!.confidence));
  });

  test('仅漏「非食品组件」的套餐不得被误伤', async () => {
    const items = await analyze();
    const withHat = items.find((i) => i.name.includes('泷'));
    assert.ok(withHat, '快照中应有该套餐');
    assert.ok(
      (withHat!.totals.energyKcal.value ?? 0) > 0,
      '漏的是帽子（非食品），不应因此被抹掉营养数字',
    );
  });

  test('不变量：凡"主件未收录"的套餐，一律无营养数字（全快照扫描）', async () => {
    const items = await analyze();
    const flagged = items.filter((i) => i.notes.some((n) => n.includes('主件未收录')));
    assert.ok(flagged.length > 0, '快照中应存在主件未收录的套餐（否则本规则未被触发）');
    for (const it of flagged) {
      assert.equal(it.confidence, 'D', `${it.name} 应降为 D`);
      assert.equal(it.totals.energyKcal.value, null, `${it.name} 不得有热量数字`);
    }
  });

  test('主件识别规则本身：汉堡类算主件，非食品不算', () => {
    assert.equal(isStapleComponent('选择汉堡', '巨无霸'), true);
    assert.equal(isStapleComponent('龙焰芝士棒鸡腿堡', '龙焰芝士棒鸡腿堡'), true);
    assert.equal(isStapleComponent('小食', '中薯条'), false);
    assert.equal(isStapleComponent('选择套餐内饮料', '可乐中杯'), false);
    assert.equal(isStapleComponent('玩具', '按摩捶痒痒挠'), false, '非食品不得算主件');
  });
});
