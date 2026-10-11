/**
 * 数据一致性校验（计划书 §5.3.7；外部评审 P1-3 的处置）
 *
 * 官方营养表同时给出 `energyKj` 与 `energyKcal`。二者若换算不符，说明该条记录本身有问题——
 * 此时**不能**照常拿它做完整营养推荐，而应：降级可信度、记下异常、并允许上层如实说明。
 *
 * 换算基准：**1 kcal = 4.184 kJ**（即 1 kJ ≈ 0.239 kcal）。
 *
 * ## 容差怎么定的（不是拍脑袋）
 *
 * 拿 `fixtures/baseline-20261010-3450024` 的 160 条真实数据实测：
 *   · 偏差中位数 0.13%、p95 0.72% —— 绝大多数只是四舍五入；
 *   · 唯一"看着离谱"的是极小值：`川宁伯爵红茶` kj=7 → 期望 1.67 kcal，表里记 2 kcal，
 *     相对偏差 16% —— 但绝对差只有 0.33 kcal，属正常取整。
 *
 * 故采用**双标准**：`|kcal − kj/4.184| ≤ max(相对容差×kcal, 绝对容差)`，默认 5% 与 1 kcal。
 * 这样既不会放过真异常，也不会把"小数值的取整"误判为数据错误。
 */

export interface EnergyRow {
  energyKj: number | null;
  energyKcal: number | null;
}

export type EnergyCheckStatus =
  /** 两者皆在且换算相符 */
  | 'consistent'
  /** 两者皆在但换算不符——**视为数据异常** */
  | 'inconsistent'
  /** 只有一项（无法交叉校验） */
  | 'unknown'
  /** 两项都没有 */
  | 'missing';

export interface EnergyCheck {
  status: EnergyCheckStatus;
  kj: number | null;
  kcal: number | null;
  /** 由 kj 推算出的 kcal（换算基准 1 kcal = 4.184 kJ） */
  expectedKcal: number | null;
  /** 绝对偏差（kcal） */
  deviation: number | null;
  /** 相对偏差（%） */
  deviationPct: number | null;
  /** 给人看的说明 */
  detail: string;
}

export interface EnergyCheckOptions {
  /** 相对容差（默认 0.05 = 5%） */
  relativeTolerance?: number;
  /** 绝对容差（kcal，默认 1）——用于吸收小数值的取整误差 */
  absoluteToleranceKcal?: number;
}

/** 1 kcal = 4.184 kJ（官方换算基准） */
export const KJ_PER_KCAL = 4.184;

export function checkEnergyConsistency(row: EnergyRow, options: EnergyCheckOptions = {}): EnergyCheck {
  const rel = options.relativeTolerance ?? 0.05;
  const abs = options.absoluteToleranceKcal ?? 1;

  const kj = row.energyKj;
  const kcal = row.energyKcal;

  if (kj === null && kcal === null) {
    return {
      status: 'missing',
      kj,
      kcal,
      expectedKcal: null,
      deviation: null,
      deviationPct: null,
      detail: 'kJ 与 kcal 均缺失，无法校验（也不得据此推断热量）',
    };
  }
  if (kj === null || kcal === null) {
    return {
      status: 'unknown',
      kj,
      kcal,
      expectedKcal: null,
      deviation: null,
      deviationPct: null,
      detail: `仅给出 ${kj === null ? 'kcal' : 'kJ'}，无法交叉校验换算一致性`,
    };
  }

  const expectedKcal = kj / KJ_PER_KCAL;
  const deviation = Math.abs(kcal - expectedKcal);
  const deviationPct = kcal === 0 ? (expectedKcal === 0 ? 0 : Number.POSITIVE_INFINITY) : (deviation / kcal) * 100;
  const allowed = Math.max(rel * Math.abs(kcal), abs);
  const ok = deviation <= allowed;

  return {
    status: ok ? 'consistent' : 'inconsistent',
    kj,
    kcal,
    expectedKcal: Number(expectedKcal.toFixed(2)),
    deviation: Number(deviation.toFixed(4)),
    deviationPct: Number.isFinite(deviationPct) ? Number(deviationPct.toFixed(2)) : null,
    detail: ok
      ? `换算一致：${kj} kJ ≈ ${expectedKcal.toFixed(1)} kcal，表中记 ${kcal} kcal（偏差 ${deviation.toFixed(2)} kcal）`
      : `⚠️ 换算不符：${kj} kJ 应约为 ${expectedKcal.toFixed(1)} kcal，但表中记 ${kcal} kcal` +
        `（偏差 ${deviation.toFixed(2)} kcal / ${Number.isFinite(deviationPct) ? deviationPct.toFixed(1) : '∞'}%，已超容差 ${abs} kcal 与 ${(rel * 100).toFixed(0)}%）`,
  };
}

/** 批量校验，返回异常清单（异常项**不得**进入完整营养推荐） */
export function findEnergyAnomalies<T extends EnergyRow & { productName: string }>(
  rows: readonly T[],
  options: EnergyCheckOptions = {},
): { row: T; check: EnergyCheck }[] {
  const out: { row: T; check: EnergyCheck }[] = [];
  for (const row of rows) {
    const check = checkEnergyConsistency(row, options);
    if (check.status === 'inconsistent') out.push({ row, check });
  }
  return out;
}
