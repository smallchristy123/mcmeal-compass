/**
 * v3.4 回归 —— 来源：《McMeal Compass v3.3 高要求复评与 35 条逐行二次确认》（2026-10-12 20:54）
 *
 * 复评点出三处「收口」事项，本轮固化为回归：
 *   ① **时间戳时区语义**：官方 `datetime` 不带时区，此前一律按 +08:00 解读，
 *      与「本地时刻用 UTC 墙钟」叠加造成 **8 小时歧义**（样例被算成约 480 分钟前）；
 *      现改为：有本地观测时刻则**推断**服务端时区，无则如实记为「假定」。
 *   ② **分层标签**：D 级里「套餐名疑似、详情不可用 ⇒ 降级直配」不得记成「新品未收录」。
 *   ③ **第 12 行的别名口径**：包装写法别名须写明证据来源与**适用边界**。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseCapturedAt, freshnessOf, localIsoNow } from '../src/freshness.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { classify } from '../scripts/review-samples.ts';

describe('v3.4 ① 时间戳时区语义（复评第 1 条）', () => {
  const observedAt = '2026-10-12T16:09:20+08:00';

  test('无时区 + 给本地观测时刻 → 推断（服务端为 UTC 时能识别出来）', () => {
    const p = parseCapturedAt('2026-10-12 08:09:12', { observedAt });
    assert.equal(p.timezoneBasis, 'inferred');
    assert.equal(p.timezone, 'Z', '08:09 而本地 16:09 ⇒ 应推断为 UTC');
    assert.equal(p.timezoneAssumed, false);
    // 与观测时刻仅差约 8 分钟，而非 8 小时
    assert.ok(Math.abs(p.observedDeltaMinutes ?? 999) <= 10, `差值应≈8 分钟，实为 ${p.observedDeltaMinutes}`);
  });

  test('无时区 + 给本地观测时刻 → 服务端本就是本地时区时也识别得出', () => {
    const p = parseCapturedAt('2026-10-12 16:09:12', { observedAt });
    assert.equal(p.timezoneBasis, 'inferred');
    assert.equal(p.timezone, '+08:00');
    assert.ok(Math.abs(p.observedDeltaMinutes ?? 999) <= 10);
  });

  test('无时区 + 无观测时刻 → 退回「假定 +08:00」并如实标注（向后兼容）', () => {
    const p = parseCapturedAt('2026-10-10 20:08:57');
    assert.equal(p.timezoneBasis, 'assumed');
    assert.equal(p.timezoneAssumed, true);
  });

  test('带时区 → explicit，照用不改', () => {
    const p = parseCapturedAt('2026-10-12T08:09:12Z');
    assert.equal(p.timezoneBasis, 'explicit');
    assert.equal(p.timezone, '+00:00');
  });

  test('新鲜度：不再把「刚取到的数据」算成 8 小时前', () => {
    const now = new Date('2026-10-12T16:15:00+08:00');
    const f = freshnessOf('2026-10-12 08:09:12', 'menu', { now, observedAt });
    assert.equal(f.status, 'fresh', `菜单 TTL 60 分钟，实际龄应为 6 分钟左右；得到 ${f.ageMinutes}`);
    assert.ok((f.ageMinutes ?? 999) <= 10, `ageMinutes 应≈6，实为 ${f.ageMinutes}`);
    assert.equal(f.timezoneBasis, 'inferred');
  });

  test('本地观测时刻工具：带偏移，且可被 Date.parse 解析', () => {
    const iso = localIsoNow(new Date('2026-10-12T16:09:12+08:00'));
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, `得到 ${iso}`);
    assert.ok(Number.isFinite(Date.parse(iso)), '应可解析（带明确偏移，不再是裸墙钟）');
  });
});

describe('v3.4 ② D 级的分层标签（复评第 2 条）', () => {
  const dItem = (name: string) => ({
    name,
    confidence: 'D',
    evidence: [] as { kind: string; label: string }[],
  });

  test('套餐名疑似但详情不可用 → 归「详情不可用」，不是「新品未收录」', () => {
    assert.equal(classify(dItem('大堡口福三件套'), 'unmatched'), 'detail-unavailable');
    assert.equal(classify(dItem('开心亲子双人餐'), 'unmatched'), 'detail-unavailable');
  });

  test('非套餐的 D 级（真的没收录）→ 仍归「新品未收录」', () => {
    assert.equal(classify(dItem('牛肉堡单品精选'), 'unmatched'), 'new-item');
    assert.equal(classify(dItem('“我就喜欢”鸡薯双全盒'), 'unmatched'), 'new-item');
  });

  test('非食品周边优先归「非食品」，不受 D 级新分支影响', () => {
    assert.equal(classify(dItem('“葱不求人“按摩捶痒痒挠'), 'unmatched'), 'non-food');
  });
});

describe('v3.4 ③ 第 12 行的别名口径（复评第 2 条）', () => {
  test('「100% 苹果汁(盒装)」别名规则存在，且标注为 risky（推断成分）', () => {
    const rule = DEFAULT_ALIASES.find((a) => a.alias === '100% 苹果汁(盒装)');
    assert.ok(rule, '别名表应含该规则');
    assert.equal(rule!.nutrition, '100%苹果汁');
    assert.equal(rule!.risky, true, '属推断，须带风险标注');
    assert.ok((rule!.note ?? '').length > 0, 'note 须写明口径');
  });

  test('别名表不含与「苹果汁」并列的其它规格（适用边界的前提）', () => {
    const apple = DEFAULT_ALIASES.filter((a) => /苹果汁/.test(a.alias) || /苹果汁/.test(a.nutrition));
    assert.equal(apple.length, 1, `快照内苹果汁应仅此一条别名规则，实为 ${apple.length} 条`);
  });
});
