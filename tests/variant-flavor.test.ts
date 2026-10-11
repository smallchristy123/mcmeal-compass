/**
 * variant 端到端测试（P1-2）+ 口味歧义（与份量同类问题）
 *
 * 评审原话：「variant 只在匹配器单元测试中存在，尚未贯通用户输入到输出」——
 * 本文件就是这条的验收：**用户补一个输入 → 营养数字随之出现，且来源写清楚**。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadFixtures } from '../src/fixtures.ts';
import { NutritionMatcher } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { analyzeMenu, analyzeSingle } from '../src/analyze.ts';
import { fixtureDetailLoader } from '../src/fixtures.ts';

const matcher = async () => {
  const b = await loadFixtures();
  return { b, m: new NutritionMatcher(b.nutritionRows, { aliases: DEFAULT_ALIASES }) };
};

describe('P1-2 · variant 贯通：请求输入 → 匹配 → 营养 → 输出', () => {
  test('份量：薯条未指定 → D 级并列候选；指定「中」→ 出营养且来源可溯', async () => {
    const { b, m } = await matcher();
    const tiao = b.menuItems.find((i) => i.name === '薯条');
    assert.ok(tiao, '快照里应有「薯条」');

    const before = analyzeSingle(tiao!, m);
    assert.equal(before.confidence, 'D');
    assert.equal(before.totals.energyKcal.value, null);
    assert.deepEqual(before.sizeCandidates?.map((c) => c.size), ['迷你', '小', '中', '大']);

    const after = analyzeSingle(tiao!, m, '中');
    assert.equal(after.confidence, 'B');
    assert.equal(after.totals.energyKcal.value, 289);
    assert.equal(after.evidence[0]!.label, '官方单品营养：中薯条');
    assert.equal(after.sizeCandidates, undefined, '已明确份量，不应再报歧义');
  });

  test('口味：新地未指定 → 列朱古力/草莓；指定「朱古力」→ 出营养（口味不同即不同物）', async () => {
    const { b, m } = await matcher();
    const xd = b.menuItems.find((i) => i.name === '新地');
    assert.ok(xd, '快照里应有「新地」');

    const before = analyzeSingle(xd!, m);
    assert.equal(before.confidence, 'D');
    assert.deepEqual(before.flavorCandidates?.map((c) => c.flavor), ['朱古力', '草莓']);

    const after = analyzeSingle(xd!, m, '朱古力');
    assert.equal(after.confidence, 'B');
    assert.equal(after.totals.energyKcal.value, 282);
    assert.equal(after.evidence[0]!.label, '官方单品营养：朱古力新地');
  });

  test('菜单级：analyzeMenu 的 variants 映射生效（指定后歧义项减少）', async () => {
    const { b, m } = await matcher();
    const base = await analyzeMenu(b.menuItems, m, fixtureDetailLoader(b), {});
    const withVariant = await analyzeMenu(b.menuItems, m, fixtureDetailLoader(b), {
      variants: { [b.menuItems.find((i) => i.name === '薯条')!.code]: '中' },
    });

    const countAmbiguous = (r: typeof base) =>
      r.items.filter((i) => (i.sizeCandidates?.length ?? 0) >= 2).length;

    assert.equal(countAmbiguous(withVariant), countAmbiguous(base) - 1, '指定份量后歧义项应少一项');
    const tiao = withVariant.items.find((i) => i.name === '薯条')!;
    assert.equal(tiao.confidence, 'B');
  });

  test('口味的三种实测形态都能列出候选（不猜）', async () => {
    const { b, m } = await matcher();
    const res = m.matchAll(b.menuItems).results.filter((r) => r.method === 'flavor-ambiguous');
    const map = new Map(res.map((r) => [r.menuName, (r.flavorCandidates ?? []).map((c) => c.flavor).join('/')]));
    assert.equal(map.get('新地'), '朱古力/草莓');
    assert.equal(map.get('派'), '香芋/菠萝');
    assert.equal(map.get('经典麦旋风'), '奥利奥/草莓');
    assert.equal(res.length, 3, '口味歧义应恰为这 3 项（无假阳性）');
  });

  test('口味明确时不吃「份量歧义」的兜底，也不误配（蓝莓爆爆珠麦旋风仍为未匹配）', async () => {
    const { b, m } = await matcher();
    const r = m.match({ code: 'X', name: '蓝莓爆爆珠麦旋风' }, false);
    assert.equal(r.method, 'unmatched', '营养表里没有这个口味 → 不得拿奥利奥/草莓顶替');
  });
});
