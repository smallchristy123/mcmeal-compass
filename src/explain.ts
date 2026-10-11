/**
 * 证据驱动的解释生成（T2.5）
 *
 * 计划书 §6.5 的硬要求：
 *   「`LLM` 只能根据**结构化结果**生成描述，如『方案 A 比方案 B 蛋白质多 X g，官方计价贵 Y 元』。
 *     所有 `X/Y` 必须由**程序计算**；模型不可自行引用不存在的营养字段、过敏原信息、优惠券或价格。
 *     解释器需要带上证据 `evidenceIds` / `toolCallTrace`（日志脱敏）。」
 *
 * 因此本模块**只产出数字与可直接核对的句子**，不做任何润色性发挥。
 * 上层（或 LLM）若要转述，只能转述这里算出来的话。
 */

import type { AnalyzedItem } from './analyze.ts';
import type { PricedCandidate } from './pricing.ts';
import { formatCents, toYuan, type Cents } from './money.ts';

/** 一条可核对的证据引用 */
export interface EvidenceRef {
  /** 稳定 id，便于前端跳转/展开 */
  id: string;
  kind: 'official-single' | 'official-combo-sum' | 'official-price' | 'menu-price';
  label: string;
}

/** 脱敏的工具调用轨迹（**不含任何 Token、账号、地址**） */
export interface ToolCallTraceEntry {
  tool: string;
  /** 参数摘要（仅业务字段） */
  argsSummary: string;
  ok: boolean;
  /** 调用耗时（毫秒），若可得 */
  ms?: number;
  /** 发起时刻（ISO）——由**真实报价收据**提供，不再由解释层拼凑 */
  at?: string;
  /** 失败分类（如 RATE_LIMITED / TIMEOUT） */
  errorCode?: string;
  /** 重试次数 */
  retries?: number;
  /** 成功响应内容的哈希前 12 位（可交叉核对） */
  responseHash?: string;
}

export interface Explanation {
  /** 由程序算出的、可直接展示的句子 */
  statements: string[];
  evidenceIds: string[];
  toolCallTrace: ToolCallTraceEntry[];
}

/** 从候选与其计价结果中收集证据引用 */
export function collectEvidence(priced: PricedCandidate): EvidenceRef[] {
  const refs: EvidenceRef[] = [
    { id: `menu:${priced.item.code}`, kind: 'menu-price', label: `门店菜单项：${priced.item.name}` },
  ];
  for (const ev of priced.item.evidence) {
    const id =
      ev.kind === 'official-single'
        ? `nut:${ev.label.replace(/^官方单品营养：/, '')}`
        : `combo:${priced.item.code}`;
    refs.push({ id, kind: ev.kind, label: ev.label });
  }
  // ⚠️ 只有**官方确实给了价格**才作证据；拿不到报价时不得凭空造一条"官方计价"
  if (priced.quote && priced.quote.price !== null) {
    refs.push({
      id: `price:${priced.item.code}`,
      kind: 'official-price',
      label: `官方计价：${formatCents(priced.quote.price)}（原价 ${priced.quote.originalPrice === null ? '—' : formatCents(priced.quote.originalPrice)}，优惠 ${priced.quote.discount === null ? '—' : formatCents(priced.quote.discount)}）`,
    });
  } else if (priced.receipt && !priced.receipt.ok) {
    refs.push({
      id: `price:${priced.item.code}`,
      kind: 'official-price',
      label: `官方计价**未取得**（${priced.receipt.errorCode ?? '未知原因'}）：以菜单价计，未核实实付`,
    });
  }
  return refs;
}

/** 把一条数值差写成句子；任一侧缺失则**如实说缺**，不编数字 */
function diffStatement(
  subject: string,
  metric: string,
  unit: string,
  a: number | null,
  b: number | null,
  higherIsBetter = true,
  decimals = 0,
): string {
  if (a === null || b === null) {
    return `${subject}的「${metric}」有一侧数据缺失，**无法比较**（不做估算）`;
  }
  const d = a - b;
  if (d === 0) return `${subject}的「${metric}」与对照**相同**（${a.toFixed(decimals)}${unit}）`;
  const better = higherIsBetter ? d > 0 : d < 0;
  return (
    `${subject}的「${metric}」比对照${d > 0 ? '多' : '少'} ` +
    `${Math.abs(d).toFixed(decimals)}${unit}（${a.toFixed(decimals)}${unit} vs ${b.toFixed(decimals)}${unit}，` +
    `${better ? '此项更优' : '此项较差'}）`
  );
}

