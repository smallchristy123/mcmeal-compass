/**
 * 营养匹配单元测试（T1.4）
 *
 * 立意的核心：**宁可返回「未知」，也不猜**。
 * 故测试里除了「该命中要命中」，同样重要的是「该不命中就不命中」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseToon, extractOriginalResponse, unwrapMcpData } from '../src/toon.ts';
import { toNutritionRows, toMenuItems, QueryMealsDataSchema, type NutritionRow } from '../src/schema.ts';
import {
  NutritionMatcher,
  normalizeName,
  assignConfidence,
  isNutritionComplete,
  summarize,
} from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** 造一条营养数据的小工具 */
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

describe('normalizeName · 归一化', () => {
  test('全角括号与半角括号归一（实测：纯牛奶(盒装) ↔ 纯牛奶（盒装））', () => {
    assert.equal(normalizeName('纯牛奶(盒装)'), normalizeName('纯牛奶（盒装）'));
  });
  test('去空白与各类连接号', () => {
    assert.equal(normalizeName('麦辣鸡翅-2块'), normalizeName('麦辣鸡翅 2块'));
    assert.equal(normalizeName('麦辣鸡翅-2块'), '麦辣鸡翅2块');
  });
  test('去商标符号', () => {
    assert.equal(normalizeName('麦咖啡™'), normalizeName('麦咖啡'));
  });
  test('保留语义词：不删「套餐」「三件套」', () => {
    assert.notEqual(normalizeName('麦辣鸡腿汉堡'), normalizeName('麦辣鸡腿汉堡三件套'));
  });
});

describe('assignConfidence · 可信度分层', () => {
  test('无营养数据 → D', () => {
    assert.equal(assignConfidence(null, true), 'D');
  });
  test('关键字段全缺 → D', () => {
    const bad = nut('x', { energyKcal: null, protein: null, fat: null, carbohydrate: null });
    assert.equal(assignConfidence(bad, true), 'D');
  });
  test('关键字段部分缺失 → C（只展示已知部分）', () => {
    assert.equal(assignConfidence(nut('x', { protein: null }), true), 'C');
  });
  test('齐全 + 有组成 → A', () => {
    assert.equal(assignConfidence(nut('x'), true), 'A');
  });
  test('齐全 + 无组成 → B', () => {
    assert.equal(assignConfidence(nut('x'), false), 'B');
  });
  test('isNutritionComplete 对 null 与 0 的判定', () => {
    assert.equal(isNutritionComplete(nut('x', { protein: 0 })), true); // 0 是有效值
    assert.equal(isNutritionComplete(nut('x', { protein: null })), false);
  });
});

describe('NutritionMatcher · 四级优先级', () => {
  const rows = [nut('巨无霸'), nut('麦辣鸡翅-2块'), nut('中薯条')];

  test('优先级 1：代码映射胜过一切', () => {
    const m = new NutritionMatcher(rows, { codeMapping: { C1: '巨无霸' } });
    const r = m.match({ code: 'C1', name: '某个完全不相干的名字' });
    assert.equal(r.method, 'code-mapping');
    assert.equal(r.nutritionName, '巨无霸');
  });

  test('优先级 2：精确名称（归一化后相同）', () => {
    const m = new NutritionMatcher(rows);
    const r = m.match({ code: 'C2', name: '巨无霸' });
    assert.equal(r.method, 'exact-name');
    assert.equal(r.nutritionName, '巨无霸');
  });

  test('优先级 3：别名命中', () => {
    const m = new NutritionMatcher(rows, { aliases: DEFAULT_ALIASES });
    const r = m.match({ code: 'C3', name: '麦辣鸡翅' });
    assert.equal(r.method, 'alias');
    assert.equal(r.nutritionName, '麦辣鸡翅-2块');
  });

  test('优先级 4：不猜——不相干的名字判为未匹配', () => {
    const m = new NutritionMatcher(rows);
    const r = m.match({ code: 'C4', name: '完全不存在的东西' });
    assert.equal(r.method, 'unmatched');
    assert.equal(r.nutrition, null);
    assert.equal(r.confidence, 'D');
  });

  test('代码映射指向不存在的品名时，降级继续匹配并记录说明', () => {
    const m = new NutritionMatcher(rows, { codeMapping: { C5: '早已下架的堡' } });
    const r = m.match({ code: 'C5', name: '巨无霸' });
    assert.equal(r.method, 'exact-name'); // 降级到精确名称
    assert.ok(r.notes.some((n) => n.includes('未找到该品名')));
  });

  test('risky 别名：可信度上限压到 B，并写明推断依据', () => {
    const m = new NutritionMatcher(rows, { aliases: DEFAULT_ALIASES });
    const r = m.match({ code: 'C6', name: '麦辣鸡翅' }, true); // 有组成本可给 A
    assert.equal(r.confidence, 'B');
    assert.ok(r.notes.some((n) => n.includes('份量')));
  });

  test('套餐名不会被误配到同名单品（关键防错）', () => {
    const m = new NutritionMatcher(rows);
    const r = m.match({ code: 'C7', name: '麦辣鸡翅-2块套餐' });
    assert.equal(r.method, 'unmatched');
  });

  test('「薯条」有份量歧义，故不设别名 → 未匹配（不替用户猜份量）', () => {
    const m = new NutritionMatcher([nut('中薯条'), nut('大薯条'), nut('小薯条')], {
      aliases: DEFAULT_ALIASES,
    });
    const r = m.match({ code: 'C8', name: '薯条' });
    assert.equal(r.method, 'unmatched');
  });

  test('重名冲突可被查出', () => {
    const m = new NutritionMatcher([nut('同 名'), nut('同名'), nut('其他')]);
    const c = m.getConflicts();
    assert.equal(c.length, 1);
    assert.equal(c[0]!.names.length, 2);
  });
});

