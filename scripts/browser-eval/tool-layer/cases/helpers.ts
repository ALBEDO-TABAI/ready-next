// Shared assertions for tool-layer cases. They read only tool results, the persisted browser
// journal, the page probe and the eval server records — never the model or the renderer.
import {
  parseBrowserWorkflowActionJournal
} from '../../../../src/main/modules/browser-engine/browser-workflow-evidence'
import type { AgentRun, CaseOutcome, ToolCallResult } from '../harness'
import { fail, gap, pass, unavailable } from '../harness'

export interface SnapshotTarget {
  targetId: string
  role: string
  name: string
  frameId?: string
  states?: Record<string, unknown>
  fingerprint?: Record<string, unknown>
}

export function snapshotTargets(result: ToolCallResult): SnapshotTarget[] {
  const pageMap = result.data.pageMap as { targets?: SnapshotTarget[] } | undefined
  return Array.isArray(pageMap?.targets) ? pageMap.targets : []
}

export function findMatches(result: ToolCallResult): SnapshotTarget[] {
  return Array.isArray(result.data.matches) ? result.data.matches as SnapshotTarget[] : []
}

export function hasTarget(targets: SnapshotTarget[], role: string, name: string | RegExp): boolean {
  return targets.some(
    (
      target
    ) => target.role === role
      && (typeof name === 'string' ? target.name === name || target.name.includes(name) : name.test(target.name))
  )
}

export function missingTargets(targets: SnapshotTarget[], expected: Array<[string, string | RegExp]>): string[] {
  return expected.filter(([role, name]) => !hasTarget(targets, role, name)).map(
    ([role, name]) => `${role}:${String(name)}`
  )
}

/** Compact role:name list for failure details. */
export function targetSummary(targets: SnapshotTarget[], size = 700): string {
  return targets.map((item) => `${item.role}:${item.name}`).join(' | ').slice(0, size)
}

/** Snapshot every page of the bounded page map (the public snapshot is budgeted). */
export async function allTargets(run: AgentRun): Promise<{ targets: SnapshotTarget[]; first: ToolCallResult }> {
  const first = await run.call('browser_snapshot', {})
  const targets = [...snapshotTargets(first)]
  let cursor = (first.data.pageMap as { nextCursor?: string | null } | undefined)?.nextCursor || null
  let guard = 0
  while (cursor && guard < 8) {
    const page = await run.call('browser_find', { cursor, limit: 200 })
    targets.push(...findMatches(page))
    cursor = typeof page.data.nextCursor === 'string' ? page.data.nextCursor : null
    guard += 1
  }
  return { targets, first }
}

export interface TargetFilter { role?: string; inputType?: string; purpose?: 'any' | 'action' | 'input' }

/** Pick exactly one target by accessible name, narrowed by role, input type or editability. */
export function pick(targets: SnapshotTarget[], query: string, filter: TargetFilter = {}): SnapshotTarget {
  const matches = targets
    .filter((item) => item.name === query || item.name.includes(query))
    .filter((item) => !filter.role || item.role === filter.role)
    .filter((item) => !filter.inputType || item.fingerprint?.inputType === filter.inputType)
    .filter((item) => filter.purpose !== 'input' || (item as { editable?: boolean }).editable === true)
  const exact = matches.filter((item) => item.name === query)
  const chosen = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null
  if (!chosen) {
    throw new Error(
      `target "${query
      }" ${JSON.stringify(filter)
      } not unique: ${JSON.stringify(matches.map((m) => `${m.role}:${m.name}`))
      }; page targets: ${targetSummary(targets, 500)
      }`
    )
  }
  return chosen
}

/**
 * Refs bind the snapshot revision that produced them, so every target used by one action must
 * come from the same snapshot. The snapshot (not browser_find, whose defaults keep only the
 * viewport) is what the model works from.
 */
export async function observe(
  run: AgentRun
): Promise<{ targets: SnapshotTarget[]; pick: (query: string, filter?: TargetFilter) => SnapshotTarget }> {
  const { targets } = await allTargets(run)
  return { targets, pick: (query, filter = {}) => pick(targets, query, filter) }
}

