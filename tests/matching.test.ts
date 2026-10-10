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
    assert.equal(r.risky, true); // 结构化暴露，供上层判断（勿靠翻 notes 字符串）
  });

  test('非 risky 命中：risky 为 false', () => {
    const m = new NutritionMatcher(rows);
    assert.equal(m.match({ code: 'C9', name: '巨无霸' }).risky, false);
    assert.equal(m.match({ code: 'D9', name: '不存在' }).risky, false);
  });

  test('套餐名不会被误配到同名单品（关键防错）', () => {
    const m = new NutritionMatcher(rows);
    const r = m.match({ code: 'C7', name: '麦辣鸡翅-2块套餐' });
    assert.equal(r.method, 'unmatched');
  });

  test('「薯条」有份量歧义 → 返回候选请用户明确，而非猜一个', () => {
    const m = new NutritionMatcher([nut('中薯条'), nut('大薯条'), nut('小薯条')], {
      aliases: DEFAULT_ALIASES,
    });
    const r = m.match({ code: 'C8', name: '薯条' });
    assert.equal(r.method, 'size-ambiguous');
    assert.equal(r.nutrition, null, '歧义时不得给营养数字');
    assert.equal(r.confidence, 'D');
    assert.deepEqual(r.sizeCandidates?.map((c) => c.size), ['小', '中', '大']);
    assert.ok(r.notes.some((n) => n.includes('需明确份量')));
  });

  test('显式指定份量 variant → 命中（计划书 §5.3.3 的 variant 维度）', () => {
    const m = new NutritionMatcher([nut('中薯条'), nut('大薯条'), nut('小薯条')]);
    const r = m.match({ code: 'V1', name: '薯条', variant: '大' });
    assert.equal(r.method, 'variant');
    assert.equal(r.nutritionName, '大薯条');
  });

  test('variant 也支持后置量词写法（可乐 + 中杯 → 可乐中杯）', () => {
    const m = new NutritionMatcher([nut('可乐中杯'), nut('可乐大杯')]);
    const r = m.match({ code: 'V2', name: '可乐', variant: '中杯' });
    assert.equal(r.method, 'variant');
    assert.equal(r.nutritionName, '可乐中杯');
  });

  test('仅一种份量时不算歧义（仍走未匹配，由别名表决定是否映射）', () => {
    const m = new NutritionMatcher([nut('麦辣鸡翅-2块')]);
    assert.equal(m.getSizeCandidates('麦辣鸡翅').length, 0);
    assert.equal(m.match({ code: 'X', name: '麦辣鸡翅' }).method, 'unmatched');
  });

  test('可关闭份量歧义识别（detectSizeFamilies: false）', () => {
    const m = new NutritionMatcher([nut('中薯条'), nut('大薯条')], { detectSizeFamilies: false });
    assert.equal(m.match({ code: 'Y', name: '薯条' }).method, 'unmatched');
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
  /** 载入留档（营养表 + 菜单） */
  const load = async () => {
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
    return { rows, items };
  };

  test('真实菜单的命中构成：21 精确 + 4 别名 + 9 份量歧义', async () => {
    const { rows, items } = await load();
    const m = new NutritionMatcher(rows, { aliases: DEFAULT_ALIASES });
    const { results, stats } = m.matchAll(items);

    // ⚠️ 菜单是动态数据（实测同一门店 128 → 130），故只对**稳定部分**做精确断言。
    assert.equal(stats.byMethod['exact-name'], 21);
    assert.equal(stats.byMethod.alias, 4);
    assert.equal(stats.byMethod['code-mapping'], 0);
    assert.equal(stats.byMethod.variant, 0);

    const aliasNames = new Set(results.filter((r) => r.method === 'alias').map((r) => r.menuName));
    assert.deepEqual(
      [...aliasNames].sort((a, b) => a.localeCompare(b, 'zh')),
      ['100% 苹果汁(盒装)', '麦乐鸡', '麦辣鸡翅', '那么大鸡排（椒盐风味）'].sort((a, b) =>
        a.localeCompare(b, 'zh'),
      ),
    );

    // 份量歧义：这些不是「不知道」，而是「需用户补一个输入」
    assert.equal(stats.byMethod['size-ambiguous'], 9);
    const amb = new Set(results.filter((r) => r.method === 'size-ambiguous').map((r) => r.menuName));
    for (const expect of ['薯条', '可乐', '雪碧', '卡布奇诺', '玉米杯', '怡泉+C']) {
      assert.ok(amb.has(expect), `「${expect}」应被识别为份量歧义`);
    }

    // 未命中 = 总数 - 21 - 4 - 9
    assert.equal(stats.byMethod.unmatched, stats.total - 21 - 4 - 9);
    assert.ok(stats.total >= 100);
  });

  test('零误配：精确命中项归一化后一致；给出营养的必有营养数据', async () => {
    const { rows, items } = await load();
    const m = new NutritionMatcher(rows, { aliases: DEFAULT_ALIASES });

    for (const r of m.matchAll(items).results) {
      if (r.method === 'exact-name') {
        assert.equal(normalizeName(r.menuName), normalizeName(r.nutritionName!));
      }
      // 份量歧义与未命中都不给营养；其余必须给
      if (r.method !== 'unmatched' && r.method !== 'size-ambiguous') {
        assert.notEqual(r.nutrition, null, `${r.menuName} 命中但无营养数据`);
      }
      if (r.method === 'size-ambiguous') {
        assert.equal(r.nutrition, null, `${r.menuName} 份量歧义却给了营养`);
        assert.ok((r.sizeCandidates?.length ?? 0) >= 2, '歧义必须给出 ≥2 个候选');
      }
    }
  });
});
