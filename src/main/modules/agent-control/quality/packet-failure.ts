/**
 * EP3-PK4 — aggregation packet settlement: child-failure three-way decision
 * P5c/C22 unwired: this module is not in production path.
 * + the Matrix upstream report contract + the parent CheckIn through the
 * Q4a adjudication channel (09 §3.3/§3.4).
 *
 * Hard rules, all CODE:
 *  - a failed child has EXACTLY three exits — redispatch (retry cap 1) /
 *    degrade (explicit not_applicable reason) / block (module_waiting,
 *    waits for the user). Swallowing a failure silently is impossible:
 *    building the parent adjudication with an unsettled failed child
 *    throws (静默吞失败 = 测试红);
 *  - upstream reports are summary ≤5 lines + artifact REFS + open
 *    questions — full result text never rides back into the parent
 *    context (大产物落文件、引用入 proof);
 *  - the parent packet CheckIn is produced by the SAME task-adjudicator
 *    as ordinary tasks (02 裁决层无特殊路径) in shadow kind — it never
 *    touches terminal state here, and enforce behavior upgrades
 *    automatically with the legacy-track Q4b flip. This module only
 *    BUILDS adjudication inputs and returns the CheckInRecord; the
 *    projection write stays inside the funnel-gated channel
 *    (run-finalizer / repository).
 */

import { createHash } from 'node:crypto'

import { adjudicateTerminalOutcome, type CheckInRecord } from './task-adjudicator'
import { buildAggregationCriteria } from './packet-compiler'
import type { ProofRef } from './proof-collector'

// ---------------------------------------------------------------- upstream report

export const UPSTREAM_SUMMARY_MAX_LINES = 5
export const UPSTREAM_SUMMARY_LINE_MAX_CHARS = 200
const UPSTREAM_REF_MAX_CHARS = 300

export interface PacketUpstreamReport {
  /** ≤5 行结果摘要。 */
  summaryLines: string[]
  /** 产物引用（路径/id）——引用，不是内容。 */
  artifactRefs: string[]
  openQuestions: string[]
}

/** Throws on anything that smells like full-text dumping. */
export function validateUpstreamReport(report: PacketUpstreamReport): void {
  if (!Array.isArray(report.summaryLines) || report.summaryLines.length === 0) {
    throw new Error('[packet-failure] upstream report requires a summary (1-5 行)')
  }
  if (report.summaryLines.length > UPSTREAM_SUMMARY_MAX_LINES) {
    throw new Error(`[packet-failure] summary exceeds ${UPSTREAM_SUMMARY_MAX_LINES} lines — 摘要不是正文`)
  }
  for (const line of report.summaryLines) {
    if (typeof line !== 'string' || line.length > UPSTREAM_SUMMARY_LINE_MAX_CHARS) {
      throw new Error('[packet-failure] summary line too long — 大产物落文件、引用入 proof，禁止全文塞回')
    }
  }
  for (const ref of report.artifactRefs) {
    if (typeof ref !== 'string' || !ref.trim() || ref.length > UPSTREAM_REF_MAX_CHARS) {
      throw new Error('[packet-failure] artifact ref must be a short path/id reference')
    }
  }
}

// ---------------------------------------------------------------- three-way settlement

export const REDISPATCH_RETRY_CAP = 1

export type ChildFailureAction = 'redispatch' | 'degrade' | 'block'

export interface ChildFailureSettlement {
  childTaskId: string
  action: ChildFailureAction
  /** degrade: the explicit not_applicable reason (never optional). */
  notApplicableReason?: string
  /** block: fixed blocker taxonomy — the parent waits for the user. */
  blockerCategory?: 'module_waiting'
}

export function settleChildFailure(input: {
  childTaskId: string
  requested: ChildFailureAction
  /** redispatches already consumed for THIS child. */
  retriesUsed: number
  degradeReason?: string
}): ChildFailureSettlement {
  switch (input.requested) {
    case 'redispatch':
      if (input.retriesUsed >= REDISPATCH_RETRY_CAP) {
        throw new Error(`[packet-failure] redispatch cap (${REDISPATCH_RETRY_CAP}) exhausted for ${input.childTaskId} — 三选一只剩降级或阻塞`)
      }
      return { childTaskId: input.childTaskId, action: 'redispatch' }
    case 'degrade':
      if (!input.degradeReason || !input.degradeReason.trim()) {
        throw new Error('[packet-failure] degrade requires an explicit not_applicable reason — 降级不写理由等于静默吞')
      }
      return { childTaskId: input.childTaskId, action: 'degrade', notApplicableReason: input.degradeReason }
    case 'block':
      return { childTaskId: input.childTaskId, action: 'block', blockerCategory: 'module_waiting' }
    default:
      throw new Error(`[packet-failure] unknown settlement action: ${String(input.requested)}`)
  }
}