describe('summarize · 统计', () => {
  test('命中率与分层计数', () => {
    const m = new NutritionMatcher([nut('甲'), nut('乙')]);
    const { stats } = m.matchAll([
      { code: '1', name: '甲' },
      { code: '2', name: '乙' },
      { code: '3', name: '丙' },
      { code: '4', name: '丁' },
    ]);
    assert.equal(stats.total, 4);
    assert.equal(stats.byMethod['exact-name'], 2);
    assert.equal(stats.byMethod.unmatched, 2);
    assert.equal(stats.coverage, 0.5);
  });

  test('空输入不崩，命中率为 0', () => {
    assert.equal(summarize([]).coverage, 0);
  });
});

describe('真实数据回归（docs/probe 留档）', () => {
  test('整体 23 命中（21 精确 + 2 别名），别名恰好是麦辣鸡翅与麦乐鸡', async () => {
    const nutEnv = extractOriginalResponse(
      (
        JSON.parse(
          await readFile(join(here, '..', 'docs', 'probe', 'list-nutrition-foods.raw.json'), 'utf-8'),
        ) as { result: { content: { text: string }[] } }
      ).result.content[0]!.text,
    ) as { data: string };
    const { rows } = toNutritionRows(parseToon(nutEnv.data));

    const menuData = unwrapMcpData(
      await readFile(join(here, '..', 'docs', 'probe', 'query-meals.raw.txt'), 'utf-8'),
    );
    const { items } = toMenuItems(QueryMealsDataSchema.parse(menuData));

    const m = new NutritionMatcher(rows, { aliases: DEFAULT_ALIASES });
    const { results, stats } = m.matchAll(items);

    assert.equal(stats.total, 128);
    assert.equal(stats.byMethod['exact-name'], 21);
    assert.equal(stats.byMethod.alias, 2);
    assert.equal(stats.byMethod.unmatched, 105);

    const aliasNames = results
      .filter((r) => r.method === 'alias')
      .map((r) => r.menuName)
      .sort();
    assert.deepEqual(aliasNames, ['麦乐鸡', '麦辣鸡翅']);
  });

  test('零误配：所有命中项与菜单项归一化后一致（别名校验除外）', async () => {
    const nutEnv = extractOriginalResponse(
      (
        JSON.parse(
          await readFile(join(here, '..', 'docs', 'probe', 'list-nutrition-foods.raw.json'), 'utf-8'),
        ) as { result: { content: { text: string }[] } }
      ).result.content[0]!.text,
    ) as { data: string };
    const { rows } = toNutritionRows(parseToon(nutEnv.data));
    const menuData = unwrapMcpData(
      await readFile(join(here, '..', 'docs', 'probe', 'query-meals.raw.txt'), 'utf-8'),
    );
    const { items } = toMenuItems(QueryMealsDataSchema.parse(menuData));
    const m = new NutritionMatcher(rows, { aliases: DEFAULT_ALIASES });

    for (const r of m.matchAll(items).results) {
      if (r.method === 'exact-name') {
        assert.equal(normalizeName(r.menuName), normalizeName(r.nutritionName!));
      }
      if (r.method !== 'unmatched') {
        assert.notEqual(r.nutrition, null, `${r.menuName} 命中但无营养数据`);
      }
    }
  });
});
