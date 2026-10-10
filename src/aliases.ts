/**
 * 人工别名表（T1.4）
 *
 * 为什么需要它：菜单与营养表是两套命名体系。实测发现的主要差异类型：
 *   a) **份量后缀**：菜单写「麦辣鸡翅」，营养表写「麦辣鸡翅-2块」；
 *   b) **书写形式**：全半角括号、「·」等（这类已由 normalizeName 自动消化，无需列此处）；
 *   c) **口味/配方不同**：如「蓝莓爆爆珠麦旋风」与营养表的「奥利奥麦旋风」——
 *      **绝不映射**（不是同一个东西，映射了就是编数据）。
 *
 * 原则：
 *   1. 只收「确凿同一物」的映射；有一丝不确定的，宁可不收（留给「未匹配」）；
 *   2. 含**推断**成分的（如按行业默认份量），标 `risky: true`，
 *      匹配时把可信度上限压到 B，并在说明里写明推断依据——**让人看得见我们猜了什么**；
 *   3. 有**多重可能**的（如「薯条」可指中/大/小/迷你），**一律不收**——
 *      这属于计划的「份量歧义」风险，应由用户明确份量，而非我们替其决定。
 */

export interface AliasRule {
  /** 菜单里的写法（原文，构建时归一化） */
  alias: string;
  /** 营养表里的品名（必须与 list-nutrition-foods 返回的 productName 一致） */
  nutrition: string;
  /** 为何这样映射 / 有何风险（会写进匹配说明） */
  note: string;
  /** 是否含推断成分（份量默认、口径推定等）——true 则可信度上限压到 B */
  risky?: boolean;
}

export const DEFAULT_ALIASES: readonly AliasRule[] = [
  {
    alias: '麦辣鸡翅',
    nutrition: '麦辣鸡翅-2块',
    note: '菜单「麦辣鸡翅」未标块数，按麦当劳常规默认 2 块计',
    risky: true,
  },
  {
    alias: '麦乐鸡',
    nutrition: '麦乐鸡5块',
    note: '菜单「麦乐鸡」未标块数，按常规默认 5 块计',
    risky: true,
  },
  // ── 以下为「故意不收」的示例，留档说明，不作映射 ──
  // 「薯条」：营养表有 中薯条 / 大薯条 / 小薯条 / 迷你薯条 四种，份量歧义，不收。
  // 「麦旋风」类：营养表仅有 奥利奥 / 草莓 两种口味，菜单新口味（如蓝莓爆爆珠）不作映射。
  // 「龙焰鸡腿堡」等新品味：营养表未收录，不猜。
];

/** 反向索引：把别名表转成「归一化别名 → 规则」的映射 */
export function buildAliasIndex(
  rules: readonly AliasRule[],
  normalize: (s: string) => string,
): Map<string, AliasRule> {
  const m = new Map<string, AliasRule>();
  for (const r of rules) {
    const k = normalize(r.alias);
    if (k !== '') m.set(k, r);
  }
  return m;
}