// ---------------------------------------------------------------- parent adjudication

export interface ChildPacketOutcome {
  childTaskId: string
  title: string
  state: 'completed' | 'failed'
  /** completed children MUST attach an upstream report. */
  report?: PacketUpstreamReport | null
  failure?: { kind: string; message: string } | null
}

export interface ParentPacketAdjudication {
  checkIn: CheckInRecord
  verdict: CheckInRecord['verdict']
  proofs: ProofRef[]
  /** c3 — 未决问题：blocked 子包 + 降级缺口 + 子报告 open questions。 */
  openQuestions: string[]
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Assemble the parent aggregation CheckIn from child outcomes. EVERY failed
 * child must carry a settlement — an unsettled failure throws instead of
 * silently disappearing from the aggregate.
 */
export function buildParentPacketAdjudication(input: {
  parentTaskId: string
  children: ReadonlyArray<ChildPacketOutcome>
  settlements: ReadonlyArray<ChildFailureSettlement>
  now: Date
}): ParentPacketAdjudication {
  if (input.children.length === 0) {
    throw new Error('[packet-failure] a parent packet without children has nothing to aggregate')
  }
  const settlementByChild = new Map(input.settlements.map((entry) => [entry.childTaskId, entry]))
  const proofs: ProofRef[] = []
  const openQuestions: string[] = []

  for (const child of input.children) {
    if (child.state === 'completed') {
      const report = child.report
      if (!report) {
        throw new Error(`[packet-failure] completed child ${child.childTaskId} has no upstream report — 上行报告是合同不是礼貌`)
      }
      validateUpstreamReport(report)
      // the child's check-in becomes a task_event proof on the parent;
      // refs only — the report content stays where it landed.
      proofs.push({
        kind: 'task_event',
        ref: `packet-child:${child.childTaskId}|completed|refs=${report.artifactRefs.length}`.slice(0, 200),
        ts: input.now.toISOString(),
        digest: sha256(report.summaryLines.join('\n')),
      })
      for (const ref of report.artifactRefs) {
        proofs.push({ kind: 'artifact', ref: ref.slice(0, 200), ts: input.now.toISOString(), digest: sha256(ref) })
      }
      openQuestions.push(...report.openQuestions)
      continue
    }
    // failed child: settlement is MANDATORY
    const settlement = settlementByChild.get(child.childTaskId)
    if (!settlement) {
      throw new Error(`[packet-failure] failed child ${child.childTaskId} has NO settlement — 静默吞子包失败被禁止（重派/降级/阻塞三选一）`)
    }
    if (settlement.action === 'degrade') {
      proofs.push({
        kind: 'task_event',
        ref: `packet-child:${child.childTaskId}|degraded|${settlement.notApplicableReason}`.slice(0, 200),
        ts: input.now.toISOString(),
        digest: sha256(`${child.childTaskId}|degraded`),
      })
      openQuestions.push(`子包「${child.title}」降级：${settlement.notApplicableReason}`)
    } else if (settlement.action === 'block') {
      openQuestions.push(`子包「${child.title}」阻塞等待用户决策（${child.failure?.kind ?? 'unknown'}）`)
    }
    // redispatch settles nothing here — the retried child reports next round.
  }

  const pendingRedispatch = input.settlements.filter((entry) => entry.action === 'redispatch')
  const blocked = input.settlements.filter((entry) => entry.action === 'block')
  const terminalStatus = blocked.length > 0 || pendingRedispatch.length > 0 ? 'blocked' : 'done'
  const terminalReason = blocked.length > 0
    ? 'module_waiting'
    : pendingRedispatch.length > 0
      ? 'child_redispatch_pending'
      : 'aggregation_complete'

  // SAME adjudicator as ordinary tasks — shadow kind, terminal untouched;
  // enforce upgrades with Q4b automatically because the channel is shared.
  const result = adjudicateTerminalOutcome({
    terminalStatus,
    terminalReason,
    criteria: buildAggregationCriteria(),
    proofs,
    now: input.now,
  })
  return { checkIn: result.checkIn, verdict: result.verdict, proofs, openQuestions }
}
