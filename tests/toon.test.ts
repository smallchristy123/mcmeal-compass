/**
 * TOON 解析器单元测试（T1.1）
 *
 * 重点覆盖 docs/API_PROBE_NOTES.md 记录的三处实测坑：
 *   ① 行首 2 个前导空格必须 trim；
 *   ② `null` 与 `0` 语义不同，缺失绝不能被当成 0；
 *   ③ 不能假定「按逗号 split」——须尊重引号与转义。
 * 另覆盖行数/列数不符、空输入、坏表头等结构性错误。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseToon,
  extractOriginalResponse,
  ToonParseError,
  type ToonParseError as _T,
} from '../src/toon.ts';

describe('parseToon · 基本结构', () => {
  test('解析表头声明的行数与列名', () => {
    const t = parseToon('[2]{name,energyKcal}:\n  猪柳麦满分,308\n  巨无霸,513');
    assert.equal(t.declaredRowCount, 2);
    assert.equal(t.actualRowCount, 2);
    assert.deepEqual(t.columns, ['name', 'energyKcal']);
    assert.equal(t.rows.length, 2);
  });

  test('列序与表头声明一致（不按字母序重排）', () => {
    const t = parseToon('[1]{zeta,alpha,mid}:\n  1,2,3');
    assert.deepEqual(t.columns, ['zeta', 'alpha', 'mid']);
    const row = t.rows[0]!;
    assert.equal(row['zeta'], '1');
    assert.equal(row['alpha'], '2');
    assert.equal(row['mid'], '3');
  });

  test('表头的 `}` 与 `:` 之间允许空白', () => {
    const t = parseToon('[1]{a,b} :\n  1,2');
    assert.deepEqual(t.columns, ['a', 'b']);
  });

  test('容忍行尾空行与 CRLF 换行', () => {
    const t = parseToon('[1]{a,b}:\r\n  1,2\r\n\r\n');
    assert.equal(t.actualRowCount, 1);
  });
});

describe('parseToon · 坑① 行首前导空格', () => {
  test('首字段的两前导空格被 trim，不含空格', () => {
    const t = parseToon('[1]{productName,energyKcal}:\n  猪柳麦满分,308');
    const name = t.rows[0]!['productName'];
    assert.equal(name, '猪柳麦满分');
    assert.equal((name as string).startsWith(' '), false);
  });

  test('多行均 trim，且不做内部空格裁剪', () => {
    const t = parseToon('[2]{name}:\n  麦辣鸡翅-2块\n  原味 板烧鸡腿堡');
    assert.equal(t.rows[0]!['name'], '麦辣鸡翅-2块');
    assert.equal(t.rows[1]!['name'], '原味 板烧鸡腿堡'); // 中间空格保留
  });
});

describe('parseToon · 坑② null 与 0 语义不同', () => {
  test('字面量 null → 解析为 null（缺失）', () => {
    const t = parseToon('[1]{name,nutritionDescription,protein}:\n  猪柳麦满分,null,16');
    const row = t.rows[0]!;
    assert.equal(row['nutritionDescription'], null);
    assert.notEqual(row['nutritionDescription'], 'null');
    assert.notEqual(row['nutritionDescription'], 0);
  });

  test('数值 0 → 保留为字符串 "0"，不得变成 null', () => {
    const t = parseToon('[1]{name,protein}:\n  可乐中杯,0');
    const row = t.rows[0]!;
    assert.equal(row['protein'], '0');
    assert.notEqual(row['protein'], null);
  });

  test('显式引号 "null" → 视为字面字符串，不当作缺失', () => {
    const t = parseToon('[1]{name,note}:\n  测试,"null"');
    assert.equal(t.rows[0]!['note'], 'null');
  });

  test('实测样例：157/160 为空的那种表，缺失不被填 0', () => {
    const t = parseToon(
      '[3]{productName,nutritionDescription,energyKcal}:\n' +
        '  猪柳麦满分,null,308\n' +
        '  猪柳蛋麦满分,null,387\n' +
        '  巨无霸,null,513',
    );
    const missing = t.rows.filter((r) => r['nutritionDescription'] === null);
    assert.equal(missing.length, 3);
    // 反向断言：没有任何一行把缺失写成了 0
    assert.equal(t.rows.some((r) => r['nutritionDescription'] === '0'), false);
  });
});

describe('parseToon · 坑③ 引号与转义', () => {
  test('引号包裹的字段可含逗号', () => {
    const t = parseToon('[1]{name,desc}:\n  套餐,"薯条,可乐"');
    assert.equal(t.rows[0]!['desc'], '薯条,可乐');
    assert.equal(t.columns.length, 2);
  });

  test('双引号转义（"" → "）', () => {
    const t = parseToon('[1]{name,quote}:\n  x,"say ""hi"""');
    assert.equal(t.rows[0]!['quote'], 'say "hi"');
  });

  test('引号内的前导空格保留（判定为有意为之的字符串）', () => {
    const t = parseToon('[1]{a,b}:\n  x,"  padded  "');
    assert.equal(t.rows[0]!['b'], 'padded'); // 外侧引号剥离后仍 trim
  });

  test('未闭合引号：严格模式抛错，宽松模式记警告', () => {
    const bad = '[1]{a,b}:\n  x,"未闭合';
    assert.throws(
      () => parseToon(bad),
      (e: unknown) => e instanceof ToonParseError && e.code === 'UNTERMINATED_QUOTE',
    );
    const t = parseToon(bad, { strict: false });
    assert.equal(t.warnings.some((w) => w.includes('未闭合')), true);
  });
});

describe('parseToon · 结构性错误（严格模式）', () => {
  test('空输入抛 EMPTY_INPUT', () => {
    assert.throws(
      () => parseToon('   '),
      (e: unknown) => e instanceof ToonParseError && e.code === 'EMPTY_INPUT',
    );
  });

  test('坏表头抛 MISSING_HEADER', () => {
    assert.throws(
      () => parseToon('name,age\n  a,1'),
      (e: unknown) => e instanceof ToonParseError && e.code === 'MISSING_HEADER',
    );
  });

  test('空列名抛 NO_COLUMNS', () => {
    assert.throws(
      () => parseToon('[1]{}:\n  1'),
      (e: unknown) => e instanceof ToonParseError && e.code === 'NO_COLUMNS',
    );
  });

  test('行数不符抛 ROW_COUNT_MISMATCH', () => {
    assert.throws(
      () => parseToon('[5]{a}:\n  1\n  2'),
      (e: unknown) => e instanceof ToonParseError && e.code === 'ROW_COUNT_MISMATCH',
    );
  });

  test('列数不符抛 COLUMN_COUNT_MISMATCH', () => {
    assert.throws(
      () => parseToon('[1]{a,b,c}:\n  1,2'),
      (e: unknown) => e instanceof ToonParseError && e.code === 'COLUMN_COUNT_MISMATCH',
    );
  });

  test('宽松模式：行数/列数不符不抛错，转为警告', () => {
    const t = parseToon('[5]{a,b}:\n  1,2\n  3', { strict: false });
    assert.equal(t.actualRowCount, 2);
    assert.equal(t.warnings.length >= 2, true);
    assert.equal(t.rows[1]!['b'], null); // 缺的那格是 null，不是 0
  });

  test('错误对象带 code 与 line 字段', () => {
    try {
      parseToon('[1]{a,b}:\n  1');
      assert.fail('应当抛错');
    } catch (e) {
      assert.ok(e instanceof ToonParseError);
      assert.equal((e as ToonParseError).code, 'COLUMN_COUNT_MISMATCH');
      assert.equal((e as ToonParseError).line, 1);
    }
  });
});

describe('extractOriginalResponse · 从 MCP 返回包取 JSON', () => {
  test('从 ## Original Response 锚点后取原始 JSON', () => {
    const toolText =
      '# API Response Information\n\n## Response Structure\n\n- **code**: 错误码\n\n' +
      '## Original Response\n\n{"success":true,"code":200,"data":"[1]{a}:\\n  x"}';
    const obj = extractOriginalResponse(toolText) as Record<string, unknown>;
    assert.equal(obj['success'], true);
    assert.equal(obj['code'], 200);
    assert.equal(obj['data'], '[1]{a}:\n  x');
  });

  test('无锚点时，回退取最后的 {"success" 段', () => {
    const toolText = '一些说明文字\n{"success":false,"code":401,"message":"未授权"}';
    const obj = extractOriginalResponse(toolText) as Record<string, unknown>;
    assert.equal(obj['success'], false);
    assert.equal(obj['code'], 401);
  });

  test('JSON 内含嵌套对象与字符串花括号也能正确截断', () => {
    const toolText =
      '## Original Response\n\n{"success":true,"data":{"nested":{"k":"a}b{"}}}';
    const obj = extractOriginalResponse(toolText) as Record<string, unknown>;
    assert.deepEqual(obj['data'], { nested: { k: 'a}b{' } });
  });

  test('真实探针文件可被解析（fixtures 快照 · list-nutrition-foods.raw.json）', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const { FIXTURE_DIR_PARTS } = await import('../src/fixtures.ts');
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(
      join(here, '..', ...FIXTURE_DIR_PARTS, 'list-nutrition-foods.raw.json'),
      'utf-8',
    );
    const envelope = JSON.parse(raw) as {
      result: { content: { text: string }[] };
    };
    const toolText = envelope.result.content[0]!.text;

    const obj = extractOriginalResponse(toolText) as { data: string };
    const table = parseToon(obj.data);

    assert.equal(table.declaredRowCount, 160);
    assert.equal(table.actualRowCount, 160);
    assert.deepEqual(table.columns, [
      'productName',
      'nutritionDescription',
      'energyKj',
      'energyKcal',
      'protein',
      'fat',
      'carbohydrate',
      'sodium',
      'calcium',
    ]);
    // 首行首字段无前导空格
    assert.equal(table.rows[0]!['productName'], '猪柳麦满分');
    // 该表 nutritionDescription 绝大多数为 null
    const nullCount = table.rows.filter((r) => r['nutritionDescription'] === null).length;
    assert.equal(nullCount, 157);
    // 且没有任何一行把缺失填成 0
    assert.equal(table.rows.some((r) => r['nutritionDescription'] === '0'), false);
  });
});
