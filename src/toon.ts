/**
 * TOON 解析器（T1.1）
 *
 * 背景：麦当劳官方 MCP 的 `list-nutrition-foods` 返回的营养表，是 TOON 格式：
 *
 *   [160]{productName,nutritionDescription,energyKj,energyKcal,protein,...}:
 *     猪柳麦满分,null,1288,308,16,16,24,781,213
 *     猪柳蛋麦满分,null,1618,387,23,21,25,846,243
 *
 * 三个实测踩过的坑（见 docs/API_PROBE_NOTES.md 第三节）：
 *   1. 每一行的首字段带 2 个前导空格 —— 必须 trim，否则 productName 被污染；
 *   2. `null` 是字面量字符串，与数字 0 语义完全不同 —— 缺失绝不能变成 0；
 *   3. 不能假定「按逗号 split」——字段可能带引号（内含逗号/换行）或转义。
 *
 * 设计立场：宁可报错，不可静默填数。行数/列数对不上时默认抛错，
 * 只有显式传入 { strict: false } 才降级为「收集警告、继续解析」。
 */

/** TOON 单元格的原始值：字符串，或字面量 null（缺失） */
export type ToonCell = string | null;

/** 一行数据：列名 → 单元格值 */
export type ToonRow = Record<string, ToonCell>;

export interface ToonTable {
  /** 表头声明的行数，如 `[160]` 中的 160 */
  declaredRowCount: number;
  /** 实际解析出的数据行数 */
  actualRowCount: number;
  /** 列名，按表头声明顺序 */
  columns: string[];
  /** 解析后的数据行 */
  rows: ToonRow[];
  /** 非致命问题（仅在 lenient 模式下可能非空） */
  warnings: string[];
}

export type ToonErrorCode =
  | 'EMPTY_INPUT'
  | 'MISSING_HEADER'
  | 'BAD_HEADER'
  | 'NO_COLUMNS'
  | 'ROW_COUNT_MISMATCH'
  | 'COLUMN_COUNT_MISMATCH'
  | 'UNTERMINATED_QUOTE'
  /** 业务层失败（`success=false` 或 `code >= 400`）——**错误响应绝不当作数据**（评审 R8） */
  | 'BUSINESS_FAILURE';

export class ToonParseError extends Error {
  readonly code: ToonErrorCode;
  /** 出错时的行号（从 1 计，指数据行；表头错误为 0） */
  readonly line: number;

  constructor(code: ToonErrorCode, message: string, line = 0) {
    super(`[${code}] ${message}`);
    this.name = 'ToonParseError';
    this.code = code;
    this.line = line;
  }
}

export interface ParseToonOptions {
  /**
   * 严格模式（默认 true）：
   *  - 声明行数与实际行数不符 → 抛 ROW_COUNT_MISMATCH
   *  - 某行列数与表头不符 → 抛 COLUMN_COUNT_MISMATCH
   *  - 引号未闭合 → 抛 UNTERMINATED_QUOTE
   * 传 false 可降级为「记入 warnings 并继续」（生产环境容错用）。
   */
  strict?: boolean;
}

/** 表头：`[12]{a,b,c}:`，允许 `}` 与 `:` 之间的空白 */
const HEADER_RE = /^\[(\d+)\]\{([^}]*)\}\s*:\s*$/;

interface RawField {
  value: string;
  quoted: boolean;
}

/**
 * 按 TOON/CSV 规则切分一行，尊重双引号：
 *  - `"a,b"` → 单个字段 `a,b`
 *  - `"say ""hi"""` → `say "hi"`（双引号转义）
 */
function splitFields(line: string): { fields: RawField[]; unterminated: boolean } {
  const fields: RawField[] = [];
  let cur = '';
  let quoted = false;
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++; // 吞掉第二个引号
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === ',') {
      fields.push({ value: cur, quoted });
      cur = '';
      quoted = false;
    } else if (ch === '"') {
      inQuotes = true;
      quoted = true;
    } else {
      cur += ch;
    }
  }
  fields.push({ value: cur, quoted });
  return { fields, unterminated: inQuotes };
}

/**
 * 把原始字段规整为单元格值：
 *  - trim 掉 TOON 的行首缩进与两侧空白；
 *  - 未加引号、且 trim 后恰为 `null` → 视为缺失（null）；
 *  - 显式写成 `"null"`（带引号）→ 视为字面字符串 "null"，保留；
 *  - 其余一律保留为 string（包括 `"0"`、空串）。
 */
function toCell(raw: RawField): ToonCell {
  const v = raw.value.trim();
  if (!raw.quoted && v === 'null') return null;
  return v;
}

/**
 * 解析一段 TOON 表格文本。
 *
 * @throws {ToonParseError} 严格模式下遇到结构性问题
 */
