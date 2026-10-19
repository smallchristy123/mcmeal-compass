/**
 * 终端显示宽度 —— 用于**按显示列**补齐文本，而不是按 UTF-16 码元。
 *
 * 为什么需要它：`'纯悦'.length === 2`，但在终端里它占 **4 列**（东亚宽字符占 2 列）。
 * 直接用 `padEnd(n)` 补齐，含中文的表格在任何 CJK 终端下都会列不齐——
 * 实测同一列会落在第 35~38 列（2026-10-19，O12）。
 */

/** 东亚宽字符 / 全角符号 / 常见 emoji 的区间（覆盖本仓库会出现的字符） */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** 组合字符 / 变体选择符：占 0 列 */
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff
  );
}

/** 单个码点占几列 */
export function charWidth(cp: number): number {
  if (isZeroWidth(cp)) return 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

/** 字符串在终端中的显示宽度（列数） */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/**
 * 按**显示列**右补空格到 `width` 列。
 * 已经超宽时**原样返回**——宁可这一行略长，也不截断商品名（截断会让两个不同餐品长得一样）。
 */
export function padDisplay(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** 按显示列左补空格（用于数字右对齐） */
export function padStartDisplay(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

/**
 * 按显示列截断到 `width` 列（超出时留 1 列放省略号）。
 * 未超宽则原样返回。
 */
export function clipDisplay(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}
