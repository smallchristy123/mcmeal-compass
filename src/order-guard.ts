/**
 * 下单安全闸门（T11）
 *
 * 计划书 §8.3 / T11 的硬要求：**未经用户明确确认，`create-order` 绝不执行**。
 * 本模块把这条要求从「口头约定」变成「代码里的闸门」——
 * 想下单，必须先过这里；过不了就不执行，并**留痕**（记录一次安全拒绝）。
 *
 * 六道闸（缺一不可）：
 *   1. 订单内容非空；
 *   2. 报价时间**可解析**；
 *   3. 报价**未过期**（默认 10 分钟）；
 *   4. 报价**不是未来时间**（容忍 clock skew）——外部评审 P0-4 指出的缺口；
 *   5. **用户已明确确认**；
 *   6. **用户确认的金额 == 官方报价金额**。
 *
 * ## ⚠️ 真实下单在本版本被**显式关闭**（外部评审 P0-4 的处置）
 *
 * 本版本**未接入** `create-order` 的真实调用，也不声称具备下单能力。
 * 闸门本身（本文件）是完备且可测的，但要真正开启下单，还须补齐：
 * 请求幂等键、DRAFT→PRICED→USER_REVIEW→USER_CONFIRMED→SUBMITTING→SUCCEEDED/FAILED 状态机、
 * 报价二次校验、重复提交防护。**在补齐之前，`assertRealOrderingEnabled()` 会直接抛错。**
 */

import type { Cents } from './money.ts';
import { formatCents } from './money.ts';

export type OrderGuardCode =
  | 'EMPTY_ITEMS'
  | 'STALE_QUOTE'
  | 'FUTURE_QUOTE'
  | 'NOT_CONFIRMED'
  | 'TOTAL_MISMATCH'
  | 'EXECUTE_FAILED'
  | 'ORDERING_DISABLED';

/** 真实下单状态：本版本**关闭**。开启前须补齐幂等键与状态机（见文件头说明）。 */
export const REAL_ORDERING_ENABLED = false;
export const REAL_ORDERING_NOTE =
  '本版本未接入 create-order 的真实调用，下单能力已显式关闭；' +
  '开启前须补齐请求幂等键、订单状态机、报价二次校验与重复提交防护。';

/** 真实下单的入口守卫：在能力补齐之前，调用即抛错（不让"看似能下单"的代码存在） */
export function assertRealOrderingEnabled(): never {
  throw new OrderGuardError('ORDERING_DISABLED', REAL_ORDERING_NOTE);
}

export class OrderGuardError extends Error {
  readonly code: OrderGuardCode;
  constructor(code: OrderGuardCode, message: string) {
    super(message);
    this.name = 'OrderGuardError';
    this.code = code;
  }
}

export interface OrderIntent {
  storeCode: string;
  orderType: number;
  beType: number;
  items: { productCode: string; quantity: number }[];
  /** 经官方 calculate-price 确认的实付金额（分） */
  quotedTotal: Cents;
  /** 报价时刻（ISO 字符串） */
  quotedAt: string;
}

export interface UserConfirmation {
  /** 用户是否明确点了「确认下单」 */
  confirmed: boolean;
  /** 用户在确认界面上**看到的金额**（分） */
  acknowledgedTotal?: Cents | null;
  confirmedAt?: string;
}

/** 审计留痕：无论放行还是拒绝，都记一笔 */
export interface OrderAuditEntry {
  at: string;
  allowed: boolean;
  code?: OrderGuardCode;
  reason?: string;
  storeCode: string;
  itemCount: number;
  quotedTotal: Cents;
  /** 该笔发生在哪一步：闸门判定 / 实际执行（便于区分「放行但提交失败」与「从未尝试」） */
  stage?: 'guard' | 'execute';
  /** 执行阶段的失败类型（仅当 stage=execute 且失败时） */
  errorName?: string;
}

export interface OrderGuardOptions {
  /** 报价有效期（分钟），默认 10 */
  quoteMaxAgeMinutes?: number;
  /** 允许的时钟偏差（毫秒，默认 60_000）——报价时间晚于 now+skew 视为异常 */
  clockSkewMs?: number;
  /** 取当前时间的函数（便于测试） */
  now?: () => Date;
}

/**
 * 校验是否允许下单。**不通过即抛错**——调用方必须让它抛，不得 catch 后继续。
 * @throws {OrderGuardError}
 */
