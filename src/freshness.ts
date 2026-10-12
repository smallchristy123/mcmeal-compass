/**
 * 数据新鲜度（外部评审 P1-4 的处置）
 *
 * 问题：夹具里有 `capturedAt`，但**没有任何时效规则**——离线演示会以「当前可售 / 实时价格」
 * 的口吻输出十几小时前的数据，这是过度承诺。
 *
 * 处置：为四类数据各定一个 TTL，展示层据此**明确标注**：
 *   · `fresh`   —— 在时效内，可按"当前"表述；
 *   · `stale`   —— 已过期，**只能作历史样例**，不得称"当前可售/实时价格"；
 *   · `unknown` —— 时间戳缺失或不可解析，一律按"不可信时效"处理（不假设它新鲜）。
 *
 * TTL 是**产品口径**，不是官方承诺：官方未公布刷新频率，这里取保守值，
 * 目的是"宁可说过期，不假装新鲜"。
 */

export type DataKind = 'menu' | 'nutrition' | 'combo-detail' | 'price';

/** 各数据的保守时效（分钟） */
export const DEFAULT_TTL_MINUTES: Record<DataKind, number> = {
  // 菜单/供应的变化最快（下架、售罄、时段菜单）
  menu: 60,
  // 营养表变动慢（配方调整才变）
  nutrition: 24 * 60,
  // 套餐组成（替换规则、赠品）属菜单结构，跟菜单同档
  'combo-detail': 60,
  // 价格最敏感：优惠与费用随时间变，与下单闸门「报价 10 分钟内有效」保持一致
  price: 10,
};

export type FreshnessStatus = 'fresh' | 'stale' | 'unknown';

/** 官方 `datetime` 不带时区（形如 `2026-10-10 20:08:57`）——按东八区解读，并如实标注 */
export const ASSUMED_TIMEZONE = '+08:00';
/** 时间戳落在未来的容忍度（分钟）：超过即判为「不可信时效」 */
export const FUTURE_TOLERANCE_MINUTES = 5;

export interface ParsedCapturedAt {
  /** 可解析时为毫秒；不可解析为 null */
  ms: number | null;
  /** 是否**替它假定**了时区（原文未带时区时） */
  timezoneAssumed: boolean;
  /** 规范化后的字符串（补了时区与 T 分隔符） */
  normalized: string;
}

/**
 * 解析数据产生时刻（P1-4 的边界处理）：
 *   · 原文带时区（`Z` / `+08:00`）→ 照用；
 *   · 不带（官方 `datetime` 就是如此）→ 按 **+08:00** 解读，并标记 `timezoneAssumed`；
 *   · **未来时间**不视为"更新鲜"，而是判为不可信（见 `freshnessOf`）。
 */
export function parseCapturedAt(capturedAt: string): ParsedCapturedAt {
  const t = (capturedAt ?? '').trim();
  if (t === '') return { ms: null, timezoneAssumed: false, normalized: '' };
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(t);
  const normalized = hasTz ? t.replace(' ', 'T') : `${t.replace(' ', 'T')}${ASSUMED_TIMEZONE}`;
  const ms = Date.parse(normalized);
  return {
    ms: Number.isFinite(ms) ? ms : null,
    timezoneAssumed: !hasTz,
    normalized,
  };
}

export interface Freshness {
  kind: DataKind;
  status: FreshnessStatus;
  /** 数据产生时刻（原样回显，便于核对） */
  capturedAt: string;
  /** 距今分钟数；时间戳不可解析时为 null */
  ageMinutes: number | null;
  ttlMinutes: number;
  /** 可直接展示给用户的一句话 */
  note: string;
  /** 原文未带时区、由本工具按 +08:00 解读 */
  timezoneAssumed?: boolean;
  /** 规范化后的时间串（含时区），便于复核 */
  rawParsedAs?: string;
}

export function freshnessOf(
  capturedAt: string,
  kind: DataKind,
  options: { now?: Date; ttlMinutes?: number } = {},
): Freshness {
  const now = options.now ?? new Date();
  const ttlMinutes = options.ttlMinutes ?? DEFAULT_TTL_MINUTES[kind];
  const parsed = parseCapturedAt(capturedAt);
  const tzExtra = {
    timezoneAssumed: parsed.timezoneAssumed,
    ...(parsed.normalized === '' ? {} : { rawParsedAs: parsed.normalized }),
  };

  if (parsed.ms === null) {
    return {
      kind,
      status: 'unknown',
      capturedAt,
      ageMinutes: null,
      ttlMinutes,
      note: '数据时间戳缺失或不可解析——**不假定其新鲜**，不得按"当前"表述',
      ...tzExtra,
    };
  }

  const rawAge = (now.getTime() - parsed.ms) / 60_000;

  // 未来时间（超出容忍度）：不当成"更新鲜"，而是判为不可信时效
  if (rawAge < -FUTURE_TOLERANCE_MINUTES) {
    return {
      kind,
      status: 'unknown',
      capturedAt,
      ageMinutes: Math.round(rawAge),
      ttlMinutes,
      note:
        `⚠️ 数据时间戳位于**未来**（${capturedAt}，距当前约 ${Math.abs(Math.round(rawAge))} 分钟）——` +
        '判为**不可信时效**，不得按"当前可售/实时价格"表述',
      ...tzExtra,
    };
  }

  const ageMinutes = Math.max(0, Math.round(rawAge));
  const tzNote = parsed.timezoneAssumed
    ? `（原文未带时区，按 ${ASSUMED_TIMEZONE} 解读为 ${parsed.normalized}）`
    : '';

  if (ageMinutes <= ttlMinutes) {
    return {
      kind,
      status: 'fresh',
      capturedAt,
      ageMinutes,
      ttlMinutes,
      note: `数据产生于 ${capturedAt}（${ageMinutes} 分钟前，时效 ${ttlMinutes} 分钟内）${tzNote}`,
      ...tzExtra,
    };
  }

  return {
    kind,
    status: 'stale',
    capturedAt,
    ageMinutes,
    ttlMinutes,
    note:
      `⚠️ 数据产生于 ${capturedAt}，距今 ${formatAge(ageMinutes)}，**已超时效 ${formatAge(ttlMinutes)}**——` +
      `只能作**历史样例**，**不代表当前可售，也不是实时价格**${tzNote}`,
    ...tzExtra,
  };
}

/** 把分钟数写成人话 */
export function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h} 小时${minutes % 60 > 0 ? ` ${minutes % 60} 分` : ''}`;
  return `${Math.floor(h / 24)} 天`;
}

/** 批量判断，返回是否存在过期项（供展示层决定是否加显著提示） */
export function anyStale(items: readonly Freshness[]): boolean {
  return items.some((f) => f.status !== 'fresh');
}