/** One target from a fresh snapshot (invalidates refs from earlier snapshots). */
export async function target(run: AgentRun, query: string, filter: TargetFilter = {}): Promise<SnapshotTarget> {
  return (await observe(run)).pick(query, filter)
}

export interface ActionOutcomeView {
  actionId: string | null
  dispatch: string | null
  delivery: string | null
  effect: string | null
  mayHaveCommitted: boolean | null
}

export function actionOutcome(result: ToolCallResult): ActionOutcomeView {
  const outcome = (result.data.browserActionOutcome || result.data.outcome) as Record<string, unknown> | undefined
  const nested = (result.data.result as Record<string, unknown> | undefined)
  return {
    actionId: typeof outcome?.actionId === 'string' ? outcome.actionId : null,
    dispatch: typeof outcome?.dispatch === 'string'
      ? outcome.dispatch
      : typeof result.data.dispatch === 'string' ? result.data.dispatch : null,
    delivery: typeof outcome?.delivery === 'string'
      ? outcome.delivery
      : typeof result.data.delivery === 'string'
        ? result.data.delivery
        : typeof nested?.delivery === 'string' ? nested.delivery as string : null,
    effect: typeof outcome?.effect === 'string'
      ? outcome.effect
      : typeof result.data.effect === 'string' ? result.data.effect : null,
    mayHaveCommitted: typeof outcome?.mayHaveCommitted === 'boolean'
      ? outcome.mayHaveCommitted
      : typeof result.data.mayHaveCommitted === 'boolean' ? result.data.mayHaveCommitted : null,
  }
}

export function errorKind(result: ToolCallResult): string | null {
  return typeof result.data.errorKind === 'string' ? result.data.errorKind : null
}

/** The public result, its BrowserActionOutcome and the persisted journal must agree. */
export function journalAgrees(run: AgentRun, result: ToolCallResult): { ok: boolean; detail: string } {
  const outcome = (result.data.browserActionOutcome || result.data.outcome) as Record<string, unknown> | undefined
  if (!outcome || typeof outcome.actionId !== 'string' || typeof outcome.taskId !== 'string') {
    return { ok: false, detail: 'result carries no BrowserActionOutcome' }
  }
  const payload = run.controller.getTaskPayload(outcome.taskId)
  if (!payload) return { ok: false, detail: 'browser task payload missing' }
  const journal = parseBrowserWorkflowActionJournal(payload, outcome.taskId)
  const settled = journal.settledOutcomes.find((item) => item.outcome.actionId === outcome.actionId)?.outcome
  if (!settled) return { ok: false, detail: `action ${outcome.actionId} not settled in journal` }
  const fields = ['dispatch', 'delivery', 'effect', 'mayHaveCommitted', 'operationId'] as const
  const diff = fields.filter((field) => (settled as unknown as Record<string, unknown>)[field] !== outcome[field])
  return diff.length === 0
    ? { ok: true, detail: `journal ${String(settled.delivery)}/${String(settled.effect)}` }
    : { ok: false, detail: `journal differs on ${diff.join(',')}` }
}

export function wasRestricted(result: ToolCallResult): boolean {
  return errorKind(result) === 'tool_restricted_this_turn' || /Tool not allowed in current context/.test(result.text)
}

/** A tool the frozen current-page surface does not contain: refused before dispatch. */
export function closedTool(result: ToolCallResult, reason: string): CaseOutcome {
  if (wasRestricted(result)) return unavailable(reason, { errorKind: errorKind(result) })
  return fail(
    `能力状态变化：${result.tool} 不再被拒绝，按新能力改写用例`,
    { text: result.text.slice(0, 400) }
  )
}

