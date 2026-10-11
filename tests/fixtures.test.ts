/**
 * 夹具快照测试（P0-1 的守门人）
 *
 * 三件事：
 *   ① **完整性**：快照每个文件的 SHA-256 与 manifest 一致（被改即失败）；
 *   ② **统计一致**：manifest 里记的条数 = 实际解析出的条数；
 *   ③ **确定性**：同一快照连续加载两次，结果应完全一致（测试可复现的前提）。
 *
 * 若本文件失败：**不要**去改 manifest 迁就现状——
 * 那等于把"基线漂移"合法化。正确做法见 fixtures/README.md「如何换快照」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadFixtures, readManifest, DEFAULT_FIXTURE_DIR, DEFAULT_SNAPSHOT_ID, FIXTURES_ROOT } from '../src/fixtures.ts';
import { verifySnapshot, listSnapshots } from '../scripts/fixture-manifest.ts';

describe('fixtures · 快照不可变性（P0-1）', () => {
  test('默认快照存在且 id 符合 <用途>-<采集日>-<门店码> 形态', async () => {
    const snapshots = await listSnapshots();
    assert.ok(snapshots.includes(DEFAULT_SNAPSHOT_ID), `缺少默认快照 ${DEFAULT_SNAPSHOT_ID}`);
    assert.match(DEFAULT_SNAPSHOT_ID, /^[a-z]+-\d{8}-\d+$/);
    assert.ok(DEFAULT_FIXTURE_DIR.startsWith(FIXTURES_ROOT));
  });

  test('所有快照的 SHA-256 与统计均与 manifest 一致（篡改即失败）', async () => {
    const snapshots = await listSnapshots();
    assert.ok(snapshots.length > 0, 'fixtures/ 下应至少有一个快照');
    for (const id of snapshots) {
      const issues = await verifySnapshot(`${FIXTURES_ROOT}/${id}`);
      assert.deepEqual(
        issues,
        [],
        `快照 ${id} 与 manifest 不一致：${issues.map((i) => `${i.file}[${i.kind}] ${i.detail}`).join('; ')}`,
      );
    }
  });

  test('manifest 记录的条数与实际加载结果一致', async () => {
    const manifest = await readManifest();
    assert.ok(manifest, '快照必须带 manifest.json');

    const b = await loadFixtures();
    assert.equal(b.nutritionRows.length, manifest.counts.nutritionRows);
    assert.equal(b.menuItems.length, manifest.counts.menuItems);
    assert.equal(b.combos.size, manifest.counts.mealDetails);
    assert.equal(b.snapshotId, manifest.snapshotId);
    assert.equal(b.storeCode, manifest.provenance.storeCode);
  });

  test('同一快照连续加载两次，结果完全一致（确定性）', async () => {
    const a = await loadFixtures();
    const b = await loadFixtures();
    const digest = (x: Awaited<ReturnType<typeof loadFixtures>>) =>
      JSON.stringify({
        store: [x.storeCode, x.storeName, x.capturedAt],
        nut: x.nutritionRows.length,
        menu: x.menuItems.map((m) => [m.code, m.name, m.currentPrice]),
        combos: [...x.combos.keys()].sort(),
      });
    assert.equal(digest(a), digest(b));
  });

  test('快照内绝不含个人数据类型字段（T15 的补充面）', async () => {
    const b = await loadFixtures();
    // 菜单项只应暴露商品字段；一旦混入手机号/地址类字段，说明采集口径出了问题
    const serialized = JSON.stringify(b.menuItems);
    assert.ok(!/"phone(mobile)?"\s*:/i.test(serialized), '菜单项不应含 phone 字段');
    assert.ok(!/\b1[3-9]\d{9}\b/.test(serialized), '不应出现手机号');
  });
});
