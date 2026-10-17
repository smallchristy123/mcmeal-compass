/**
 * v3.7.4 反例探针（对应复评 O10：`isDefault=undefined` 时两处判据相反）
 *
 * 设计约束：**只依赖 v3.7.3 与 v3.7.4 共有的导出**（`roundListOf` / `adjustedMenuPriceOf` /
 * `analyzeMenu` 等），故同一份脚本可在两棵树上各跑一次，做严格可比的前后对照。
 * （`defaultStateOf`、`adjustedMenuPriceFailureOf` 是 v3.7.4 新增，探针**不引用**。）
 *
 * 用法：`node scripts/v374-edge-probe.ts > out.json`
 */

import { loadFixtures, fixtureDetailLoader } from '../src/fixtures.ts';
import { NutritionMatcher } from '../src/matching.ts';
import { DEFAULT_ALIASES } from '../src/aliases.ts';
import { analyzeMenu, type AnalyzedItem } from '../src/analyze.ts';
import { adjustedMenuPriceOf, roundListOf } from '../src/pricing.ts';

const TARGET_CODE = '9900004236';
const DRINK_ROUND = '选择套餐内饮料';
const COLA_LARGE = '可乐大杯';

const analyzeWith = async (specs: { round: string; choice: string }[]): Promise<AnalyzedItem> => {
  const b = await loadFixtures();
  const matcher = new NutritionMatcher(b.nutritionRows, { aliases: DEFAULT_ALIASES });
  const { items } = await analyzeMenu(b.menuItems, matcher, fixtureDetailLoader(b), {
    ...(specs.length === 0 ? {} : { substitutions: specs }),
  });
  const it = items.find((i) => i.code === TARGET_CODE);
  if (!it) throw new Error(`夹具里应有 ${TARGET_CODE}`);
  return it;
};

const setAll = (it: AnalyzedItem, v: boolean | undefined): AnalyzedItem => ({
  ...it,
  components: (it.components ?? []).map((c) => ({ ...c, isDefault: v })),
});

/** 只把首个组件抹成 `undefined`，其余保持官方布尔（混态） */
const firstUnknown = (it: AnalyzedItem): AnalyzedItem => ({
  ...it,
  components: (it.components ?? []).map((c, i) => (i === 0 ? { ...c, isDefault: undefined } : c)),
});

const probe = (it: AnalyzedItem) => {
  const rl = roundListOf(it);
  const adj = adjustedMenuPriceOf(it);
  return {
    /** 请求侧：官方组成是否会被送出去 */
    roundListLength: rl.length,
    roundListRounds: rl.map((r) => r.round),
    /** 价格侧：是否给出推算值 */
    adjusted: adj === null ? null : {
      cents: adj.cents,
      adjustment: adj.adjustment,
      compositionChanged: adj.compositionChanged,
      basis: adj.basis,
    },
    /**
     * 一句话判据：两侧是否自相矛盾。
     * 「不送组成」+「却说组成变了并按此算钱」= 矛盾（复评 O10 观察到的正是这一条）。
     */
    sideFactsConsistent: !(rl.length === 0 && adj !== null && adj.compositionChanged === true),
  };
};

const base = await analyzeWith([{ round: DRINK_ROUND, choice: COLA_LARGE }]);

const cases: Record<string, { desc: string; output: ReturnType<typeof probe> }> = {
  'A · 全部 isDefault=undefined（含替换项）': {
    desc: '整份组成的默认态未知：请求不带组成，价格也不该按替换算',
    output: probe(setAll(base, undefined)),
  },
  'B · 混态（首个 undefined，其余官方布尔，含 1 个明确替换）': {
    desc: '存在明确替换 ⇒ 组成照送；但价格含未知项 ⇒ 整份拒算',
    output: probe(firstUnknown(base)),
  },
  'C · 全部 isDefault=true（对照，不得矫枉过正）': {
    desc: '全部明确默认 ⇒ 不送组成、按菜单价、compositionChanged=false',
    output: probe(setAll(base, true)),
  },
  'D · 官方布尔原样（明确 +¥2 替换）': {
    desc: '正常 CLI 路径：送组成、按替换价推算',
    output: probe(base),
  },
};

console.log(JSON.stringify({
  probe: 'v374-edge-probe',
  target: TARGET_CODE,
  note: '只依赖 v3.7.3/v3.7.4 共有导出，可跨版本对跑',
  cases,
}, null, 2));
