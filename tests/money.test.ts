/** 金额契约单元测试（T1.2 配套）——核心是「分/元」两种口径的转换必须零差错 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cents,
  centsFromApi,
  centsFromYuan,
  toYuan,
  formatCents,
  parseDiffPriceToCents,
} from '../src/money.ts';

describe('cents · 装箱校验', () => {
  test('接受整数', () => {
    assert.equal(cents(3800), 3800);
  });
  test('拒绝小数（分必须是整数）', () => {
    assert.throws(() => cents(38.5), TypeError);
  });
  test('拒绝 NaN / Infinity', () => {
    assert.throws(() => cents(Number.NaN), TypeError);
    assert.throws(() => cents(Number.POSITIVE_INFINITY), TypeError);
  });
});

describe('centsFromApi · calculate-price 的「分」口径', () => {
  test('3800 → 3800 分（即 ¥38.00）', () => {
    assert.equal(centsFromApi(3800), 3800);
  });
  test('0 是有效值，不等于缺失', () => {
    assert.equal(centsFromApi(0), 0);
    assert.notEqual(centsFromApi(0), null);
  });
  test('null / undefined → null（缺失）', () => {
    assert.equal(centsFromApi(null), null);
    assert.equal(centsFromApi(undefined), null);
  });
  test('小数被四舍五入到整数分', () => {
    assert.equal(centsFromApi(3799.6), 3800);
  });
});

describe('centsFromYuan · query-meals 的「元」口径', () => {
  test('字符串 "38" → 3800 分', () => {
    assert.equal(centsFromYuan('38'), 3800);
  });
  test('字符串 "38.5" → 3850 分（无浮点误差）', () => {
    assert.equal(centsFromYuan('38.5'), 3850);
  });
  test('"49.90" → 4990 分', () => {
    assert.equal(centsFromYuan('49.90'), 4990);
  });
  test('数字入参同样支持', () => {
    assert.equal(centsFromYuan(38.5), 3850);
  });
  test('空串 / null → null', () => {
    assert.equal(centsFromYuan(''), null);
    assert.equal(centsFromYuan(null), null);
  });
  test('带货币符号也能解析', () => {
    assert.equal(centsFromYuan('¥38.00'), 3800);
  });
  test('两种口径一致：元 38 == 分 3800', () => {
    assert.equal(centsFromYuan('38'), centsFromApi(3800));
  });
});

describe('展示转换', () => {
  test('toYuan：3800 分 → 38 元', () => {
    assert.equal(toYuan(cents(3800)), 38);
  });
  test('formatCents：3800 → ¥38.00', () => {
    assert.equal(formatCents(cents(3800)), '¥38.00');
  });
  test('formatCents：5 → ¥0.05', () => {
    assert.equal(formatCents(cents(5)), '¥0.05');
  });
});

describe('parseDiffPriceToCents · 套餐差价字符串', () => {
  test('"+ ¥1.5" → +150 分', () => {
    assert.equal(parseDiffPriceToCents('+ ¥1.5'), 150);
  });
  test('"- ¥0.5" → -50 分', () => {
    assert.equal(parseDiffPriceToCents('- ¥0.5'), -50);
  });
  test('"+ ¥0" → 0 分（不是缺失）', () => {
    assert.equal(parseDiffPriceToCents('+ ¥0'), 0);
  });
  test('"+ ¥2" → 200 分', () => {
    assert.equal(parseDiffPriceToCents('+ ¥2'), 200);
  });
  test('null → null', () => {
    assert.equal(parseDiffPriceToCents(null), null);
  });
});
