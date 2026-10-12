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

/** 时区依据：显式带时区 / 由「本地观测时刻」推断 / 无依据时按默认假定 */
export type TimezoneBasis = 'explicit' | 'inferred' | 'assumed' | 'none';

export interface ParsedCapturedAt {
  /** 可解析时为毫秒；不可解析为 null */
  ms: number | null;
  /** 是否**替它假定**了时区（原文未带时区、且无法推断时） */
  timezoneAssumed: boolean;
  /** 时区依据（v3.4：区分「显式」「推断」「假定」） */
  timezoneBasis: TimezoneBasis;
  /** 生效时区（`+08:00` / `Z`）；不可知为 null */
  timezone: string | null;
  /** 推断时：与本地观测时刻的差（分钟）；非推断为 null */
  observedDeltaMinutes: number | null;
  /** 规范化后的字符串（补了时区与 T 分隔符） */
  normalized: string;
}

/** 从带偏移的 ISO 串里取偏移量（如 `+08:00`）；`Z` 视为 `+00:00` */
function offsetOf(iso: string): string | null {
  const t = (iso ?? '').trim();
  if (/Z$/i.test(t)) return '+00:00';
  const m = /([+-]\d{2}:?\d{2})$/.exec(t);
  if (!m) return null;
  const v = m[1]!.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  return v;
}

/**
 * 解析数据产生时刻（P1-4；**v3.4 修正时区语义**）。
 *
 * v3.3 复评指出：我把「官方 `datetime` 不带时区」一律**按 +08:00 解读**，
 * 但实测同一端点不同工具返回的时区并不一致（例：营养表返回 `08:09` 而当时本地为 `16:09`，
 * 差 8 小时），于是「刚落地的案例」被算成约 480 分钟前——**存在 8 小时歧义**。
 *
 * 现规则（**不猜、可溯源**）：
 *   · 原文带时区 → 照用（`explicit`）；
 *   · 不带，但给了 `observedAt`（本地**请求时刻**，带偏移）→ 在「按本地偏移解读」与
 *     「按 UTC 解读」中取**更接近观测时刻**者，记为 `inferred`，并回写时间差；
 *   · 不带且无 `observedAt` → 仍按 `+08:00` 假定（`assumed`），note 中写明「假定」。
 */
export function parseCapturedAt(
  capturedAt: string,
  options: { observedAt?: string } = {},
): ParsedCapturedAt {
  const t = (capturedAt ?? '').trim();
  if (t === '') {
    return {
      ms: null,
      timezoneAssumed: false,
      timezoneBasis: 'none',
      timezone: null,
      observedDeltaMinutes: null,
      normalized: '',
    };
  }
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(t);
  const local = t.replace(' ', 'T');

  if (hasTz) {
    const ms = Date.parse(local);
    return {
      ms: Number.isFinite(ms) ? ms : null,
      timezoneAssumed: false,
      timezoneBasis: 'explicit',
      timezone: offsetOf(local),
      observedDeltaMinutes: null,
      normalized: local,
    };
  }

  // 无时区：若有本地观测时刻，则据差值**推断**服务端用的是哪个时区
  const obsMs = options.observedAt ? Date.parse(options.observedAt) : Number.NaN;
  const localOffset = options.observedAt ? offsetOf(options.observedAt) : null;
  if (Number.isFinite(obsMs) && localOffset !== null) {
    const asLocal = Date.parse(`${local}${localOffset}`);
    const asUtc = Date.parse(`${local}Z`);
    if (Number.isFinite(asLocal) && Number.isFinite(asUtc)) {
      const pickLocal = Math.abs(asLocal - obsMs) <= Math.abs(asUtc - obsMs);
      const ms = pickLocal ? asLocal : asUtc;
      const tz = pickLocal ? localOffset : 'Z';
      return {
        ms,
        timezoneAssumed: false,
        timezoneBasis: 'inferred',
        timezone: tz,
        observedDeltaMinutes: Math.round((obsMs - ms) / 60_000),
        normalized: `${local}${tz === 'Z' ? 'Z' : tz}`,
      };
    }
  }

  // 无依据：沿用默认假定（并如实标注「假定」）
  const normalized = `${local}${ASSUMED_TIMEZONE}`;
  const ms = Date.parse(normalized);
  return {
    ms: Number.isFinite(ms) ? ms : null,
    timezoneAssumed: true,
    timezoneBasis: 'assumed',
    timezone: ASSUMED_TIMEZONE,
    observedDeltaMinutes: null,
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
  /** 原文未带时区、由本工具按 +08:00 **假定**解读 */
  timezoneAssumed?: boolean;
  /** 时区依据：显式 / 由观测时刻推断 / 假定（v3.4） */
  timezoneBasis?: TimezoneBasis;
  /** 生效时区（`+08:00` / `Z`） */
  timezone?: string;
  /** 推断时：与本地观测时刻的差（分钟） */
  observedDeltaMinutes?: number;
  /** 规范化后的时间串（含时区），便于复核 */
  rawParsedAs?: string;
}

export function freshnessOf(
  capturedAt: string,
  kind: DataKind,
  options: { now?: Date; ttlMinutes?: number; observedAt?: string } = {},
): Freshness {
  const now = options.now ?? new Date();
  const ttlMinutes = options.ttlMinutes ?? DEFAULT_TTL_MINUTES[kind];
  const parsed = parseCapturedAt(capturedAt, {
    ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
  });
  const tzExtra = {
    timezoneAssumed: parsed.timezoneAssumed,
    timezoneBasis: parsed.timezoneBasis,
    ...(parsed.timezone === null ? {} : { timezone: parsed.timezone }),
    ...(parsed.observedDeltaMinutes === null
      ? {}
      : { observedDeltaMinutes: parsed.observedDeltaMinutes }),
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
  const tzNote =
    parsed.timezoneBasis === 'assumed'
      ? `（原文未带时区，**按 ${ASSUMED_TIMEZONE} 假定**解读为 ${parsed.normalized}；` +
        '如需精确判定，请同时提供本地观测时刻）'
      : parsed.timezoneBasis === 'inferred'
        ? `（原文未带时区，据本地观测时刻**推断**为 ${parsed.timezone === 'Z' ? 'UTC' : parsed.timezone}` +
          `，与观测时刻差 ${parsed.observedDeltaMinutes ?? 0} 分钟）`
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
export function formatAge(minutes: number): string {  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h} 小时${minutes % 60 > 0 ? ` ${minutes % 60} 分` : ''}`;
  return `${Math.floor(h / 24)} 天`;
}

/** 批量判断，返回是否存在过期项（供展示层决定是否加显著提示） */
export function anyStale(items: readonly Freshness[]): boolean {
  return items.some((f) => f.status !== 'fresh');
}

/**
 * 本机当前时刻的**本地 ISO**（带偏移，如 `2026-10-12T16:09:12+08:00`）。
 *
 * 用途：记录「本地观测时刻」，供 `parseCapturedAt` 推断服务端时区（v3.4）。
 * `toISOString()` 给的是 UTC（`…Z`），不足以表达"本地几点"，故另造此函数。
 */
export function localIsoNow(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = d.getTimezoneOffset(); // 东八区为 -480
  const sign = off <= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
