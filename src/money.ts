/**
 * 金额契约（T1.2）
 *
 * 实测结论（docs/API_PROBE_NOTES.md 第六节）：
 *   calculate-price 返回的一切金额，单位都是「分」——
 *   `price: 3800` 即 ¥38.00。而 query-meals 里的 currentPrice 却是「元」的字符串
 *   （如 "38"）。两种口径混用，是 100 倍差错的温床。
 *
 * 因此本项目内部**只用一个表示法**：整数「分」（Cents）。
 *  - 整数分是精确的，不会像浮点那样出现 0.1+0.2 的问题；
 *  - 展示时才 ÷100 转成元。
 *
 * 任何从外部进入的金额，都必须先过这里的 From* 函数显式声明口径，
 * 不允许直接赋值——把「单位」这件事从「靠记忆」变成「靠类型」。
 */

/** 金额：整数「分」。品牌类型，防止误用普通 number。 */
export type Cents = number & { readonly __brand: 'Cents' };

/** 把「分」的整数装箱为 Cents（内部已校验为整数） */
export function cents(value: number): Cents {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(`金额（分）必须是有限整数，实际收到：${value}`);
  }
  return value as Cents;
}

/** 从 MCP 的「分」原始值构造（calculate-price 全部字段） */
export function centsFromApi(value: unknown): Cents | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n) as Cents;
}

/**
 * 从「元」的字符串/数字构造（query-meals 的 currentPrice，如 "38"、"38.5"）。
 * 用整数化处理，避免 "0.1" 这类小数带来的浮点误差。
 */
export function centsFromYuan(value: unknown): Cents | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.+-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) as Cents;
}

/** 分 → 元（数值，保留两位小数） */
export function toYuan(value: Cents): number {
  return Math.round(value) / 100;
}

/** 分 → 展示字符串，如 `¥38.00` */
export function formatCents(value: Cents, symbol = '¥'): string {
  return `${symbol}${toYuan(value).toFixed(2)}`;
}

/** 解析带符号的差价字符串，如 `"+ ¥1.5"`、`"- ¥0.5"`、`"+ ¥0"` → 分 */
export function parseDiffPriceToCents(text: unknown): Cents | null {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  if (s === '') return null;
  const sign = s.startsWith('-') ? -1 : 1;
  const numMatch = s.match(/\d+(?:\.\d+)?/);
  if (!numMatch) return null;
  const yuan = Number(numMatch[0]);
  if (!Number.isFinite(yuan)) return null;
  return Math.round(sign * yuan * 100) as Cents;
}
