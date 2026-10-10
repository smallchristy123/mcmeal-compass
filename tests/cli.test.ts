/**
 * 竖切冒烟测试
 *
 * 确保「离线夹具 → 分析 → 可读输出」这条链路不会悄悄坏掉。
 *
 * 注：本沙箱禁止派生进程（spawn 报 EBUSY），故不走子进程，
 * 改为**进程内调用 CLI 的导出函数**——这也是把 CLI 核心抽成纯函数的原因之一。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';
import { runOfflineForTest } from '../src/cli.ts';

describe('离线夹具加载', () => {
  test('营养表 / 菜单 / 套餐详情都能读到', async () => {
    const b = await loadFixtures();
    assert.equal(b.nutritionRows.length, 160);
    assert.ok(b.menuItems.length >= 100);
    assert.ok(b.combos.size > 0, '套餐详情应有留档');
    assert.ok(b.storeName.length > 0 && !b.storeName.includes('未知'), `门店名未取到：${b.storeName}`);
    assert.ok(b.capturedAt.length > 0);
  });

  test('夹具详情加载器：有留档的返回详情，没有的返回 null', async () => {
    const b = await loadFixtures();
    const load = fixtureDetailLoader(b);
    const someCode = [...b.combos.keys()][0]!;
    assert.notEqual(await load(someCode), null);
    assert.equal(await load('绝对不存在的编码'), null);
  });
});

describe('CLI 竖切（离线）', () => {
  test('文本输出包含门店、可信度分布与诚实性说明', async () => {
    const out = await runOfflineForTest({ top: 10 });
    assert.ok(out.includes('麦麦营养管家'), '缺标题');
    assert.ok(out.includes('麦当劳重庆嘉年华餐厅'), '缺门店名');
    assert.ok(out.includes('离线夹具'), '缺数据来源说明');
    assert.ok(out.includes('营养可信度分布'), '缺可信度分布');
    assert.ok(out.includes('B 可追溯组合'), '缺分层标签');
    assert.ok(out.includes('绝不填 0'), '缺诚实性说明');
  });

  test('诚实性：不完整合计带 ≥ 标记，并解释其含义', async () => {
    const out = await runOfflineForTest({ top: 60 });
    assert.ok(out.includes('≥'), '存在部分已知条目时应标 ≥');
    assert.ok(out.includes('已知部分'), '应说明 ≥ 的含义');
  });

  test('JSON 输出可被解析，结构完整且自洽', async () => {
    const out = await runOfflineForTest({ json: true });
    const d = JSON.parse(out) as {
      store: { code: string; name: string };
      mode: string;
      summary: { total: number; combos: number; singles: number; usable: number; byConfidence: Record<string, number> };
      items: { code: string; name: string; confidence: string }[];
    };
    assert.ok(d.store.name.length > 0);
    assert.ok(d.summary.total > 0);
    assert.equal(d.summary.total, d.items.length);
    assert.equal(d.summary.combos + d.summary.singles, d.summary.total);
    assert.equal(
      d.summary.usable,
      d.summary.total - (d.summary.byConfidence['D'] ?? 0),
    );
    assert.ok(d.items.every((i) => ['A', 'B', 'C', 'D'].includes(i.confidence)));
  });

  test('⭐ D 级条目一律没有营养数字（不会填 0 冒充）', async () => {
    const out = await runOfflineForTest({ json: true });
    const d = JSON.parse(out) as {
      items: { name: string; confidence: string; totals: Record<string, { value: number | null }> }[];
    };
    const dItems = d.items.filter((i) => i.confidence === 'D');
    assert.ok(dItems.length > 0, '样例中应有 D 级条目');
    for (const it of dItems) {
      assert.equal(it.totals['energyKcal']!.value, null, `${it.name} 是 D 级却给出了热量数字`);
    }
  });

  test('套餐走展开：B 级套餐有营养数字，且证据里标明是「组成求和」', async () => {
    const out = await runOfflineForTest({ json: true });
    const d = JSON.parse(out) as {
      items: {
        name: string;
        kind: string;
        confidence: string;
        evidence: { kind: string; label: string }[];
        totals: Record<string, { value: number | null }>;
      }[];
    };
    const combos = d.items.filter((i) => i.kind === 'combo');
    assert.ok(combos.length > 0, '应有套餐被展开');
    const solidCombo = combos.find((c) => c.confidence === 'B');
    assert.ok(solidCombo, '应存在完整可信（B）的套餐');
    assert.ok((solidCombo!.totals['energyKcal']!.value ?? 0) > 0);
    assert.equal(solidCombo!.evidence[0]!.kind, 'official-combo-sum');
    assert.ok(solidCombo!.evidence.some((e) => e.kind === 'official-single'));
  });
});
