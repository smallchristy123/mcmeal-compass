/**
 * v3.6.1 · 匹配器 API 口径一致性回归（复评 P2）
 *
 * 复评实测并指出：同一个完整、精确名称命中的单品「巨无霸」，
 *   · `NutritionMatcher.match()` → B（旧口径）
 *   · `analyzeSingle()`          → A（v3.6 新口径）
 * 原因是 v3.6 只改了 `analyzeSingle()` 的调用，**匹配器内部 5 处仍走旧式判据**。
 * 由于 `NutritionMatcher` / `matchAll()` 是**导出接口**，这会造成对外口径分裂。
 *
 * v3.6.1 已统一：`match()` 各分支（code-mapping / variant / exact-name / alias）均传入
 * `{ hasComposition, method, risky }`，`risky` 也交由判据内部处理。
 *
 * ⚠️ 同时**明确界定职责边界**（复评允许的另一条路径）：
 *   `match()` / `matchAll()` / `summarize()`
 *     ＝ 只回答「**名称 ↔ 营养表**」，**不含套餐展开**（套餐类项目恒为 unmatched / D）；
 *   `analyzeMenu().summary`
 *     ＝ **含套餐展开**的整体分布（套餐可进 A/B/C）。
 *   因此二者在**整体**上本就不同；**单品子集**上必须完全一致——本文件即断言此点。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';
import { NutritionMatcher, summarize } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { analyzeMenu, analyzeSingle, looksLikeCombo } from '../src/analyze.ts';
import { type Confidence } from '../src/matching.ts';

const load = async () => {
  const b = await loadFixtures();
  const matcher = new NutritionMatcher(b.nutritionRows, { aliases: DEFAULT_ALIASES });
  return { b, matcher };
};

describe('v3.6.1 · 匹配器与分析的 A/B 口径一致性（复评 P2）', () => {
  test('① 同一精确单品：`match()` 与 `analyzeSingle()` 必须同值（此处均为 A）', async () => {
    const { b, matcher } = await load();
    const singles = b.menuItems.filter((i) => !looksLikeCombo(i.name)).slice(0, 30);
    let checked = 0;
    for (const it of singles) {
      const viaMatch = matcher.match({ code: it.code, name: it.name });
      const viaAnalyze = analyzeSingle(it, matcher);
      assert.equal(
        viaMatch.confidence,
        viaAnalyze.confidence,
        `「${it.name}」口径不一致：match()=${viaMatch.confidence} / analyzeSingle()=${viaAnalyze.confidence}`,
      );
      checked++;
    }
    assert.ok(checked > 0, '应至少核对若干单品');
    // 且至少有一个真拿到 A（证明这一档确实可达，而非两侧同为 B）
    const anyA = singles.some((it) => matcher.match({ code: it.code, name: it.name }).confidence === 'A');
    assert.ok(anyA, '精确直配的单品应能取到 A 级');
  });

  test('② `matchAll().stats` 与 `summarize()` 对同一输入一致', async () => {
    const { b, matcher } = await load();
    const all = matcher.matchAll(b.menuItems);
    const again = summarize(all.results);
    assert.deepEqual(all.stats.byConfidence, again.byConfidence);
    assert.deepEqual(all.stats.byMethod, again.byMethod);
  });

  test('③ 职责边界（**文档化的预期差异**）：套餐在 matchAll 为未命中，在 analyzeMenu 可展开', async () => {
    const { b, matcher } = await load();
    const combos = b.menuItems.filter((i) => looksLikeCombo(i.name));
    assert.ok(combos.length > 0, '夹具内应有套餐类菜单项');

    // 匹配器只看「名称↔营养表」：套餐名不是营养表条目 ⇒ 一律 unmatched
    const firstCombo = combos[0]!;
    const viaMatch = matcher.match({ code: firstCombo.code, name: firstCombo.name });
    assert.notEqual(viaMatch.confidence, 'A', '套餐不得在匹配器层直接取到 A');

    // 分析层含套餐展开 ⇒ 套餐可进 B/C（甚至因主件未收录而 D，但**不是**因"名字没命中"）
    const { items } = await analyzeMenu(b.menuItems, matcher, fixtureDetailLoader(b), {});
    const analyzedCombos = items.filter((i) => i.kind === 'combo');
    assert.ok(analyzedCombos.length > 0, '分析层应识别出套餐');
    assert.ok(
      analyzedCombos.some((i) => i.confidence === 'B' || i.confidence === 'C'),
      '套餐展开后应至少出现 B 或 C（组合求和口径）',
    );
    // A 级仍全部是单品
    assert.ok(items.filter((i) => i.confidence === 'A').every((i) => i.kind === 'single'));
  });

  test('④ 单品子集上，两种口径的 A/B 分布完全一致', async () => {
    const { b, matcher } = await load();
    const singles = b.menuItems.filter((i) => !looksLikeCombo(i.name));

    const viaMatch: Record<Confidence, number> = { A: 0, B: 0, C: 0, D: 0 };
    for (const it of singles) viaMatch[matcher.match({ code: it.code, name: it.name }).confidence]++;

    const viaAnalyze: Record<Confidence, number> = { A: 0, B: 0, C: 0, D: 0 };
    for (const it of singles) viaAnalyze[analyzeSingle(it, matcher).confidence]++;

    assert.deepEqual(viaAnalyze, viaMatch, '单品子集上两口径必须逐档相等');
  });
});
