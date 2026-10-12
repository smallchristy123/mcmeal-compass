/**
 * v3.3 回归 —— 来源：《McMeal Compass v3.2 高要求复评报告》（2026-10-12 16:05）
 *
 * 复评点名三处必须修：
 *   ① 真实 CLI 的详情加载器**吞掉原始错误**（超时/HTTP/解析一律变 null ⇒ 上层只能记 EMPTY_DETAIL）；
 *   ② 混合轮次「选择主食/小食」把**小食误判为主件** ⇒ 整单降 D、营养数字被清空；
 *   ③ 公共分析 API 在 `source.channel=live` 但**无真实收据**时，合成 `ok:true` 的「成功」回执。
 *
 * 本文件把三条固化为回归，并覆盖详情加载器的缓存语义与三类失败。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { type MenuItem, type NutritionRow, type MealDetail } from '../src/schema.ts';
import { NutritionMatcher } from '../src/matching.ts';
import {
  analyzeSingle,
  analyzeCombo,
  analyzeMenu,
  isStapleComponent,
  type DataSourceReceipt,
} from '../src/analyze.ts';
import { createDetailLoader, type DetailLoaderClient } from '../src/detail-loader.ts';
import { McpError } from '../src/mcp-client.ts';

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

const choice = (code: string, name: string, isDefault = false) => ({
  code,
  name,
  quantity: 1,
  maxQuantity: -1,
  isDefault,
  diffPrice: 0 as never,
  supportModify: false,
  composition: [] as never[],
});

// ───────────────────────── ① 详情加载器：不吞错 + 两态缓存 ─────────────────────────

describe('复评① 详情加载器不得吞掉原始错误', () => {
  const mkClient = (
    impl: (code: string) => Promise<MealDetail>,
    counter = { n: 0 },
  ): DetailLoaderClient => ({
    getMealDetail: (p) => {
      counter.n++;
      return impl(p.code);
    },
  });

  test('超时：保留 TIMEOUT 错误码与原始消息', async () => {
    const loader = createDetailLoader(
      mkClient(async () => {
        throw new McpError('TIMEOUT', '请求超时（20000ms）');
      }),
      '3450024',
    );
    await assert.rejects(
      () => loader('C1'),
      (e: unknown) => {
        assert.ok(e instanceof McpError);
        assert.equal((e as McpError).code, 'TIMEOUT');
        assert.match((e as McpError).message, /超时/);
        return true;
      },
    );
  });

  test('HTTP/服务端错误：保留 SERVER_ERROR 与 status', async () => {
    const loader = createDetailLoader(
      mkClient(async () => {
        throw new McpError('SERVER_ERROR', 'HTTP 502 Bad Gateway', { status: 502 });
      }),
      '3450024',
    );
    await assert.rejects(
      () => loader('C1'),
      (e: unknown) => {
        assert.equal((e as McpError).code, 'SERVER_ERROR');
        assert.equal((e as McpError).status, 502);
        return true;
      },
    );
  });

  test('解析错误：非 McpError 也包成 BAD_RESPONSE 并保留原文', async () => {
    const loader = createDetailLoader(
      mkClient(async () => {
        throw new Error('Unexpected token < in JSON at position 0');
      }),
      '3450024',
    );
    await assert.rejects(
      () => loader('C1'),
      (e: unknown) => {
        assert.equal((e as McpError).code, 'BAD_RESPONSE');
        assert.match((e as McpError).message, /Unexpected token/);
        return true;
      },
    );
  });

  test('缓存命中：同一 code 不重复请求，且重放同一次错误', async () => {
    const counter = { n: 0 };
    const loader = createDetailLoader(
      mkClient(async () => {
        throw new McpError('TIMEOUT', '超时');
      }, counter),
      '3450024',
    );
    let first: unknown;
    let second: unknown;
    await loader('C1').catch((e: unknown) => {
      first = e;
    });
    await loader('C1').catch((e: unknown) => {
      second = e;
    });
    assert.equal(counter.n, 1, '第二次应命中失败缓存，不再发请求');
    assert.equal(first, second, '应重放同一次错误（不重新请求）');
  });

  test('成功与「真实空结果」都被如实返回（空结果由上层判 EMPTY_DETAIL）', async () => {
    const okDetail: MealDetail = {
      code: 'C1',
      name: '甲套餐',
      rounds: [
        { id: 1, name: '主餐', quantity: 1, minQuantity: 1, maxQuantity: 1, choices: [choice('A', '汉堡甲', true)] },
      ],
    };
    const loader = createDetailLoader(
      mkClient(async (c) => (c === 'C1' ? okDetail : { code: 'C2', name: '空套餐', rounds: [] })),
      '3450024',
    );
    assert.equal((await loader('C1'))?.name, '甲套餐');
    assert.equal((await loader('C2'))?.rounds.length, 0, '空结果应返回（不是抛错）');
  });
});

// ───────────────────────── ② 混合轮次的主件识别 ─────────────────────────

describe('复评② 混合轮次「选择主食/小食」不得把小食当主件', () => {
  test('规则本身：小食非主件；主食/汉堡仍是主件', () => {
    assert.equal(isStapleComponent('选择主食/小食', '中薯条'), false, '薯条不是主件');
    assert.equal(isStapleComponent('选择主食/小食', '麦乐鸡4块'), false, '麦乐鸡不是主件');
    assert.equal(isStapleComponent('选择主食/小食', '神秘小食X'), false, '未收录的小食也不是主件');
    assert.equal(isStapleComponent('选择主食/小食', '巨无霸'), true, '巨无霸是主件');
    assert.equal(isStapleComponent('小食', '中薯条'), false);
    assert.equal(isStapleComponent('选择汉堡', '麦辣鸡腿堡'), true);
    assert.equal(isStapleComponent('玩具', '按摩捶痒痒挠'), false, '非食品不算主件');
  });

  test('组合层面：缺「小食」→ 保持部分结果，不整单降 D', () => {
    const matcher = new NutritionMatcher([nut('可乐中杯')]);
    const detail: MealDetail = {
      code: 'C9',
      name: '混合轮次套餐',
      rounds: [
        // 未匹配项出现在「选择主食/小食」这一混合轮次里 —— 修前会被 roundName 的「主食」误判为主件
        { id: 1, name: '选择主食/小食', quantity: 1, minQuantity: 1, maxQuantity: 1, choices: [choice('S', '神秘小食X', true)] },
        { id: 2, name: '饮料', quantity: 1, minQuantity: 1, maxQuantity: 1, choices: [choice('D', '可乐中杯', true)] },
      ],
    };
    const a = analyzeCombo(item('C9', '混合轮次套餐'), detail, matcher);
    assert.notEqual(a.confidence, 'D', '缺的是小食，不应整单降 D');
    assert.equal(a.totals.energyKcal.value, 240, '可乐的热量应保留（部分结果）');
    assert.ok(
      !a.notes.some((n) => n.includes('主件未收录')),
      '不得把缺小食误报为「主件未收录」',
    );
  });

  test('组合层面：缺「主件（汉堡）」→ 仍降 D 并清空数字', () => {
    const matcher = new NutritionMatcher([nut('可乐中杯')]);
    const detail: MealDetail = {
      code: 'C10',
      name: '缺汉堡套餐',
      rounds: [
        { id: 1, name: '选择主食/小食', quantity: 1, minQuantity: 1, maxQuantity: 1, choices: [choice('H', '神秘汉堡', true)] },
        { id: 2, name: '饮料', quantity: 1, minQuantity: 1, maxQuantity: 1, choices: [choice('D', '可乐中杯', true)] },
      ],
    };
    const a = analyzeCombo(item('C10', '缺汉堡套餐'), detail, matcher);
    assert.equal(a.confidence, 'D', '缺主件应降 D');
    assert.equal(a.totals.energyKcal.value, null, '缺主件不得给营养数字');
    assert.ok(a.notes.some((n) => n.includes('主件未收录')));
  });
});

// ───────────────────────── ③ 公共 API 不得合成 live 成功 ─────────────────────────

describe('复评③ 无真实收据时不得合成 live 成功', () => {
  const matcher = new NutritionMatcher([nut('巨无霸')]);
  const LIVE_SRC = { channel: 'live' as const, at: '2026-10-12T08:00:00+08:00' };

  test('analyzeSingle：仅给 source=live、无 receipts → ok=false 且 LIVE_RECEIPT_MISSING', () => {
    const a = analyzeSingle(item('1', '巨无霸'), matcher, undefined, LIVE_SRC);
    const t = a.sourceTrace ?? [];
    assert.ok(t.length > 0, '应留下轨迹并如实标注，而不是省略');
    for (const r of t) {
      assert.equal(r.ok, false, '不得把未发生的调用写成成功');
      assert.equal(r.errorCode, 'LIVE_RECEIPT_MISSING');
    }
  });

  test('analyzeSingle：提供真实收据 → 原样采用（不再合成）', () => {
    const real: DataSourceReceipt[] = [
      {
        tool: 'query-meals',
        channel: 'live',
        ok: true,
        at: '2026-10-12T08:00:00+08:00',
        argsSummary: 'storeCode=<已脱敏>',
        stage: 'menu',
        requestId: 'live#query-meals',
      },
    ];
    const a = analyzeSingle(item('1', '巨无霸'), matcher, undefined, LIVE_SRC, real);
    assert.deepEqual(a.sourceTrace, real, '真实收据应原样透传');
  });

  test('analyzeMenu：live 上下文但无真实收据 → 轨迹中不含任何 ok:true', async () => {
    const r = await analyzeMenu([item('1', '巨无霸')], matcher, async () => null, { source: LIVE_SRC });
    const t = r.items[0]!.sourceTrace ?? [];
    assert.ok(t.length > 0);
    assert.ok(
      t.every((x) => x.ok === false),
      '公共 API 不得报告一次没有发生过的成功调用',
    );
  });
});