/** Background pointer: refused with zero page delivery. */
export async function pointerRefused(
  run: AgentRun,
  result: ToolCallResult,
  before: { counts: Record<string, number> } | null
): Promise<CaseOutcome> {
  const after = await run.probe()
  const delivered = ['pointerdown', 'mousedown', 'click', 'wheel']
    .some((name) => (after?.counts?.[name] ?? 0) !== (before?.counts?.[name] ?? 0))
  const outcome = actionOutcome(result)
  const kind = errorKind(result)
  const offscreen = kind === 'target_not_found' && /no visible hit point/.test(String(result.data.message || ''))
  const refused = (
    ((kind === 'foreground_required' || kind === 'browser_surface_required') && outcome.delivery === 'not_delivered')
    // Coordinate pointer paths stop before any transport and say so through the mutation boundary.
    || (kind === 'browser_mutation_transport_not_invoked' && result.data.settledActionCount === 0
      && outcome.mayHaveCommitted === false)
    // A target below the fold first needs a scroll, which is a pointer action too.
    || offscreen
  )
  if (refused && !delivered) {
    return unavailable(offscreen
      ? '后台指针未开放：目标在视口外，要先滚动，'
        + '而滚动同样需要前台指针；页面零投递（T5）'
      : `后台指针未开放：${String(kind)
      }，页面零投递（T5）`, { errorKind: kind, delivery: outcome.delivery })
  }
  if (delivered && result.data.ok === true)
    return fail('能力状态变化：后台指针已能投递，按新能力改写用例', result.data)
  return fail(
    `指针拒绝回执不一致：errorKind=${String(errorKind(result))
    } delivery=${String(outcome.delivery)
    } pageDelivered=${delivered
    }`,
    { text: result.text.slice(0, 500) }
  )
}

/**
 * Keyboard: the tool must report exactly what reached the page. A key that does not arrive while
 * the page already reports document.hasFocus() is the known background-keyboard defect: focus
 * emulation is skipped and the unfocused native host drops the event.
 */
export async function keyboardOutcome(
  run: AgentRun,
  result: ToolCallResult,
  before: { counts: Record<string, number> } | null,
  onDelivered: () => Promise<CaseOutcome>
): Promise<CaseOutcome> {
  const after = await run.probe()
  const pageKeys = (after?.counts?.keydown ?? 0) - (before?.counts?.keydown ?? 0)
  const delivery = actionOutcome(result).delivery
    || (typeof result.data.delivery === 'string' ? result.data.delivery : null)
  if (delivery === 'not_delivered' && pageKeys === 0) {
    const focused = await run.pageEval<boolean>('return document.hasFocus()')
    return gap(
      `缺陷：隐藏窗口里按键没有送达页面（页面 document.hasFocus()=${String(focused)
      }，所以发键时没开焦点模拟）；工具如实回报 not_delivered`,
      { delivery, pageKeys }
    )
  }
  if ((delivery === 'delivered' || delivery === 'unknown') && pageKeys > 0) return onDelivered()
  return fail(
    `按键回执与页面不一致：delivery=${String(delivery)} pageKeydown=${pageKeys}`,
    { text: result.text.slice(0, 500) }
  )
}

/**
 * fill_form submits by pressing Enter on the last field. Explain a missing submission: the key
 * never reached the page (background keyboard defect) or Enter only added a line in a textarea.
 */
export function submitFailure(filled: ToolCallResult): string | null {
  if (filled.data.submitted === true) return null
  const submit = filled.data.submitResult as { data?: Record<string, unknown> } | undefined
  const delivery = submit?.data?.delivery
  const focus = String(submit?.data?.focus || '')
  if (delivery === 'not_delivered')
    return `缺陷：fill_form 用回车提交，回车没有送达页面（${focus.trim() || '焦点未知'
      }），与“隐藏窗口里按键没有送达”同因`
  if (errorKind(filled) === 'form_field_failed') return `字段填写失败：${summarize(filled, 300)}`
  return null
}

export function recordsOf(run: AgentRun, kind: string): Array<{ kind: string; data: Record<string, unknown> }> {
  return run.server.records(kind)
}

export async function waitForRecord(
  run: AgentRun,
  kind: string,
  count = 1,
  timeoutMs = 5_000
): Promise<Array<{ kind: string; data: Record<string, unknown> }>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = recordsOf(run, kind)
    if (rows.length >= count) return rows
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return recordsOf(run, kind)
}

export function textOf(result: ToolCallResult): string {
  const content = result.data.content
  if (typeof content === 'string') return content
  return result.text
}

export function delivered(result: ToolCallResult): boolean {
  return actionOutcome(result).delivery === 'delivered'
}

export function summarize(result: ToolCallResult, size = 300): string {
  return result.text.replace(/\s+/g, ' ').slice(0, size)
}

export { fail, gap, pass, unavailable }
