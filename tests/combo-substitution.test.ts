/**
 * 套餐内替换（`--swap` / `substitutions`）端到端回归
 *
 * 缘起：2026-10-16 诊断发现——替换能力**早已实现且有测试**（`decompose.ts` 的
 * `checkSubstitutions` / `decomposeMeal`），但**批量入口传的是空数组**、CLI 与 SKILL 均无入口，
 * 于是「用户根本用不到」（开放项 O5）。本文件就是这条的验收：
 * **用户给一行输入 → 替换真生效 → 营养与价格随之重算；给错了 → 拒绝并回列可用项。**
 *
 * 同时钉死一条回归：**不传替换时，输出与从前逐字一致**（不得因为新增功能扰动既有行为）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';
import { NutritionMatcher } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { analyzeMenu } from '../src/analyze.ts';
import { resolveSubstitutions } from '../src/decompose.ts';
import { renderReplacement, parseArgs } from '../src/cli.ts';

const TARGET = '人气超值四件套随心选'; // 夹具套餐 9900004236：4 个轮次，饮料轮次名唯一
const DRINK_ROUND = '选择套餐内饮料';
const SUGAR_FREE = '无糖可口可乐中杯';

const setup = async () => {
  const b = await loadFixtures();
  const matcher = new NutritionMatcher(b.nutritionRows, { aliases: DEFAULT_ALIASES });
  const loadDetail = fixtureDetailLoader(b);
  const detail = await loadDetail('9900004236');
  assert.ok(detail, '夹具里应有套餐 9900004236 的详情');
  return { b, matcher, loadDetail, detail: detail! };
};

const analyzeWith = async (specs: { round: string; choice: string }[]) => {
  const { b, matcher, loadDetail } = await setup();
  return analyzeMenu(b.menuItems, matcher, loadDetail, {
    ...(specs.length === 0 ? {} : { substitutions: specs }),
  });
};

describe('替换请求 · 名称解析（resolveSubstitutions）', () => {
  test('正例：按轮次名 + 选项名 → 译出内部契约，且 applied 描述可读', async () => {
    const { detail } = await setup();
    const r = resolveSubstitutions(detail, [{ round: DRINK_ROUND, choice: SUGAR_FREE }]);
    assert.equal(r.unresolved.length, 0, '不应有解析失败');
    assert.equal(r.requests.length, 1);
    assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0]!.roundLabel, DRINK_ROUND);
    assert.equal(r.applied[0]!.choiceName, SUGAR_FREE);
    assert.ok(r.applied[0]!.choiceCode.length > 0, '应译出选项 code');
  });

  test('轮次名**不唯一**时不当机立断：拒绝，并请用户用「名称#序号」', async () => {
    const { detail } = await setup();
    // 该套餐有两个都叫「小食」的轮次——绝不能挑一个了事
    const r = resolveSubstitutions(detail, [{ round: '小食', choice: '大杯玉米杯' }]);
    assert.equal(r.requests.length, 0, '歧义时不得擅自替换');
    assert.equal(r.unresolved.length, 1);
    assert.equal(r.unresolved[0]!.kind, 'round-ambiguous');
    assert.match(r.unresolved[0]!.reason, /#1/, '应提示可用「名称#序号」');
  });

  test('「轮次名#序号」与「轮次 id」两种写法都能定位到同一轮次', async () => {
    const { detail } = await setup();
    const byOrdinal = resolveSubstitutions(detail, [{ round: '小食#2', choice: '薄皮焦香V翅' }]);
    assert.equal(byOrdinal.unresolved.length, 0);
    const id = String(byOrdinal.requests[0]!.roundId);
    const byId = resolveSubstitutions(detail, [{ round: id, choice: '薄皮焦香V翅' }]);
    assert.equal(byId.unresolved.length, 0);
    assert.equal(byId.requests[0]!.roundId, byOrdinal.requests[0]!.roundId);
    assert.equal(byId.requests[0]!.choiceCode, byOrdinal.requests[0]!.choiceCode);
  });

  test('选项也可用 code 指定', async () => {
    const { detail } = await setup();
    const byName = resolveSubstitutions(detail, [{ round: DRINK_ROUND, choice: SUGAR_FREE }]);
    const code = byName.requests[0]!.choiceCode;
    const byCode = resolveSubstitutions(detail, [{ round: DRINK_ROUND, choice: code }]);
    assert.equal(byCode.unresolved.length, 0);
    assert.equal(byCode.requests[0]!.choiceCode, code);
  });

  test('选项不在允许范围内 → 拒绝，并回列该轮次的可用项', async () => {
    const { detail } = await setup();
    const r = resolveSubstitutions(detail, [{ round: DRINK_ROUND, choice: '不存在的饮料' }]);
    assert.equal(r.requests.length, 0);
    assert.equal(r.unresolved[0]!.kind, 'choice-not-allowed');
    const allowed = r.unresolved[0]!.allowed;
    assert.equal(allowed.length, 1, '应只回列出问题的那一轮');
    assert.ok(
      allowed[0]!.choices.some((c) => c.name === SUGAR_FREE),
      '可用项里应含真正合法的选项',
    );
  });

  test('轮次不存在 → 拒绝（kind=round-not-found）', async () => {
    const { detail } = await setup();
    const r = resolveSubstitutions(detail, [{ round: '不存在的轮次', choice: '随便' }]);
    assert.equal(r.unresolved[0]!.kind, 'round-not-found');
  });

  test('同一轮次被指定多次 → 采用最后一条，并用 notes **说出来**（不静默覆盖）', async () => {
    const { detail } = await setup();
    const r = resolveSubstitutions(detail, [
      { round: DRINK_ROUND, choice: '可乐中杯' },
      { round: DRINK_ROUND, choice: SUGAR_FREE },
    ]);
    assert.equal(r.requests.length, 1, '同一轮次最终只应有一份请求');
    assert.equal(r.applied[0]!.choiceName, SUGAR_FREE, '应取最后一条');
    assert.equal(r.notes.length, 1, '覆盖了就必须说明');
    assert.match(r.notes[0]!, /多次/);
  });
});

describe('替换请求 · 端到端（analyzeMenu）', () => {
  test('替换真生效：目标套餐的饮料组件被换，且**营养随之重算**', async () => {
    const before = await analyzeWith([]);
    const after = await analyzeWith([{ round: DRINK_ROUND, choice: SUGAR_FREE }]);

    const a = before.items.find((i) => i.name === TARGET);
    const b2 = after.items.find((i) => i.name === TARGET);
    assert.ok(a && b2, `两侧都应含「${TARGET}」`);

    // ① 组件确实换了
    assert.ok(
      (a!.components ?? []).some((c) => c.choiceName === '可乐中杯'),
      '替换前应有「可乐中杯」',
    );
    assert.ok(
      (b2!.components ?? []).some((c) => c.choiceName === SUGAR_FREE),
      '替换后应含「无糖可口可乐中杯」',
    );
    assert.ok(
      !(b2!.components ?? []).some((c) => c.choiceName === '可乐中杯'),
      '替换后不应再留着被换掉的默认项',
    );

    // ② 数字跟着变（无糖可乐的碳水更低 → 热量与碳水应下降）
    const kcalBefore = a!.totals.energyKcal.value;
    const kcalAfter = b2!.totals.energyKcal.value;
    const carbBefore = a!.totals.carbohydrate.value;
    const carbAfter = b2!.totals.carbohydrate.value;
    assert.ok(kcalBefore !== null && kcalAfter !== null);
    assert.ok(carbBefore !== null && carbAfter !== null);
    assert.ok(kcalAfter < kcalBefore, `热量应下降：${kcalBefore} → ${kcalAfter}`);
    assert.ok(carbAfter < carbBefore, `碳水应下降：${carbBefore} → ${carbAfter}`);
    // 蛋白质不因换饮料而变（同为 0g 蛋白的饮料）
    assert.equal(b2!.totals.protein.value, a!.totals.protein.value);
  });

  test('不传替换时**与不传参等价**（新增功能不得扰动既有行为）', async () => {
    // 只比「行为」，不比墙钟：收据里的 `at` 是每次调用的实时时刻，本就该不同
    const strip = (items: unknown): unknown =>
      JSON.parse(
        JSON.stringify(items, (k, v) => (k === 'at' ? undefined : v)),
      ) as unknown;

    const withUndefined = await analyzeWith([]);
    const { b, matcher, loadDetail } = await setup();
    const noOption = await analyzeMenu(b.menuItems, matcher, loadDetail, {});
    assert.deepEqual(strip(withUndefined.items), strip(noOption.items));
    assert.equal(withUndefined.replacement, undefined, '没给请求就不该有报告');
    assert.equal(noOption.replacement, undefined);
  });

  test('一次都没命中的请求 → 进 replacement.rejected（**不静默忽略**）', async () => {
    const r = await analyzeWith([{ round: DRINK_ROUND, choice: '不存在的饮料' }]);
    assert.ok(r.replacement, '给了请求就该有报告');
    assert.equal(r.replacement!.requested.length, 1);
    assert.equal(r.replacement!.applied.length, 0, '一个都没生效');
    assert.equal(r.replacement!.rejected.length, 1);
    assert.equal(r.replacement!.rejected[0]!.reasons[0]!.kind, 'choice-not-allowed');
    assert.ok(r.replacement!.rejected[0]!.reasons[0]!.count > 0, '应给出受影响套餐数');
  });

  test('生效的请求**不进** rejected（命中过的套餐里没这轮次属正常，不刷屏）', async () => {
    const r = await analyzeWith([{ round: DRINK_ROUND, choice: SUGAR_FREE }]);
    assert.ok(r.replacement!.applied.length === 1);
    assert.ok(
      r.replacement!.applied[0]!.count > 1,
      '该轮次应在多个套餐中生效（本店套餐共用同一套轮次命名）',
    );
    assert.equal(r.replacement!.rejected.length, 0, '生效过就不该再报"未生效"');
  });
});

describe('--swap 参数解析 · **fail-closed**（复评 P2）', () => {
  test('格式错误一律记错，不静默吞掉、也不产生替换请求', () => {
    const bads: string[][] = [
      ['--swap', '错误格式'], // 缺 =
      ['--swap', '=值'], // 轮次为空
      ['--swap', '轮次='], // 选项为空
      ['--swap'], // 根本没给值
      ['--swap', '   =   '], // 两侧都是空白
    ];
    for (const argv of bads) {
      const o = parseArgs(argv);
      assert.ok(o.errors.length > 0, `「${argv.join(' ')}」应记为参数错误`);
      assert.equal(o.swaps.length, 0, `「${argv.join(' ')}」不得产生替换请求`);
    }
  });

  test('合法写法正常入列；重复参数交由语义层如实提示（解析阶段不拦）', () => {
    const o = parseArgs([
      '--swap',
      '选择套餐内饮料=无糖可口可乐中杯',
      '--swap',
      '小食#2=薄皮焦香V翅',
      '--budget',
      '35',
    ]);
    assert.equal(o.errors.length, 0);
    assert.deepEqual(o.swaps, [
      { round: '选择套餐内饮料', choice: '无糖可口可乐中杯' },
      { round: '小食#2', choice: '薄皮焦香V翅' },
    ]);
    assert.equal(o.budget, 35);
  });

  test('未给 --swap 时无错（既有调用不受影响）', () => {
    const o = parseArgs(['--offline', '--budget', '35']);
    assert.equal(o.errors.length, 0);
    assert.deepEqual(o.swaps, []);
  });
});

describe('替换请求 · 输出渲染', () => {
  test('生效时输出 ✔ 与生效处数；未生效时输出 ✗、原因归类与可用项', async () => {
    const hit = await analyzeWith([{ round: DRINK_ROUND, choice: SUGAR_FREE }]);
    const hitText = renderReplacement(hit.replacement!);
    assert.match(hitText, /【替换请求】/);
    assert.match(hitText, /✔/);
    assert.match(hitText, /生效/);

    const miss = await analyzeWith([{ round: DRINK_ROUND, choice: '不存在的饮料' }]);
    const missText = renderReplacement(miss.replacement!);
    assert.match(missText, /✗/);
    assert.match(missText, /允许范围/);
    assert.match(missText, /可用项/, '拒绝时必须回列可用项');
    assert.match(missText, new RegExp(SUGAR_FREE), '可用项清单里应真含合法选项');
  });
});
