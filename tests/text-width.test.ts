/**
 * 终端列对齐回归（2026-10-19，O12）
 *
 * 病灶：`--top` 明细表用 `padEnd(24)` 按 **UTF-16 码元**补齐，
 * 而中文在终端占 **2 列**（`'纯悦'.length === 2`，显示却是 4 列）。
 * 结果：同一列在不同行落到第 35~38 列，表格在任何 CJK 终端下都是歪的。
 *
 * 这不是审美问题——歪掉的表格会让人怀疑数字本身也不可靠。
 * 此处钉住三件事：
 *   ① 宽度函数按「东亚宽字符 = 2 列」计；
 *   ② 补齐 / 截断都按显示列，且**超宽不截断商品名**；
 *   ③ 真实离线输出里，明细表每一行的「价格/热量/蛋白/脂肪/碳水」五列起点完全一致。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { charWidth, clipDisplay, displayWidth, padDisplay } from '../src/text-width.ts';
import { runOfflineForTest } from '../src/cli.ts';

describe('text-width · 显示宽度', () => {
  test('ASCII 占 1 列，中文占 2 列', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('纯悦'), 4);
    assert.equal(displayWidth('100% 苹果汁'), 4 + 1 + 3 * 2);
  });

  test('混合串：逐码点累加（全角标点按宽字符计）', () => {
    const s = 'A 官方单品'; // A(1) + 空格(1) + 官方单品(4 字 × 2) = 10
    assert.equal(displayWidth(s), 10);
    assert.equal(charWidth('A'.codePointAt(0)!), 1);
    assert.equal(charWidth('官'.codePointAt(0)!), 2);
  });

  test('组合符 / 变体选择符占 0 列（emoji 后缀不改宽度）', () => {
    assert.equal(displayWidth('⚠️'), displayWidth('⚠'));
  });

  test('padDisplay 按显示列右补，已超宽则原样返回（不截断）', () => {
    assert.equal(displayWidth(padDisplay('纯悦', 24)), 24);
    assert.equal(displayWidth(padDisplay('锡兰红茶', 24)), 24);
    const tooLong = '一二三四五六七八九十一二三四';
    assert.equal(padDisplay(tooLong, 24), tooLong, '超宽不得被 padDisplay 改动');
  });

  test('clipDisplay 按显示列截断，且以省略号收尾', () => {
    const long = '全明星双人分享餐八件套（含四件小食与两杯饮料）';
    const clipped = clipDisplay(long, 22);
    assert.ok(displayWidth(clipped) <= 22, `截断后宽度 ${displayWidth(clipped)} 应 ≤ 22`);
    assert.ok(clipped.endsWith('…'));
    assert.equal(clipDisplay('纯悦', 22), '纯悦', '未超宽不得改动');
  });
});

describe('cli · 明细表列对齐（O12 回归）', () => {
  test('价格 / 热量 / 蛋白 / 脂肪 / 碳水 五列起点，逐行一致', async () => {
    const out = await runOfflineForTest({ top: 6 });
    const lines = out.split('\n');
    const start = lines.findIndex((l) => l.includes('【有官方营养依据的条目'));
    assert.ok(start >= 0, '离线输出应包含明细表标题');

    const header = lines[start + 1] ?? '';
    assert.ok(header.includes('名称') && header.includes('级别'), '表头应含「名称」「级别」');

    // 表头去掉尾部「级别」（4 列），数据行去掉尾部级别字母（1 列），
    // 两者「级别」之前的显示宽度必须相同
    const headPrefix = displayWidth(header.slice(0, header.length - 2));

    const rows = lines.slice(start + 2, start + 2 + 6).filter((l) => l.trim().length > 0);
    assert.ok(rows.length >= 3, `应至少有 3 行数据，实际 ${rows.length}`);

    for (const r of rows) {
      assert.equal(
        displayWidth(r.slice(0, r.length - 1)),
        headPrefix,
        `该行各列起点与表头不一致：${r.trim().slice(0, 30)}`,
      );
    }
  });
});
