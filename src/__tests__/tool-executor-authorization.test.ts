/**
 * Stage 4 W3a — `executeToolCall` admission-order behavior tests.
 *
 * The unit tests in `skill-tool-authorization.test.ts` cover the
 * decision helper in isolation. These tests pin the REAL execution
 * entry's admission ordering — specifically that the W3 authorization
 * check sits BEFORE the legacy `allowedToolNames` gates, so a model-
 * issued skill_* tool that is unauthorized AND missing from
 * allowedToolNames is reported as `authorization_denied` (the W3
 * canonical signal) rather than `tool_restricted_this_turn` (the
 * legacy gate's signal).
 *
 * Without this ordering, W3b would silently regress: with
 * `mode:'none'/reason:'no_skill_signal'` ToolPolicy populated by
 * turn-engine, the model harness sees the wrong errorKind because the
 * legacy allowedToolNames gate intercepts first.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'

// ---------------------------------------------------------------------------
// Admission-order: authorization MUST run before allowedToolNames for skill_*
// ---------------------------------------------------------------------------

test('mode:none + skill_* missing from allowedToolNames → returns authorization_denied (NOT tool_restricted_this_turn)', async () => {
  // Reproduces the W3a P1 review case: skill_run_shell + 空 allowedToolNames
  // + no_skill_signal authorization. Without the admission-order fix, the
  // legacy allowedToolNames gate would intercept and return
  // `tool_restricted_this_turn`. Post-fix, authorization runs first and
  // returns the canonical `authorization_denied`.
  const context: Partial<ToolContext> = {
    allowedToolNames: new Set<string>(), // empty — would fail allowedToolNames gate
    invoker: 'model',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    sessionId: 'scope-test',
  }
  const output = await executeToolCall('skill_run_shell', { command: 'echo' }, context as ToolContext)
  const data = output.data || {}
  assert.equal(data.errorKind, 'authorization_denied', 'errorKind must be authorization_denied (not tool_restricted_this_turn)')
  assert.equal(data.reason, 'no_skill_signal', 'reason must propagate from authorization')
  assert.equal(data.toolName, 'skill_run_shell')
})

test('mode:selected with primitive NOT in allowedPrimitives → authorization_denied even if allowedToolNames has it', async () => {
  // Belt-and-suspenders: even when the legacy allowedToolNames gate would
  // have passed, an unselected primitive must be rejected by authorization.
  const auth = buildSelectedSkillToolAuthorization({
    skillId: 'video-expert-analyzer',
    allowedTypedActions: ['skill_video_expert_pipeline'],
    allowedPrimitives: ['skill_read_artifact'], // skill_run_shell NOT here
    source: 'explicit',
    reason: 'user_named_other_skill',
  })
  const context: Partial<ToolContext> = {
    allowedToolNames: new Set(['skill_run_shell']), // allowedToolNames would let it through
    invoker: 'model',
    authorization: auth,
    sessionId: 'scope-test',
  }
  const output = await executeToolCall('skill_run_shell', { command: 'echo' }, context as ToolContext)
  const data = output.data || {}
  assert.equal(data.errorKind, 'authorization_denied')
  assert.equal(data.reason, 'tool_not_in_allowed_primitives')
})

// ---------------------------------------------------------------------------
// invoker bypass: child_runner / host skip authorization check entirely
// ---------------------------------------------------------------------------

test('invoker:host + skill_* + mode:none → bypasses authorization (host calls have their own admission)', async () => {
  // Host invokers (e.g. internal turn-engine probe) must not trip the
  // authorization gate even when authorization is mode:'none'. They
  // continue through the allowedToolNames gate.
  const context: Partial<ToolContext> = {
    allowedToolNames: new Set<string>(), // legacy gate will reject
    invoker: 'host',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    sessionId: 'scope-test',
  }
  const output = await executeToolCall('skill_run_shell', { command: 'echo' }, context as ToolContext)
  const data = output.data || {}
  // Falls through to allowedToolNames gate, NOT authorization_denied.
  assert.equal(data.errorKind, 'tool_restricted_this_turn', 'host invoker must NOT return authorization_denied')
  assert.equal(data.reason, undefined)
})

// ---------------------------------------------------------------------------
// Non-skill tools: untouched by authorization
// ---------------------------------------------------------------------------

test('non-skill tool + mode:none → legacy allowedToolNames gate (not authorization_denied)', async () => {
  // Authorization only applies to `skill_*` tools. A document_* / browser_*
  // tool with mode:'none' and missing allowedToolNames must report
  // `tool_restricted_this_turn`, not `authorization_denied`.
  const context: Partial<ToolContext> = {
    allowedToolNames: new Set<string>(),
    invoker: 'model',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    sessionId: 'scope-test',
  }
  const output = await executeToolCall('document_open_tab', { url: 'https://example.test' }, context as ToolContext)
  const data = output.data || {}
  // Either tool_not_registered (if document_open_tab isn't in registry on
  // host-Node) or tool_restricted_this_turn — both are NOT authorization_denied.
  assert.notEqual(data.errorKind, 'authorization_denied', 'non-skill tools must never see authorization_denied')
})

// ---------------------------------------------------------------------------
// Source-shape pin: ordering invariant
// ---------------------------------------------------------------------------

test('source: authorization check appears in tool-executor.ts BEFORE the allowedToolNames gates', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: admission ORDER is the W3 canonical-signal invariant. A future refactor that re-orders these gates would silently change which errorKind the model receives. The behavior tests above will catch most cases, but the source-level pin guards against subtle reorderings (e.g. introducing a new check between authorization and allowedToolNames that shifts ordering).
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/modules/tools/tool-executor.ts'),
    'utf8',
  )
  const authIdx = source.indexOf('checkSkillToolAuthorization(toolName, authorization, isPrimitive)')
  const allowlistIdx = source.indexOf('errorKind: TOOL_ADMISSION_ERROR_KINDS.toolRestrictedThisTurn.code')
  assert.ok(authIdx > 0, 'authorization check must exist')
  assert.ok(allowlistIdx > 0, 'tool_restricted_this_turn allowlist gate must exist')
  assert.ok(
    authIdx < allowlistIdx,
    `authorization check (${authIdx}) must precede allowedToolNames gate (${allowlistIdx}) — see W3 plan §10 互斥 on canonical signals`,
  )
})

// ---------------------------------------------------------------------------
// Stage 10 belt-and-suspenders: missing-authorization on model-issued skill_*
// ---------------------------------------------------------------------------

test('Stage 10 invariant: model-issued skill_* call missing authorization → throws (catches as-any bypass)', async () => {
  // The ToolContext type requires authorization, but `as any` / `as unknown as`
  // bypasses it. The runtime invariant in tool-executor admission must throw
  // to prevent silently allowing through a missing-authorization model-issued
  // call. See `tool-executor.ts:184` (the Stage 10 belt-and-suspenders assert).
  await assert.rejects(
    () => executeToolCall(
      'skill_run_shell',
      { command: 'echo' },
      {
        invoker: 'model',
        allowedToolNames: new Set(['skill_run_shell']),
        sessionId: 'scope-test',
      } as unknown as ToolContext,
    ),
    /Stage 10 invariant.*authorization/i,
    'missing authorization on model-issued skill_* must throw, not silently pass',
  )
})
