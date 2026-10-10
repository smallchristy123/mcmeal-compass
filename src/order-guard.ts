/**
 * 下单安全闸门（T11）
 *
 * 计划书 §8.3 / T11 的硬要求：**未经用户明确确认，`create-order` 绝不执行**。
 * 本模块把这条要求从「口头约定」变成「代码里的闸门」——
 * 想下单，必须先过这里；过不了就不执行，并**留痕**（记录一次安全拒绝）。
 *
 * 四道闸（缺一不可）：
 *   1. 订单内容非空；
 *   2. **报价新鲜**——价格会变，超过时效的旧报价不可作数（默认 10 分钟）；
 *   3. **用户已明确确认**；
 *   4. **用户确认的金额 == 官方报价金额**——防止「报价变了却拿旧确认蒙混过去」。
 */

import type { Cents } from './money.ts';
import { formatCents } from './money.ts';

export type OrderGuardCode =
  | 'EMPTY_ITEMS'
  | 'STALE_QUOTE'
  | 'NOT_CONFIRMED'
  | 'TOTAL_MISMATCH';

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
}

export interface OrderGuardOptions {
  /** 报价有效期（分钟），默认 10 */
  quoteMaxAgeMinutes?: number;
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

  if (!intent.items || intent.items.length === 0) {
    throw new OrderGuardError('EMPTY_ITEMS', '订单内容为空，不予下单');
  }

  const quotedAt = Date.parse(intent.quotedAt);
  if (!Number.isFinite(quotedAt)) {
    throw new OrderGuardError('STALE_QUOTE', '报价时间缺失或不可解析，不予下单');
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
  /** 实际执行结果（仅当放行时才有） */
  executed?: unknown;
}

/**
 * 尝试下单：先过闸门，通过才执行；任一环节不过则**不执行**，并写入审计。
 *
 * @param execute 真正的下单动作（调用 MCP 的 create-order）。**只有过闸才会被调用。**
 * @param auditLog 可选的审计数组；每次尝试都会追加一条
 */
export async function attemptOrder(
  intent: OrderIntent,
  confirmation: UserConfirmation,
  execute: (intent: OrderIntent) => Promise<unknown>,
  auditLog: OrderAuditEntry[] = [],
  options: OrderGuardOptions = {},
): Promise<AttemptOrderResult> {
  const now = (options.now ?? (() => new Date()))();

  const record = (allowed: boolean, code?: OrderGuardCode, reason?: string) => {
    auditLog.push({
      at: now.toISOString(),
      allowed,
      code,
      reason,
      storeCode: intent.storeCode,
      itemCount: intent.items?.length ?? 0,
      quotedTotal: intent.quotedTotal,
    });
  };

  try {
    assertOrderAllowed(intent, confirmation, options);
  } catch (e) {
    const err = e as OrderGuardError;
    record(false, err.code, err.message);
    return { allowed: false, code: err.code, reason: err.message };
  }

  const executed = await execute(intent);
  record(true);
  return { allowed: true, executed };
}
