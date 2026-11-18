import {
  BROWSER_SEQUENCE_PAGE_OBSERVATION_TOOL_NAMES,
  BROWSER_SEQUENCE_UNVERIFIED_ERROR_KIND,
  type BrowserSequenceInput,
  type BrowserSequenceObservation,
  type BrowserSequenceResult,
  type BrowserSequenceStepRecord,
  type BrowserSequenceStepToolName,
} from '../../../shared/browser-sequence'
import { BROWSER_SEQUENCE_STEP_TOOL_NAMES, resolveBrowserCapability } from '../../../shared/browser-capability-registry'
import type { BrowserActionOutcome } from '../../../shared/browser-action-outcome'
import { resolveToolInputSchemaForExecution } from '../agent-control/tools-runtime/tool-registry'
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { TOOL_ADMISSION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
import type { ToolContext, executeToolCall } from './tool-executor'
import { interactionSignalFromResult } from './browser-action-executor'
import { createBrowserStructuredOutput } from './browser-failure-output'
import { errorMessageOf, isTerminalInfrastructureError } from './tool-errors'
import { validateToolInput } from './tool-input-validator'
import { normalizeAllowedToolSet } from './tool-not-allowed-message'

const PAGE_OBSERVATION_TOOLS: ReadonlySet<string> = new Set(BROWSER_SEQUENCE_PAGE_OBSERVATION_TOOL_NAMES)
const MESSAGE_MAX_CHARS = 400
const NOTE_MAX_CHARS = 200

type Step = BrowserSequenceInput['steps'][number]
type Stop = { errorKind: string; message: string }

function isStepTool(tool: string): tool is BrowserSequenceStepToolName {
  return (BROWSER_SEQUENCE_STEP_TOOL_NAMES as readonly string[]).includes(tool)
}

function readOutcome(data: Record<string, unknown>): BrowserActionOutcome | null {
  const outcome = data.outcome
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return null
  const record = outcome as Record<string, unknown>
  return typeof record.dispatch === 'string' && typeof record.delivery === 'string'
    ? outcome as BrowserActionOutcome
    : null
}

/** The words that go with a failure: the result's own message, or its prose when it is not a JSON dump. */
function messageOf(output: ToolExecutionOutput, fallback: string): string {
  const structured = output.data && typeof output.data.message === 'string' ? output.data.message.trim() : ''
  const prose = String(output.text || '').trim()
  const message = structured || (prose && !/^[{[]/.test(prose) ? prose : fallback)
  return message.slice(0, MESSAGE_MAX_CHARS)
}

/**
 * Why a step that ran is not a success. The reading uses only typed fields of the step's own result;
 * what a page or a legacy tool wrote in prose never decides it.
 */
function stopOf(tool: string, output: ToolExecutionOutput): Stop | null {
  const data = output.data || {}
  const errorKind = typeof data.errorKind === 'string' ? data.errorKind.trim() : ''
  if (errorKind) return { errorKind, message: messageOf(output, errorKind) }
  const signal = interactionSignalFromResult(output)
  if (output.interactionHint || signal.challenge || signal.loginWall) {
    return {
      errorKind: 'browser_user_action_required',
      message: signal.loginWall ? '页面要求登录，需要用户处理。' : '页面需要用户亲自处理后才能继续。',
    }
  }
  if (data.ok === false || output.envelope?.ok === false) {
    return { errorKind: 'browser_step_failed', message: messageOf(output, '这一步没有成功。') }
  }
  if (tool === 'browser_wait' && (data.matched === false || data.ready === false)) {
    return { errorKind: 'wait_not_matched', message: '等待的条件在时限内没有出现。' }
  }
  const outcome = readOutcome(data)
  if (outcome && (outcome.dispatch === 'rejected' || outcome.delivery === 'not_delivered')) {
    return { errorKind: 'browser_action_not_delivered', message: '这一步的输入没有送达页面。' }
  }
  return null
}

function recordOf(
  step: number,
  tool: BrowserSequenceStepToolName,
  output: ToolExecutionOutput,
  stop: Stop | null,
  context: ToolContext,
): BrowserSequenceStepRecord {
  const data = output.data || {}
  const record: BrowserSequenceStepRecord = { step, tool, ok: !stop }
  const outcome = readOutcome(data)
  if (outcome) {
    if (outcome.delivery !== 'not_applicable') record.delivery = outcome.delivery
    if (outcome.effect !== 'not_applicable') record.effect = outcome.effect
    const before = outcome.identity.documentState === 'document' ? outcome.identity.tabId : null
    const after = outcome.successorIdentity.documentState === 'document' ? outcome.successorIdentity.tabId : null
    const newTabId = [outcome.postActionTabId, after].find((tabId) => tabId && tabId !== before) || null
    if (newTabId) record.newTabId = newTabId
    const tabId = newTabId || after || before
    const url = outcome.environmentSummary?.url
      || (tabId ? context.browserController?.getTabList?.().find((tab) => tab.id === tabId)?.url : '')
    if (url) record.url = url
    if (outcome.environmentSummary?.dialogState === 'open') record.dialog = 'open'
  }
  if (typeof data.opaqueOriginalText === 'string' && data.opaqueOriginalText.trim()) {
    record.note = data.opaqueOriginalText.trim().slice(0, NOTE_MAX_CHARS)
  }
  if (stop) {
    record.errorKind = stop.errorKind
    record.message = stop.message
  }
  return record
}

function rest(steps: readonly Step[], from: number): BrowserSequenceResult['notExecuted'] {
  return steps.slice(from).map((step, offset) => ({ step: from + offset + 1, tool: step.tool }))
}

function refused(steps: readonly Step[], at: number, stop: Stop, extra: Record<string, unknown> = {}): ToolExecutionOutput {
  const result: BrowserSequenceResult = {
    ok: false,
    errorKind: stop.errorKind,
    message: stop.message,
    stoppedAt: at + 1,
    steps: [],
    observation: null,
    notExecuted: rest(steps, 0),
  }
  return createBrowserStructuredOutput({ ...result, ...extra })
}

/**
 * Checks the whole list before anything touches the page: every step must be a tool this turn may use,
 * with arguments its own registered schema accepts, and a look at the page may only come last. A list
 * with a mistake in it runs no step at all.
 */
function refusalBeforeStart(input: BrowserSequenceInput, context: ToolContext): ToolExecutionOutput | null {
  const allowed = normalizeAllowedToolSet(context.allowedToolNames)
  for (const [index, step] of input.steps.entries()) {
    const label = `第 ${index + 1} 步（${step.tool}）`
    if (!isStepTool(step.tool)) {
      return refused(input.steps, index, {
        errorKind: 'browser_sequence_step_not_allowed',
        message: `${label}不能放进连续动作。`,
      }, { toolName: step.tool })
    }
    if (PAGE_OBSERVATION_TOOLS.has(step.tool) && index !== input.steps.length - 1) {
      return refused(input.steps, index, {
        errorKind: 'browser_sequence_observation_not_last',
        message: `${label}是观察步骤，只能放在最后一步；整个连续动作没有执行。`,
      }, { toolName: step.tool })
    }
    if (allowed && !allowed.has(step.tool)) {
      return refused(input.steps, index, {
        errorKind: TOOL_ADMISSION_ERROR_KINDS.toolRestrictedThisTurn.code,
        message: `${label}本轮不可用，整个连续动作没有执行。`,
      }, { toolName: step.tool })
    }
    const schema = resolveToolInputSchemaForExecution(step.tool)
    const validation = validateToolInput(step.tool, step.args, schema ? { [step.tool]: schema } : {})
    if (!validation.ok || !resolveBrowserCapability(step.tool, step.args)) {
      return refused(input.steps, index, {
        errorKind: 'input_validation',
        message: `${label}参数不合法，整个连续动作没有执行。${validation.ok ? '' : validation.output.text}`.slice(0, MESSAGE_MAX_CHARS),
      }, { toolName: step.tool })
    }
    try {
      context.assertNestedToolCall?.(step.tool, step.args)
    } catch (error) {
      if (isTerminalInfrastructureError(error)) throw error
      // silent-catch: the turn's frozen tool contract refused this step; the model gets the refusal as a result and nothing runs.
      return refused(input.steps, index, {
        errorKind: 'browser_sequence_step_not_allowed',
        message: `${label}不在本轮冻结的工具合同内，整个连续动作没有执行。`,
      }, { toolName: step.tool, reason: errorMessageOf(error).slice(0, 120) })
    }
  }
  return null
}

/**
 * Runs up to six browser steps one after another inside a single tool call.
 *
 * Every step goes through `execute`, the same entry a standalone call uses, so admission, page identity,
 * confirmation, the write lease, the action journal and observation receipts all apply to it unchanged.
 * The sequence itself touches nothing: it only decides whether the next step may start, and it stops at
 * the first step that is not a success. It never retries, never undoes and never asks the model again.
 */
export async function executeBrowserSequence(
  input: BrowserSequenceInput,
  context: ToolContext,
  execute: typeof executeToolCall,
): Promise<ToolExecutionOutput> {
  const refusal = refusalBeforeStart(input, context)
  if (refusal) return refusal

  const total = input.steps.length
  const records: BrowserSequenceStepRecord[] = []
  let observation: BrowserSequenceObservation | null = null
  /** The step whose input may or may not have reached the page; no step that changes the page follows it. */
  let unverifiedStep: number | null = null

  /** `failed` is the stopping step's own result: the model needs it whole to decide what to do next. */
  const stopped = (at: number, stop: Stop, failed?: ToolExecutionOutput): ToolExecutionOutput => {
    const result: BrowserSequenceResult = {
      ok: false,
      errorKind: stop.errorKind,
      message: stop.message,
      stoppedAt: at + 1,
      steps: records,
      observation,
      notExecuted: rest(input.steps, records.length),
      ...(failed?.data ? { failure: { step: at + 1, tool: input.steps[at].tool, data: failed.data } } : {}),
    }
    return createBrowserStructuredOutput({ ...result })
  }

  for (const [index, step] of input.steps.entries()) {
    const capability = resolveBrowserCapability(step.tool, step.args)
    if (unverifiedStep !== null && capability?.mode !== 'observe') {
      return stopped(index, {
        errorKind: BROWSER_SEQUENCE_UNVERIFIED_ERROR_KIND,
        message: `第 ${unverifiedStep} 步是否生效还不确定，后面会改动页面的步骤没有执行；请先看页面再决定。`,
      })
    }

    let output: ToolExecutionOutput
    try {
      output = await execute(step.tool, step.args, { ...context, browserSequenceStep: { step: index + 1, of: total } })
    } catch (error) {
      // A cancelled or disowned run ends the whole call, exactly as it ends a standalone one.
      if (isTerminalInfrastructureError(error) || (error instanceof Error && error.name === 'CodexToolBridgeError')) throw error
      // silent-catch: steps before this one already acted on the page, so the failure is reported with their records instead of replacing them.
      output = createBrowserStructuredOutput({ ok: false, errorKind: 'browser_step_failed', message: errorMessageOf(error) })
    }

    const stop = stopOf(step.tool, output)
    const record = recordOf(index + 1, step.tool, output, stop, context)
    if (stop && output.data?.notExecuted === true) {
      // The step was turned away before it started (it needs the user's confirmation): it counts as not executed.
      return stopped(index, stop, output)
    }
    records.push(record)
    if (stop) return stopped(index, stop, output)

    if (PAGE_OBSERVATION_TOOLS.has(step.tool)) {
      observation = { step: index + 1, tool: step.tool, data: output.data || {} }
    }
    if (capability?.mode !== 'observe') {
      const outcome = readOutcome(output.data || {})
      if (!outcome || (outcome.delivery === 'unknown' && outcome.effect !== 'observed')) unverifiedStep = index + 1
    }
  }

  const result: BrowserSequenceResult = { ok: true, steps: records, observation, notExecuted: [] }
  return createBrowserStructuredOutput({ ...result })
}
