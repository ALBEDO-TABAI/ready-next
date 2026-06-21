/**
 * EP1-T4-2 — envelope coexistence + browser/skills pilot.
 *
 * Contract: docs/superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md (EP1-T4-2)
 * Design:   docs/agent-evolution/07-真值源工具协议与可观测性设计明细.md §3.1
 *
 * Pins:
 *   1. The dispatch exit of `executeToolCall` attaches an `envelope` to EVERY
 *      result (browser / skill / other domains, and admission denials alike).
 *   2. Additive coexistence — the legacy fields (text/shape/data/
 *      projectionPatch/interactionHint/framePatch/contextModifier) are
 *      byte-identical to the pre-envelope contract; `envelope` is the only
 *      new key (全域改动全域证明: a non-browser/non-skill tool is snapshotted).
 *   3. Envelope discipline — error messages enter the envelope as a single
 *      clipped line (subprocess stdout/stderr dumps stay in legacy fields);
 *      ok envelopes carry no payload duplicate.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import { deriveEnvelopeForToolOutput } from '../main/modules/tools/tool-result-envelope'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
} from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { ToolDomainError } from '../main/modules/tools/tool-errors'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'

test('tool-envelope-pilot declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'tool-envelope-pilot transitive sqlite load')
})

const LEGACY_KEYS = [
  'text',
  'shape',
  'data',
  'projectionPatch',
  'interactionHint',
  'framePatch',
  'contextModifier',
].sort()

function modelContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    invoker: 'model',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    sessionId: 'envelope-pilot-test',
    ...overrides,
  } as ToolContext
}

// ---------------------------------------------------------------------------
// 1. Browser-domain pilot
// ---------------------------------------------------------------------------

test('browser pilot: successful browser_get_task carries an ok envelope, legacy text untouched', async () => {
  const controller = {
    getTask: async () => null,
  } as unknown as BrowserController
  const output = await executeToolCall(
    'browser_get_task',
    { task_id: 'browser-task-99' },
    modelContext({ browserController: controller }),
  )
  assert.ok(output.envelope, 'envelope must be attached at the dispatch exit')
  assert.equal(output.envelope?.ok, true)
  assert.equal(output.envelope?.kind, 'ok')
  // Legacy contract untouched: plain-string browser results stay text-shaped.
  assert.match(output.text, /"status":\s*"missing"/)
  assert.equal(output.shape, 'text')
  assert.equal(output.data, null)
})

test('browser pilot: thrown ToolDomainError surfaces with a correctly mapped error envelope', async () => {
  const controller = {
    getTask: async () => {
      throw new ToolDomainError('not_found', 'browser task browser-task-x does not exist')
    },
  } as unknown as BrowserController
  const output = await executeToolCall(
    'browser_get_task',
    { task_id: 'browser-task-x' },
    modelContext({ browserController: controller }),
  )
  assert.equal(output.data?.errorKind, 'not_found', 'legacy errorKind preserved')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'not_found')
  assert.equal(output.envelope?.error?.message, 'browser task browser-task-x does not exist')
})

// ---------------------------------------------------------------------------
// 2. Skill-domain pilot
// ---------------------------------------------------------------------------

test('skill pilot: primitive dispatch result carries the mapped envelope alongside legacy errorKind', async () => {
  // child_runner invoker reaches the skill domain headless (no model
  // authorization gate); without any skill context the primitive returns the
  // structured `primitive_no_skill_context` — a real skill-domain result.
  const output = await executeToolCall(
    'skill_read_artifact',
    { relativePath: 'run_state.json' },
    modelContext({
      invoker: 'child_runner',
      allowedToolNames: new Set(['skill_read_artifact']),
    }),
  )
  assert.equal(output.data?.errorKind, 'primitive_no_skill_context', 'legacy errorKind preserved')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'internal_error')
})

// ---------------------------------------------------------------------------
// 3. 全域证明 — non-browser/non-skill tool: legacy fields snapshot unchanged
// ---------------------------------------------------------------------------

test('calendar (non-pilot domain): legacy field set is exactly the pre-envelope contract + envelope only', async () => {
  const output = await executeToolCall(
    'calendar_list_window',
    { start: '2026-06-01T00:00:00Z', end: '2026-06-02T00:00:00Z' },
    modelContext({
      requestModuleToolAction: async () => ({ summary: '窗口内 0 个事件' }),
    }),
  )
  const { envelope, ...legacy } = output
  assert.deepEqual(
    Object.keys(legacy).sort(),
    LEGACY_KEYS,
    'no legacy field added/removed/renamed — envelope is the only new key',
  )
  assert.match(legacy.text, /窗口内 0 个事件/)
  assert.equal(legacy.data, null, 'calendar string results keep data=null as before')
  assert.equal(legacy.projectionPatch, null)
  assert.equal(legacy.interactionHint, null)
  assert.equal(legacy.framePatch, null)
  assert.equal(envelope?.ok, true)
  assert.equal(envelope?.kind, 'ok')
  assert.equal(envelope?.data, undefined, 'ok envelope must not duplicate the payload in phase 1')
})

// ---------------------------------------------------------------------------
// 4. Unified exit — admission denials and the I3-1 gate carry envelopes too
// ---------------------------------------------------------------------------

test('unknown tool denial carries a not_found envelope', async () => {
  const output = await executeToolCall('totally_fabricated_tool', {}, modelContext())
  assert.equal(output.data?.errorKind, 'tool_not_registered')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'not_found')
})

test('I3-1 confirmation-gate denial maps to a denied_by_policy envelope', async () => {
  const output = await executeToolCall('calendar_delete_event', { id: 'evt-1' }, modelContext())
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
  assert.equal(output.envelope?.ok, false)
  assert.equal(output.envelope?.kind, 'denied_by_policy')
})

test('allowlist denial maps directly to denied_by_policy, NOT upstream_error', async () => {
  const output = await executeToolCall('calendar_list_window', {
    start: '2026-06-01T00:00:00Z',
    end: '2026-06-02T00:00:00Z',
  }, modelContext({ allowedToolNames: new Set<string>() }))
  assert.equal(output.data?.errorKind, 'tool_restricted_this_turn')
  assert.equal(output.data?.reason, undefined)
  assert.equal(output.envelope?.kind, 'denied_by_policy',
    'a this-turn policy refusal must not read as an upstream outage')
})

test('host_unavailable WITHOUT a mappable reason still maps to upstream_error', () => {
  const envelope = deriveEnvelopeForToolOutput({
    text: 'Browser controller is offline',
    data: { errorKind: 'host_unavailable' },
  })
  assert.equal(envelope.kind, 'upstream_error')
})

// ---------------------------------------------------------------------------
// 5. Envelope discipline (pure derivation helper)
// ---------------------------------------------------------------------------

test('error message prefers structured data.message and clips to a single line', () => {
  const envelope = deriveEnvelopeForToolOutput({
    text: '工具 x 失败：第一行\nSTDERR:\nTraceback (most recent call last):\n  File "x.py" ...',
    data: { errorKind: 'tool_failed', message: '子进程退出码 1\n完整 stderr 已写入 .logs/' },
  })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.kind, 'internal_error')
  assert.equal(
    envelope.error?.message,
    '子进程退出码 1',
    'only the first line of the structured message enters the envelope — stderr dumps stay in legacy fields',
  )
})

test('error message falls back to the first line of legacy text when data.message is absent', () => {
  const envelope = deriveEnvelopeForToolOutput({
    text: 'child gateway tool_failed: boom\nSTDERR:\nnoise',
    data: { errorKind: 'tool_failed' },
  })
  assert.equal(envelope.error?.message, 'child gateway tool_failed: boom')
})

test('long messages are clipped to 400 chars', () => {
  const envelope = deriveEnvelopeForToolOutput({
    text: 'x'.repeat(1000),
    data: { errorKind: 'timeout' },
  })
  assert.equal(envelope.kind, 'network_error')
  assert.equal(envelope.error?.message.length, 400)
})

test('skill child gateway failure shape (data.ok=false, no errorKind) derives an error envelope from the structured message', () => {
  // Exact shape produced by executeChildInternalSkillTool for a failed skill
  // run — the structured result message must win; child stderr never enters
  // the envelope (07 §3.3 stdout/stderr 二分纪律).
  const envelope = deriveEnvelopeForToolOutput({
    text: 'child gateway skill_action_failed: 模型分析步骤失败\n详细 stderr 见 .logs/',
    data: {
      ok: false,
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      childRunId: 'child-1',
    },
  })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.kind, 'internal_error')
  assert.equal(envelope.error?.message, 'child gateway skill_action_failed: 模型分析步骤失败')
})

test('outputs without errorKind derive an ok envelope with no payload duplicate', () => {
  const envelope = deriveEnvelopeForToolOutput({
    text: 'ok',
    data: { ok: true, taskId: 't-1' },
  })
  assert.deepEqual(envelope, { ok: true, kind: 'ok' })
})

// ---------------------------------------------------------------------------
// 6. Plumbing — envelope survives normalization; handler outputs stay valid
// ---------------------------------------------------------------------------

test('normalizeToolExecutionOutput preserves an existing envelope', () => {
  const withEnvelope = {
    ...createToolExecutionOutput('hello', { data: { a: 1 } }),
    envelope: { ok: true as const, kind: 'ok' as const },
  }
  const normalized = normalizeToolExecutionOutput(withEnvelope)
  assert.deepEqual(normalized.envelope, { ok: true, kind: 'ok' })
})

test('createToolExecutionOutput without envelope keeps the old shape (handlers unchanged)', () => {
  const output = createToolExecutionOutput('plain')
  assert.equal(output.envelope ?? null, null)
})