export function assertOrderAllowed(
  intent: OrderIntent,
  confirmation: UserConfirmation,
  options: OrderGuardOptions = {},
): void {
  const now = (options.now ?? (() => new Date()))();
  const maxAgeMs = (options.quoteMaxAgeMinutes ?? 10) * 60_000;
  const skewMs = options.clockSkewMs ?? 60_000;

  if (!intent.items || intent.items.length === 0) {
    throw new OrderGuardError('EMPTY_ITEMS', '订单内容为空，不予下单');
  }

  const quotedAt = Date.parse(intent.quotedAt);
  if (!Number.isFinite(quotedAt)) {
    throw new OrderGuardError('STALE_QUOTE', '报价时间缺失或不可解析，不予下单');
  }
  // 未来时间戳：要么是时钟错乱，要么是伪造的"永远新鲜"报价——两者都不可信
  if (quotedAt > now.getTime() + skewMs) {
    throw new OrderGuardError(
      'FUTURE_QUOTE',
      `报价时间晚于当前时间（超出允许偏差 ${Math.round(skewMs / 1000)} 秒），视为异常，不予下单`,
    );
  }
  if (now.getTime() - quotedAt > maxAgeMs) {
    throw new OrderGuardError(
      'STALE_QUOTE',
      `报价已过期（超过 ${options.quoteMaxAgeMinutes ?? 10} 分钟），价格可能已变，须重新计价并重新确认`,
    );
  }

  if (!confirmation.confirmed) {
    throw new OrderGuardError('NOT_CONFIRMED', '用户尚未确认，绝不执行下单');
  }

  if (confirmation.acknowledgedTotal === undefined || confirmation.acknowledgedTotal === null) {
    throw new OrderGuardError(
      'TOTAL_MISMATCH',
      '用户确认的金额缺失，无法核对——不予下单',
    );
  }
  if (confirmation.acknowledgedTotal !== intent.quotedTotal) {
    throw new OrderGuardError(
      'TOTAL_MISMATCH',
      `用户确认的金额（${formatCents(confirmation.acknowledgedTotal)}）与官方报价（${formatCents(intent.quotedTotal)}）不一致，不予下单`,
    );
  }
}

export interface AttemptOrderResult {
  allowed: boolean;
  code?: OrderGuardCode;
  reason?: string;
  /** 实际执行结果（仅当放行且执行成功时才有） */
  executed?: unknown;
  /** 是否走到了"实际执行"这一步（用于区分「从未尝试」与「尝试了但失败」） */
  attempted?: boolean;
}

/**
 * 尝试下单：先过闸门，通过才执行；任一环节不过则**不执行**，并写入审计。
 *
 * ⚠️ 本版本 `execute` 通常传的是 `assertRealOrderingEnabled` 之类会抛错的守卫——
 * 真实下单向未开启。此处保留完整的"放行 → 执行 → 留痕"流程，
 * 是为了让**责任边界可测**：闸门拒了 / 放行了但执行失败 / 执行成功，三种情形在审计里可分辨。
 *
 * @param execute 真正的下单动作。**只有过闸才会被调用。**
 * @param auditLog 可选的审计数组；每次尝试都会追加（含执行失败）
 */
export async function attemptOrder(
  intent: OrderIntent,
  confirmation: UserConfirmation,
  execute: (intent: OrderIntent) => Promise<unknown>,
  auditLog: OrderAuditEntry[] = [],
  options: OrderGuardOptions = {},
): Promise<AttemptOrderResult> {
  const now = (options.now ?? (() => new Date()))();

  const record = (
    allowed: boolean,
    code?: OrderGuardCode,
    reason?: string,
    stage: 'guard' | 'execute' = 'guard',
    errorName?: string,
  ) => {
    auditLog.push({
      at: now.toISOString(),
      allowed,
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
      storeCode: intent.storeCode,
      itemCount: intent.items?.length ?? 0,
      quotedTotal: intent.quotedTotal,
      stage,
      ...(errorName === undefined ? {} : { errorName }),
    });
  };

  try {
    assertOrderAllowed(intent, confirmation, options);
  } catch (e) {
    const err = e as OrderGuardError;
    record(false, err.code, err.message);
    return { allowed: false, code: err.code, reason: err.message, attempted: false };
  }

  // 已过闸：此后无论成败都留痕，绝不出现"放行了却查不到记录"的黑洞
  try {
    const executed = await execute(intent);
    record(true, undefined, undefined, 'execute');
    return { allowed: true, executed, attempted: true };
  } catch (e) {
    const err = e as Error;
    record(false, 'EXECUTE_FAILED', `闸门已放行，但执行失败：${err.message}`, 'execute', err.name);
    return { allowed: false, code: 'EXECUTE_FAILED', reason: err.message, attempted: true };
  }
}