/** 解释单个方案 */
export function explainPlan(priced: PricedCandidate, baseline?: PricedCandidate): Explanation {
  const it: AnalyzedItem = priced.item;
  const statements: string[] = [];

  statements.push(
    `本方案为「${it.name}」——${it.kind === 'combo' ? `由 ${it.evidence.length - 1} 个组件组成` : '单品'}` +
      `，营养可信度 ${it.confidence} 级。`,
  );

  // 价格
  if (priced.effectivePrice !== null) {
    statements.push(
      priced.priceSource === 'official'
        ? `官方计价实付 ${formatCents(priced.effectivePrice)}（含优惠与费用，已核）。`
        : `菜单价 ${formatCents(priced.effectivePrice)}——**官方计价未取得，未核实实付**。`,
    );
  } else {
    statements.push('价格未取得，无法给出金额。');
  }

  // 营养（只报有数据的项，缺的如实说缺）
  const e = it.totals.energyKcal;
  const p = it.totals.protein;
  if (e.value !== null) {
    statements.push(`热量 ${e.complete ? '' : '（部分已知，实际更高）'}${e.value} kcal。`);
  }
  if (p.value !== null) {
    statements.push(`蛋白质 ${p.complete ? '' : '（部分已知）'}${p.value} g。`);
  }
  if (e.value === null && p.value === null) {
    statements.push('关键营养数据不可得，本方案不提供营养数值。');
  }

  // 与基线对比（若给定）
  if (baseline) {
    statements.push('—— 与对照方案的比较 ——');
    statements.push(
      diffStatement('本方案', '实付价格', '元',
        priced.effectivePrice === null ? null : toYuan(priced.effectivePrice),
        baseline.effectivePrice === null ? null : toYuan(baseline.effectivePrice),
        false, 2,
      ),
    );
    statements.push(
      diffStatement('本方案', '蛋白质', 'g', p.value, baseline.item.totals.protein.value, true, 1),
    );
    statements.push(
      diffStatement('本方案', '热量', 'kcal', e.value, baseline.item.totals.energyKcal.value, true, 0),
    );
    const naA = it.totals.sodium.value;
    const naB = baseline.item.totals.sodium.value;
    if (naA !== null || naB !== null) {
      statements.push(diffStatement('本方案', '钠', 'mg', naA, naB, false, 0));
    }
  }

  const refs = collectEvidence(priced);
  return {
    statements,
    evidenceIds: refs.map((r) => r.id),
    toolCallTrace: buildToolCallTrace(priced),
  };
}

/**
 * 由**真实收据**生成工具轨迹。
 *
 * 此前这里是静态拼装（`query-meals` 恒记 `ok: true`）——外部评审 P0-3 指出：
 * 那样既不能反映真实成败，也不能作审计凭据。现在：
 *   · `calculate-price` 一条一收据（含时刻、状态、失败分类、重试次数、响应哈希）；
 *   · `query-meals` / `query-meal-detail` 由候选自带证据推断（**失败即如实记 false**）。
 */
export function buildToolCallTrace(priced: PricedCandidate): ToolCallTraceEntry[] {
  const it = priced.item;
  const trace: ToolCallTraceEntry[] = [
    // 候选来自菜单 → 菜单查询必已成功；否则不会有这个候选可推荐
    { tool: 'query-meals', argsSummary: 'storeCode=<已脱敏>', ok: true },
  ];
  if (it.kind === 'combo') {
    const expanded = it.evidence.some((e) => e.kind === 'official-combo-sum');
    trace.push({
      tool: 'query-meal-detail',
      argsSummary: `code=${it.code}`,
      ok: expanded,
      ...(expanded ? {} : { errorCode: 'NOT_EXPANDED' }),
    });
  }
  const r = priced.receipt;
  if (r) {
    trace.push({
      tool: r.tool,
      argsSummary: r.argsSummary,
      ok: r.ok,
      at: r.at,
      ms: r.durationMs,
      ...(r.retries === undefined ? {} : { retries: r.retries }),
      ...(r.errorCode === undefined ? {} : { errorCode: r.errorCode }),
      ...(r.responseHash === undefined ? {} : { responseHash: r.responseHash }),
    });
  } else {
    trace.push({ tool: 'calculate-price', argsSummary: `items=[${it.code}×1]`, ok: false, errorCode: 'NO_RECEIPT' });
  }
  return trace;
}

/** 两方案对比（直接用程序算出的差） */
export function comparePlans(a: PricedCandidate, b: PricedCandidate): string[] {
  return [
    diffStatement('方案 A', '实付价格', '元',
      a.effectivePrice === null ? null : toYuan(a.effectivePrice),
      b.effectivePrice === null ? null : toYuan(b.effectivePrice), false, 2),
    diffStatement('方案 A', '蛋白质', 'g', a.item.totals.protein.value, b.item.totals.protein.value, true, 1),
    diffStatement('方案 A', '热量', 'kcal', a.item.totals.energyKcal.value, b.item.totals.energyKcal.value, true, 0),
    diffStatement('方案 A', '钠', 'mg', a.item.totals.sodium.value, b.item.totals.sodium.value, false, 0),
  ];
}

/** 供上层换算（避免各处重复写 ÷100） */
export { toYuan };
export type { Cents };