export function parseToon(text: string, options: ParseToonOptions = {}): ToonTable {
  const strict = options.strict ?? true;
  const warnings: string[] = [];

  if (typeof text !== 'string' || text.trim() === '') {
    throw new ToonParseError('EMPTY_INPUT', '输入为空，无法解析 TOON');
  }

  // 统一换行符，并按行切分（丢弃末尾空行）
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') {
    lines.pop();
  }

  const headerLine = (lines[0] as string).trim();
  const m = HEADER_RE.exec(headerLine);
  if (!m) {
    throw new ToonParseError(
      'MISSING_HEADER',
      `首行不是合法的 TOON 表头（形如 [N]{col1,col2}:），实际为：${headerLine.slice(0, 80)}`,
    );
  }

  const declaredRowCount = Number.parseInt(m[1] as string, 10);
  const columns = (m[2] as string)
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  if (columns.length === 0) {
    throw new ToonParseError('NO_COLUMNS', '表头未声明任何列名（{} 为空）');
  }
  const dupes = columns.filter((c, i) => columns.indexOf(c) !== i);
  if (dupes.length > 0) {
    warnings.push(`表头存在重复列名：${[...new Set(dupes)].join(', ')}`);
  }

  const rows: ToonRow[] = [];
  const dataLines = lines.slice(1);

  for (let i = 0; i < dataLines.length; i++) {
    const raw = dataLines[i] as string;
    if (raw.trim() === '') continue; // 容忍空行

    const lineNo = i + 1;
    const { fields, unterminated } = splitFields(raw);

    if (unterminated) {
      const msg = `第 ${lineNo} 行存在未闭合的引号`;
      if (strict) throw new ToonParseError('UNTERMINATED_QUOTE', msg, lineNo);
      warnings.push(msg);
    }

    if (fields.length !== columns.length) {
      const msg = `第 ${lineNo} 行列数为 ${fields.length}，与表头声明 ${columns.length} 列不符`;
      if (strict) throw new ToonParseError('COLUMN_COUNT_MISMATCH', msg, lineNo);
      warnings.push(msg);
    }

    const row: ToonRow = {};
    for (let c = 0; c < columns.length; c++) {
      const key = columns[c] as string;
      const cell = fields[c];
      row[key] = cell ? toCell(cell) : null;
    }
    rows.push(row);
  }

  if (rows.length !== declaredRowCount) {
    const msg = `表头声明 ${declaredRowCount} 行，实际解析出 ${rows.length} 行`;
    if (strict) throw new ToonParseError('ROW_COUNT_MISMATCH', msg);
    warnings.push(msg);
  }

  return {
    declaredRowCount,
    actualRowCount: rows.length,
    columns,
    rows,
    warnings,
  };
}

/**
 * 从 MCP 工具的返回包里取原始 JSON 字符串。
 *
 * MCP 的 `content[0].text` 是「文档说明 + 原始 JSON」的混合文本，
 * 原始 JSON 位于 `## Original Response` 之后（实测口径）。
 * 若找不到该锚点，则退化为「取最后一段以 {"success" 开头的 JSON」。
 */
export function extractOriginalResponse(toolText: string): unknown {
  if (typeof toolText !== 'string' || toolText.trim() === '') {
    throw new ToonParseError('EMPTY_INPUT', 'MCP 返回文本为空');
  }

  const anchor = '## Original Response';
  let jsonStart = toolText.indexOf(anchor);
  if (jsonStart >= 0) {
    jsonStart = toolText.indexOf('{', jsonStart + anchor.length);
  }
  if (jsonStart < 0) {
    jsonStart = toolText.lastIndexOf('{"success"');
  }
  if (jsonStart < 0) {
    // 兜底：取第一个 '{'
    jsonStart = toolText.indexOf('{');
  }
  if (jsonStart < 0) {
    throw new ToonParseError('MISSING_HEADER', '未在 MCP 返回文本中找到 JSON 起始位置');
  }

  // 从起点做括号配对扫描，截出第一个完整的 JSON 对象
  const jsonEnd = findJsonObjectEnd(toolText, jsonStart);
  const slice = toolText.slice(jsonStart, jsonEnd);
  return JSON.parse(slice);
}

/** 自 from（'{'）起做括号配对（尊重字符串与转义），返回对象结束后的下标 */
function findJsonObjectEnd(text: string, from: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i] as string;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * 【推荐入口】从 MCP 工具返回文本里取出**业务数据**（即 `data` 字段）。
 *
 * 为什么要有这个函数：MCP 返回是三层结构——
 *   工具文本（含文档说明）→ 外层 JSON `{success, code, message, datetime, traceId, data}`
 *   → 业务对象 `data`。
 * 直接给 `toMealDetail` / `toPriceResult` 传外层包，会因为 `code: 200` 是数字而报
 * 「expected string」这种莫名其妙的错（实测踩过）。故统一在此拆包，避免各处重复犯错。
 *
 * @returns 外层 JSON 的 `data` 字段；若无 `data` 则返回外层对象本身。
 */
export function unwrapMcpData(toolText: string): unknown {
  return unwrapMcpEnvelope(toolText).data;
}

/**
 * **带业务校验**的拆包（评审 R8）。
 *
 * v2 只检查「有没有价格字段」，于是 `{"success":false,"code":500,"data":{"price":0}}`
 * 这种**显式失败**也被解析成了「官方已核实 ¥0」。
 * 现在：`success === false` 或 `code >= 400` ⇒ 抛错，绝不流进业务层。
 *
 * @throws {ToonParseError} 业务失败（code = BUSINESS_FAILURE）
 */
export function unwrapMcpEnvelope(toolText: string): { envelope: unknown; data: unknown } {
  const envelope = extractOriginalResponse(toolText) as Record<string, unknown> | null;
  if (envelope && typeof envelope === 'object') {
    const success = envelope['success'];
    const code = envelope['code'];
    const message = envelope['message'];
    const failed =
      success === false || (typeof code === 'number' && Number.isFinite(code) && code >= 400);
    if (failed) {
      throw new ToonParseError(
        'BUSINESS_FAILURE',
        `官方返回业务失败（success=${String(success)}，code=${String(code)}）：${String(message ?? '无说明')}`,
      );
    }
    if ('data' in envelope) return { envelope, data: envelope['data'] };
  }
  return { envelope, data: envelope };
}
