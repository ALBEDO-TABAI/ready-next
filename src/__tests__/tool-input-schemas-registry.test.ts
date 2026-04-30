/**
 * Unified tool-input schema registry contract (Phase 2.5 infrastructure).
 *
 * The registry is the single source of truth for dispatch-time Zod validation.
 * Phase 4: the 6 skill execution-control schemas were retired along with the
 * skill_executions state machine. Skill primitives are now the canonical
 * skill-domain entries in the registry.
 *
 * These tests lock:
 *  1. Baseline — primitive tool names are present with ZodObject values.
 *  2. Accessor shape — `getToolInputSchemas()` returns a plain record, not a
 *     frozen / proxy / live reference, so per-call merging (PR 12) is safe.
 *  3. No accidental name shadowing — the registry never has two entries for
 *     the same tool name.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { getToolInputSchemas } from '../main/modules/tools/schemas'
import { resolveToolInputSchemaForExecution } from '../main/modules/agent-control/tool-registry'
import { SKILL_PRIMITIVE_SCHEMAS } from '../main/modules/tools/skill-primitives/primitive-schemas'

test('getToolInputSchemas includes every skill primitive', () => {
  const registry = getToolInputSchemas()
  for (const name of Object.keys(SKILL_PRIMITIVE_SCHEMAS)) {
    assert.ok(registry[name], `registry missing schema for ${name}`)
    assert.strictEqual(
      registry[name],
      SKILL_PRIMITIVE_SCHEMAS[name as keyof typeof SKILL_PRIMITIVE_SCHEMAS],
    )
  }
})

test('getToolInputSchemas returns a plain object (safe to spread)', () => {
  const registry = getToolInputSchemas()
  assert.equal(Object.isFrozen(registry), false)
  const spread = { ...registry }
  assert.equal(Object.keys(spread).length, Object.keys(registry).length)
})

test('registry has no duplicate tool-name entries', () => {
  const registry = getToolInputSchemas()
  const names = Object.keys(registry)
  const unique = new Set(names)
  assert.equal(unique.size, names.length, 'duplicate tool-name keys in registry')
})

test('every registered schema is a Zod object with a .safeParse method', () => {
  const registry = getToolInputSchemas()
  for (const [name, schema] of Object.entries(registry)) {
    assert.equal(typeof (schema as { safeParse?: unknown }).safeParse, 'function', `${name} missing safeParse`)
  }
})

test('resolveToolInputSchemaForExecution returns the same schema as the static registry for primitives', () => {
  // Phase 2 (B child-loop): the resolver is the single execution-admission
  // schema source. For static primitives, it must resolve identically to the
  // legacy `getToolInputSchemas()` accessor — the legacy export is now a
  // thin wrapper over the same authoritative source the resolver consumes.
  const registry = getToolInputSchemas()
  for (const name of Object.keys(SKILL_PRIMITIVE_SCHEMAS)) {
    const resolved = resolveToolInputSchemaForExecution(name)
    assert.ok(resolved, `resolver missing schema for primitive ${name}`)
    assert.strictEqual(resolved, registry[name], `resolver and registry diverged for ${name}`)
  }
})

test('resolveToolInputSchemaForExecution returns schemas for static-manifest VEA actions', () => {
  // Phase 2 (B child-loop): VEA actions are the canonical "dynamic" skill
  // names that the resolver must surface. Even when the runtime manager is
  // unavailable (test context), the resolver falls through to the
  // static-manifest-derived schemas and produces a usable Zod object.
  for (const toolName of [
    'skill_video_expert_pipeline',
    'skill_video_expert_ai_analyze',
  ]) {
    const resolved = resolveToolInputSchemaForExecution(toolName)
    assert.ok(resolved, `resolver missing schema for ${toolName}`)
    assert.equal(
      typeof (resolved as { safeParse?: unknown }).safeParse,
      'function',
      `${toolName} resolved schema must expose Zod .safeParse`,
    )
    // Empty input must fail — VEA actions both have a required first param.
    const parsed = (resolved as { safeParse: (v: unknown) => { success: boolean } }).safeParse({})
    assert.equal(parsed.success, false, `${toolName} empty input should fail validation`)
  }
})

test('resolveToolInputSchemaForExecution returns null for unknown tool names', () => {
  // Passthrough contract: callers treat null as "no registered schema → no
  // validation". This mirrors validateToolInput's `{ ok: true }` branch.
  assert.equal(resolveToolInputSchemaForExecution('definitely_not_a_tool'), null)
  // skill_-prefixed but not registered: same passthrough.
  assert.equal(resolveToolInputSchemaForExecution('skill_made_up_action'), null)
})

// ------------------------------------------------------------------
// T6 (B child-loop, wave 3) — child-internal admission via the
// unified tool gateway.
//
// `executeSkillActionViaToolGateway` is the runner's single entry to
// `runSkill`. It must run the SAME Zod schema that the public typed
// dispatch path uses, so a malformed input fails the same way for both
// the model surface and the child runner.
// ------------------------------------------------------------------

test('T6: gateway rejects invalid input with errorKind=input_validation and never reaches the runtime manager', async () => {
  const { executeSkillActionViaToolGateway } = await import(
    '../main/modules/agent-control/tool-registry'
  )
  const fakeRuntime = {
    callCount: 0,
    runSkill: async (_req: unknown) => {
      fakeRuntime.callCount += 1
      throw new Error('runtime should not have been called for invalid input')
    },
  }
  const result = await executeSkillActionViaToolGateway({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    // Empty input — VEA actions both require at least one field, so the
    // resolver-backed Zod schema rejects this.
    input: {},
    childRunId: 'vt6inval0',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    outputDir: null,
    runStatePath: null,
    childInternal: true,
    // Inject the fake so we don't trigger the production singleton.
    runtimeManager: fakeRuntime as unknown as Parameters<
      typeof executeSkillActionViaToolGateway
    >[0]['runtimeManager'],
  })
  assert.equal(fakeRuntime.callCount, 0, 'runtime manager must not be invoked when admission fails')
  assert.equal(result.skillRunResult, null, 'gateway must surface a structured failure, not a runtime result')
  assert.equal(
    (result.data as { errorKind?: string } | null)?.errorKind,
    'input_validation',
    'gateway error must use the same input_validation kind public dispatch returns',
  )
})

test('T6: gateway succeeds when input matches the same schema the public dispatch path resolves', async () => {
  const { executeSkillActionViaToolGateway } = await import(
    '../main/modules/agent-control/tool-registry'
  )
  // Build a fake runtime that captures the request and returns success.
  const fakeRuntime = {
    lastRequest: null as Record<string, unknown> | null,
    runSkill: async (req: unknown) => {
      fakeRuntime.lastRequest = req as Record<string, unknown>
      return {
        success: true,
        status: 'completed',
        outputDir: '/tmp/t6-fake-output',
      }
    },
  }
  const result = await executeSkillActionViaToolGateway({
    skillId: 'video-expert-analyzer',
    action: 'video_expert_ai_analyze',
    input: { sceneScoresPath: '/tmp/t6-fake-output/scene_scores.json' },
    childRunId: 'vt6valid0',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    outputDir: '/tmp/t6-fake-output',
    runStatePath: '/tmp/t6-fake-output/run_state.json',
    childInternal: true,
    runtimeManager: fakeRuntime as unknown as Parameters<
      typeof executeSkillActionViaToolGateway
    >[0]['runtimeManager'],
  })
  assert.ok(result.skillRunResult, 'gateway must surface the SkillRunResult on success')
  assert.equal(result.skillRunResult?.success, true)
  // Child metadata must reach the runtime via the request envelope so the
  // host controller keeps it visible to downstream observers.
  const params = (fakeRuntime.lastRequest?.params as Record<string, unknown> | null) || null
  const ctx = params?.__childRunContext as Record<string, unknown> | undefined
  assert.ok(ctx, 'request.params must carry __childRunContext')
  assert.equal(ctx?.childRunId, 'vt6valid0')
  assert.equal(ctx?.outputDir, '/tmp/t6-fake-output')
})
