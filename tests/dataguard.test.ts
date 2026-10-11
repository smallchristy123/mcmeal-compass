/**
 * 数据守卫测试：kJ/kcal 换算一致性（P1-3）+ 新鲜度 TTL（P1-4）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkEnergyConsistency, findEnergyAnomalies, KJ_PER_KCAL } from '../src/validate.ts';
import { freshnessOf, formatAge, anyStale, DEFAULT_TTL_MINUTES } from '../src/freshness.ts';
import { loadFixtures } from '../src/fixtures.ts';

describe('P1-3 · kJ/kcal 换算一致性', () => {
  test('换算基准是 1 kcal = 4.184 kJ', () => {
    assert.equal(KJ_PER_KCAL, 4.184);
  });

  test('相符 → consistent', () => {
    const c = checkEnergyConsistency({ energyKj: 418.4, energyKcal: 100 });
    assert.equal(c.status, 'consistent');
    assert.equal(c.expectedKcal, 100);
  });

  test('小数值取整（7 kJ vs 2 kcal）不算异常——绝对容差兜住', () => {
    const c = checkEnergyConsistency({ energyKj: 7, energyKcal: 2 });
    assert.equal(c.status, 'consistent');
    assert.ok(c.deviation! <= 1);
  });

  test('明显不符 → inconsistent，且说明里给出应有值', () => {
    const c = checkEnergyConsistency({ energyKj: 2000, energyKcal: 100 }); // 应约 478 kcal
    assert.equal(c.status, 'inconsistent');
    assert.ok(c.detail.includes('换算不符'));
    assert.ok(c.detail.includes('478.0'));
  });

  test('只有一侧 → unknown（无法交叉校验，但不判为错误）', () => {
    assert.equal(checkEnergyConsistency({ energyKj: 100, energyKcal: null }).status, 'unknown');
    assert.equal(checkEnergyConsistency({ energyKj: null, energyKcal: 24 }).status, 'unknown');
  });

  test('两侧皆缺 → missing', () => {
    assert.equal(checkEnergyConsistency({ energyKj: null, energyKcal: null }).status, 'missing');
  });

  test('真实快照 160 条：当前数据零异常（不是"没校验"，是"数据本身是一致的"）', async () => {
    const b = await loadFixtures();
    const bad = findEnergyAnomalies(b.nutritionRows);
    assert.deepEqual(bad, [], `真实数据不应有换算异常：${bad.map((x) => x.row.productName).join('、')}`);
    // 同时确认这 160 条**确实**有可校验的两侧数据（否则"零异常"毫无意义）
    const checkable = b.nutritionRows.filter((r) => r.energyKj !== null && r.energyKcal !== null);
    assert.equal(checkable.length, b.nutritionRows.length);
  });
});

describe('P1-4 · 数据新鲜度 TTL', () => {
  const now = new Date('2026-10-11T12:00:00Z');

  test('时效内 → fresh', () => {
    const f = freshnessOf('2026-10-11T11:30:00Z', 'menu', { now }); // 30 分钟前，菜单 TTL 60 分钟
    assert.equal(f.status, 'fresh');
    assert.equal(f.ageMinutes, 30);
  });

  test('超时效 → stale，且措辞明确否认「当前可售 / 实时价格」', () => {
    const f = freshnessOf('2026-10-10T20:08:56Z', 'menu', { now });
    assert.equal(f.status, 'stale');
    assert.ok(f.note.includes('历史样例'));
    assert.ok(f.note.includes('不代表当前可售'));
  });

  test('时间戳缺失或不可解析 → unknown（不假定新鲜）', () => {
    assert.equal(freshnessOf('', 'menu', { now }).status, 'unknown');
    assert.equal(freshnessOf('不是时间', 'menu', { now }).status, 'unknown');
    assert.ok(freshnessOf('', 'menu', { now }).note.includes('不假定其新鲜'));
  });

  test('价格 TTL 最严（10 分钟）——与下单闸门的报价时效一致', () => {
    assert.equal(DEFAULT_TTL_MINUTES.price, 10);
    const f = freshnessOf('2026-10-11T11:45:00Z', 'price', { now }); // 15 分钟前
    assert.equal(f.status, 'stale');
  });

  test('anyStale 能识别"混有非新鲜项"', () => {
    const fresh = freshnessOf('2026-10-11T11:59:00Z', 'menu', { now });
    const stale = freshnessOf('2026-10-10T20:00:00Z', 'price', { now });
    assert.equal(anyStale([fresh]), false);
    assert.equal(anyStale([fresh, stale]), true);
  });

  test('formatAge 写成人话', () => {
    assert.equal(formatAge(45), '45 分钟');
    assert.equal(formatAge(60), '1 小时');
    assert.equal(formatAge(90), '1 小时 30 分');
    assert.equal(formatAge(60 * 24 * 3), '3 天');
  });
});
