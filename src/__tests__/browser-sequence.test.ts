import assert from 'node:assert/strict'
import test from 'node:test'
import { executeToolCall } from '../main/modules/tools/tool-executor'
import { browserSequenceFixture } from './utils/browser-sequence-fixture'
import {
  BROWSER_PUBLIC_TOOL_NAMES,
  BROWSER_SEQUENCE_STEP_TOOL_NAMES,
  browserToolBaseEffects,
  resolveBrowserCapability,
} from '../shared/browser-capability-registry'
import { BROWSER_SEQUENCE_UNVERIFIED_ERROR_KIND, type BrowserSequenceStepRecord } from '../shared/browser-sequence'
import { collectToolOutputProofs } from '../main/modules/agent-control/quality/proof-collector'
import { createBrowserStructuredOutput } from '../main/modules/tools/browser-failure-output'
import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import { buildReadyToolSurface, compareReadyToolSurfaceCompatibility } from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import { buildBrowserAdmissionAuthoritySnapshot, composeBrowserAdmissionToolNames, isCodexBrowserObservationClosureToolName } from '../main/modules/agent-control/codex-runtime/codex-browser-admission'
import { registerFrozenCallStore } from '../main/modules/agent-control/safety/frozen-call-bridge'
import type { FrozenCallStore } from '../main/modules/agent-control/safety/frozen-call-store'

const typeStep = { tool: 'browser_type', args: { selector: '#amount', text: '42' } }
const keyStep = { tool: 'browser_press_key', args: { key: 'Enter' } }
const snapshotStep = { tool: 'browser_snapshot', args: {} }
const waitStep = { tool: 'browser_wait', args: { condition: 'network_idle' } }
const readStep = { tool: 'browser_read', args: {} }
function records(data: Record<string, unknown> | null): BrowserSequenceStepRecord[] { return data?.steps as BrowserSequenceStepRecord[] }

test('Q1/Q5: type → press key → snapshot uses standard actions, leases, receipts and a full final observation', async (t) => {
  const f = browserSequenceFixture()
  t.after(() => f.lease.release())
  let effectStarts = 0
  let effectEnds = 0
  f.context.onToolEffectStart = () => { effectStarts++ }
  f.context.onToolEffectEnd = () => { effectEnds++ }
  const out = await executeToolCall('browser_sequence', { steps: [typeStep, keyStep, snapshotStep] }, f.context)
  assert.equal(out.data?.ok, true, out.text)
  assert.deepEqual(f.calls, ['type', 'keyDown', 'keyUp'])
  assert.deepEqual(f.actions.map(a => a.operationId), ['type_selector', 'press_key'])
  assert.deepEqual(f.outcomes.map(o => o.delivery), ['delivered', 'delivered'])
  assert.equal(f.lease.isHeld, true)
  assert.equal(f.observations.length, 1)
  const steps = records(out.data)
  assert.deepEqual(steps.map(s => [s.step, s.tool, s.ok]), [[1, 'browser_type', true], [2, 'browser_press_key', true], [3, 'browser_snapshot', true]])
  assert.deepEqual(steps.slice(0, 2).map(s => [s.delivery, s.url]), [['delivered', 'https://sequence.test/form'], ['delivered', 'https://sequence.test/form']])
  assert.deepEqual(Object.keys(steps[2]).sort(), ['ok', 'step', 'tool'], 'an observation step leaves no page content in its record')
  assert.ok(f.events.every(e => e.toolName !== 'browser_sequence'))
  assert.deepEqual(f.events.filter(e => e.phase === 'start').map(e => e.toolName), ['browser_type', 'browser_press_key'])
  const observation = out.data?.observation as { step: number; tool: string; data: Record<string, unknown> }
  assert.match(JSON.stringify(observation.data), /FINAL SNAPSHOT CONTENT/)
  assert.deepEqual([observation.step, observation.tool], [3, 'browser_snapshot'])
  assert.equal('text' in observation, false, 'the observation is handed back once, as data')
  assert.deepEqual(out.data?.notExecuted, [])
  assert.equal(effectStarts, 3)
  assert.equal(effectEnds, 3)
})

test('Q1: two identical steps are two actions in the journal, each with the digest a standalone call would write', async (t) => {
  const f = browserSequenceFixture()
  t.after(() => f.lease.release())
  const alone = browserSequenceFixture()
  t.after(() => alone.lease.release())
  await executeToolCall('browser_type', typeStep.args, alone.context)

  const out = await executeToolCall('browser_sequence', { steps: [typeStep, typeStep, snapshotStep] }, f.context)
  assert.equal(out.data?.ok, true, out.text)
  assert.deepEqual(f.outcomes.map(o => o.actionId), ['action-1', 'action-2'])
  assert.deepEqual(f.actions.map(a => a.argsDigest), [alone.actions[0].argsDigest, alone.actions[0].argsDigest])
})

test('Q3/Q5: failure in step 2 keeps step 1, never reaches the closing look, never retries or rolls back', async (t) => {
  const f = browserSequenceFixture()
  t.after(() => f.lease.release())
  f.state.keyDelivered = false
  const out = await executeToolCall('browser_sequence', { steps: [typeStep, keyStep, snapshotStep] }, f.context)
  assert.equal(out.data?.ok, false, out.text)
  assert.equal(out.data?.stoppedAt, 2)
  const alone = browserSequenceFixture()
  t.after(() => alone.lease.release())
  alone.state.keyDelivered = false
  const standalone = await executeToolCall('browser_press_key', keyStep.args, alone.context)
  assert.equal(out.data?.errorKind, standalone.data?.errorKind, 'the sequence stops for the reason the step itself gave')
  const failure = out.data?.failure as { step: number; tool: string; data: Record<string, unknown> }
  assert.deepEqual([failure.step, failure.tool], [2, 'browser_press_key'])
  assert.deepEqual(Object.keys(failure.data).sort(), Object.keys(standalone.data || {}).sort(), 'the stopping step is reported as a call of its own would report it')
  assert.equal((failure.data.outcome as { delivery: string }).delivery, 'not_delivered')
  assert.deepEqual(records(out.data).map(s => [s.step, s.ok, s.delivery]), [[1, true, 'delivered'], [2, false, 'not_delivered']])
  assert.deepEqual(out.data?.notExecuted, [{ step: 3, tool: 'browser_snapshot' }])
  assert.equal(out.data?.observation, null)
  assert.deepEqual(f.calls, ['type', 'keyDown', 'keyUp'])
  assert.equal(f.observations.length, 0)
})

test('Q4: origin confirmation in step 2 stops before card, action or lease; standalone still uses confirmation', async (t) => {
  const f = browserSequenceFixture()
  t.after(() => f.lease.release())
  let frozen = 0
  // A wired confirmation channel that fails immediately proves no card flow
  // is entered by the sequence, then proves standalone dispatch still enters it.
  registerFrozenCallStore({ freeze: () => { frozen++; throw new Error('confirmation-channel-entered') } } as unknown as FrozenCallStore)
  t.after(() => registerFrozenCallStore(null))
  // The page moves to an origin the user never named once the first step is over.
  f.context.onToolEffectEnd = () => { f.state.origin = 'https://foreign.test' }
  const out = await executeToolCall('browser_sequence', { steps: [waitStep, typeStep, snapshotStep] }, f.context)
  assert.equal(out.data?.stoppedAt, 2, out.text)
  assert.equal(out.data?.errorKind, 'denied_pending_confirmation')
  assert.match(String(out.data?.message), /单独调用 browser_type/)
  assert.deepEqual(records(out.data).map(s => [s.step, s.ok]), [[1, true]], 'the step that needs consent was never started')
  assert.deepEqual([(out.data?.failure as { step: number }).step, (out.data?.failure as { tool: string }).tool], [2, 'browser_type'])
  assert.equal(frozen, 0)
  assert.equal(f.lease.isHeld, false)
  assert.equal(f.actions.length, 0)
  assert.deepEqual(out.data?.notExecuted, [{ step: 2, tool: 'browser_type' }, { step: 3, tool: 'browser_snapshot' }])
  await assert.rejects(executeToolCall('browser_type', typeStep.args, f.context), /confirmation-channel-entered/)
  assert.equal(frozen, 1)
})

test('Q2: a disallowed, nested or unauthorized later tool rejects the whole sequence before step 1', async () => {
  for (const tool of ['browser_tabs', 'browser_dialog', 'browser_sequence', 'browser_eval', 'browser_download', 'invented', 'browser_select']) {
    const f = browserSequenceFixture()
    const out = await executeToolCall('browser_sequence', { steps: [typeStep, { tool, args: {} }] }, f.context)
    assert.equal(out.envelope?.ok, false, `${tool}: ${out.text}`)
    assert.equal(f.actions.length, 0, tool)
    assert.deepEqual(f.calls, [], tool)
    f.lease.release()
  }
})

test('Q2: empty and >6 steps reject; a step its own schema refuses rejects the whole list before anything runs', async (t) => {
  const f = browserSequenceFixture()
  t.after(() => f.lease.release())
  for (const steps of [[], Array(7).fill(typeStep)]) {
    const out = await executeToolCall('browser_sequence', { steps }, f.context)
    assert.equal(out.data?.errorKind, 'input_validation')
    assert.equal(f.actions.length, 0)
  }
  const invalid = { text: 42 }
  const single = await executeToolCall('browser_type', invalid, f.context)
  const out = await executeToolCall('browser_sequence', { steps: [typeStep, { tool: 'browser_type', args: invalid }, snapshotStep] }, f.context)
  assert.equal(out.data?.stoppedAt, 2, out.text)
  assert.equal(out.data?.errorKind, single.data?.errorKind)
  assert.match(String(out.data?.message), /text/)
  assert.deepEqual(records(out.data), [])
  assert.deepEqual((out.data?.notExecuted as unknown[]).length, 3)
  assert.equal(f.actions.length, 0)
  assert.deepEqual(f.calls, [])
})

test('Q1/Q2: a step the turn\'s frozen tool contract refuses rejects the whole list before anything runs', async (t) => {
  const f = browserSequenceFixture()
  t.after(() => f.lease.release())
  const asked: string[] = []
  f.context.assertNestedToolCall = (tool) => {
    asked.push(tool)
    if (tool === 'browser_press_key') throw Object.assign(new Error('tool_not_registered'), { name: 'CodexToolBridgeError' })
  }
  const out = await executeToolCall('browser_sequence', { steps: [typeStep, keyStep, snapshotStep] }, f.context)
  assert.equal(out.data?.errorKind, 'browser_sequence_step_not_allowed', out.text)
  assert.equal(out.data?.stoppedAt, 2)
  assert.deepEqual(asked, ['browser_type', 'browser_press_key'])
  assert.equal(f.actions.length, 0)
  assert.deepEqual(f.calls, [])
})

test('Q3: dialog, stale page, user attention and wait timeout stop at step 2', async (t) => {
  for (const kind of ['dialog_open', 'browser_reference_stale', 'challenge_required', 'wait_not_matched']) {
    await t.test(kind, async (t) => {
      const f = browserSequenceFixture()
      t.after(() => f.lease.release())
      // The page changes under the sequence once its first step is over.
      f.context.onToolEffectEnd = () => {
        if (kind === 'dialog_open') f.state.dialog = true
        if (kind === 'browser_reference_stale') f.state.physical = 'physical-replaced'
        if (kind === 'challenge_required') f.state.challenge = true
        if (kind === 'wait_not_matched') f.state.matched = false
      }
      const steps = kind === 'wait_not_matched' ? [typeStep, waitStep, typeStep]
        : kind === 'challenge_required' ? [typeStep, readStep]
          : [typeStep, typeStep, snapshotStep]
      const out = await executeToolCall('browser_sequence', { steps }, f.context)
      assert.equal(out.data?.stoppedAt, 2, out.text)
      assert.equal(out.data?.errorKind, kind)
      assert.equal(f.actions.length, 1, 'only the first step acted on the page')
      assert.deepEqual(records(out.data).map(s => [s.step, s.ok, s.errorKind]), [[1, true, undefined], [2, false, kind]])
      assert.equal((out.data?.notExecuted as unknown[]).length, steps.length - 2)
    })
  }
})

test('Q5: a look at the page may only close the sequence; one placed earlier rejects the whole list', async (t) => {
  const f = browserSequenceFixture()
  t.after(() => f.lease.release())
  for (const steps of [[snapshotStep, typeStep], [typeStep, readStep, snapshotStep], [{ tool: 'browser_find', args: { query: 'Save' } }, snapshotStep]]) {
    const out = await executeToolCall('browser_sequence', { steps }, f.context)
    assert.equal(out.data?.errorKind, 'browser_sequence_observation_not_last', out.text)
    assert.deepEqual(records(out.data), [])
    assert.equal((out.data?.notExecuted as unknown[]).length, steps.length)
  }
  assert.equal(f.actions.length, 0)
  assert.equal(f.observations.length, 0, 'no snapshot was taken that the model would never see')
  assert.deepEqual(f.calls, [])

  const read = await executeToolCall('browser_sequence', { steps: [typeStep, waitStep, readStep] }, f.context)
  assert.equal(read.data?.ok, true, read.text)
  assert.deepEqual([(read.data?.observation as { step: number; tool: string }).step, (read.data?.observation as { tool: string }).tool], [3, 'browser_read'])
  assert.match(JSON.stringify((read.data?.observation as { data: unknown }).data), /FINAL SNAPSHOT CONTENT/)
})

test('Q6: readonly admission and observation closure reject sequence just like click', async (t) => {
  const f = browserSequenceFixture()
  t.after(() => f.lease.release())
  const ref = { tabId: 'tab-sequence', physicalTargetToken: f.state.physical, mainFrameDocumentToken: f.state.document }
  const names = composeBrowserAdmissionToolNames(buildBrowserAdmissionAuthoritySnapshot({ authorityId: 'readonly', activeWorkbenchMode: 'document', explicitBrowserReadRefs: [ref] }))
  f.context.allowedToolNames = new Set(names)
  for (const [tool, args] of [['browser_sequence', { steps: [snapshotStep] }], ['browser_click', { text: 'Click' }]] as const) {
    assert.equal((await executeToolCall(tool, args, f.context)).data?.errorKind, 'tool_restricted_this_turn')
  }
  f.context.allowedToolNames = new Set(BROWSER_PUBLIC_TOOL_NAMES)
  f.context.browserObservationClosureActive = true
  for (const [tool, args] of [['browser_sequence', { steps: [snapshotStep] }], ['browser_click', { text: 'Click' }]] as const) {
    assert.equal((await executeToolCall(tool, args, f.context)).data?.errorKind, 'browser_observation_required')
  }
  assert.equal(isCodexBrowserObservationClosureToolName('browser_sequence'), false)
  assert.equal(resolveBrowserCapability('browser_sequence')?.requiresPageLease, false)
  assert.equal(f.actions.length, 0)
})

test('Q7: existing native thread without sequence requires a new context by the unchanged compatibility rule', () => {
  const definitions = BROWSER_PUBLIC_TOOL_NAMES.map(name => {
    const definition = defaultToolRegistry.getToolDefinitionForExecution(name)
    assert.ok(definition)
    return definition
  })
  const current = buildReadyToolSurface({ surfaceId: 'current', toolDefinitions: definitions })
  const frozen = buildReadyToolSurface({ surfaceId: 'frozen', toolDefinitions: definitions.filter(d => d.name !== 'browser_sequence') })
  const result = compareReadyToolSurfaceCompatibility({ frozen, current })
  assert.equal(result.kind, 'native_tool_surface_extension_required')
  assert.deepEqual(result.addedToCurrentSubset, ['browser_sequence'])
})

test('Q3: after a step whose delivery cannot be confirmed, waiting and looking go on and changing the page does not', async (t) => {
  const f = browserSequenceFixture()
  t.after(() => f.lease.release())
  f.state.keyDelivered = null
  const out = await executeToolCall('browser_sequence', { steps: [keyStep, waitStep, typeStep, snapshotStep] }, f.context)
  assert.equal(out.data?.ok, false, out.text)
  assert.equal(out.data?.errorKind, BROWSER_SEQUENCE_UNVERIFIED_ERROR_KIND)
  assert.equal(out.data?.stoppedAt, 3)
  assert.deepEqual(records(out.data).map(s => [s.step, s.tool, s.ok, s.delivery]), [
    [1, 'browser_press_key', true, 'unknown'],
    [2, 'browser_wait', true, undefined],
  ])
  assert.deepEqual(out.data?.notExecuted, [{ step: 3, tool: 'browser_type' }, { step: 4, tool: 'browser_snapshot' }])
  assert.deepEqual(f.calls.filter(call => call === 'type'), [], 'the write after the unconfirmed step never ran')

  const looked = browserSequenceFixture()
  t.after(() => looked.lease.release())
  looked.state.keyDelivered = null
  const closing = await executeToolCall('browser_sequence', { steps: [keyStep, waitStep, snapshotStep] }, looked.context)
  assert.equal(closing.data?.ok, true, closing.text)
  assert.equal((closing.data?.observation as { step: number }).step, 3)
})

test('Q3: a key press that replaces the page is a success, and the steps planned for the new page run', async (t) => {
  const f = browserSequenceFixture()
  t.after(() => f.lease.release())
  // Enter submits: the old document is gone before its delivery can be read back.
  f.state.keyDelivered = null
  const dispatchKey = f.controller.dispatchKey
  f.controller.dispatchKey = async (...args: Parameters<typeof dispatchKey>) => {
    await dispatchKey(...args)
    if ((args[1] as { type: string }).type === 'keyUp') f.state.document = 'document-after-submit'
  }
  const out = await executeToolCall('browser_sequence', { steps: [keyStep, waitStep, typeStep, snapshotStep] }, f.context)
  assert.equal(out.data?.ok, true, out.text)
  assert.deepEqual(records(out.data).map(s => [s.tool, s.ok, s.delivery, s.effect]), [
    ['browser_press_key', true, 'unknown', 'observed'],
    ['browser_wait', true, undefined, undefined],
    ['browser_type', true, 'delivered', 'observed'],
    ['browser_snapshot', true, undefined, undefined],
  ])
  assert.equal((out.data?.observation as { step: number }).step, 4)
})

test('Q6: the sequence declares exactly what its steps can do, and holds no lease of its own', () => {
  const union = new Set(BROWSER_SEQUENCE_STEP_TOOL_NAMES.flatMap(name => browserToolBaseEffects(name)))
  assert.deepEqual([...browserToolBaseEffects('browser_sequence')].sort(), [...union].sort())
  assert.equal(resolveBrowserCapability('browser_sequence')?.mode, 'mutate')
  assert.equal(resolveBrowserCapability('browser_sequence')?.requiresPageLease, false)
  assert.equal(BROWSER_SEQUENCE_STEP_TOOL_NAMES.includes('browser_sequence' as never), false)
})

test('Q8: each successful step proves what the same call would prove alone; a page counts as read only when it came back', () => {
  const now = new Date('2026-11-18T00:00:00.000Z')
  const page = { ok: true, url: 'https://news.example/story', content: '# Story\n\nBody text.' }
  const search = { step: 1, tool: 'browser_search', ok: true, delivery: 'unknown', effect: 'observed', url: 'https://news.example/search?q=story' }
  const click = { step: 2, tool: 'browser_click', ok: true, delivery: 'delivered', effect: 'observed', url: 'https://news.example/story' }
  const finished = createBrowserStructuredOutput({
    ok: true,
    steps: [search, click, { step: 3, tool: 'browser_wait', ok: true }, { step: 4, tool: 'browser_read', ok: true }],
    observation: { step: 4, tool: 'browser_read', data: page },
    notExecuted: [],
  })
  const proofs = collectToolOutputProofs('browser_sequence', finished, now, { runId: 'run-1' })
  assert.deepEqual(proofs.map(proof => [proof.ref, proof.sourceReceipt?.acquisitionKind ?? null, proof.sourceReceipt?.urls ?? null]), [
    ['browser_search', 'discovery', ['https://news.example/search?q=story']],
    ['browser_click', null, null],
    ['browser_wait', null, null],
    ['browser_read', 'content', ['https://news.example/story']],
  ])
  assert.ok(proofs.every(proof => proof.runId === 'run-1'))
  const alone = collectToolOutputProofs('browser_read', createBrowserStructuredOutput(page), now, { runId: 'run-1' })
  assert.deepEqual(alone[0].sourceReceipt?.urls, proofs[3].sourceReceipt?.urls)

  // The sequence stopped before its closing read: the search still happened, nothing was read.
  const stopped = createBrowserStructuredOutput({
    ok: false, errorKind: 'wait_not_matched', message: 'x', stoppedAt: 3,
    steps: [search, click, { step: 3, tool: 'browser_wait', ok: false, errorKind: 'wait_not_matched' }],
    observation: null,
    notExecuted: [{ step: 4, tool: 'browser_read' }],
  })
  assert.deepEqual(collectToolOutputProofs('browser_sequence', stopped, now).map(proof => [proof.ref, proof.sourceReceipt?.acquisitionKind ?? null]), [
    ['browser_search', 'discovery'],
    ['browser_click', null],
  ])
  assert.deepEqual(collectToolOutputProofs('browser_sequence', createBrowserStructuredOutput({ ok: false, errorKind: 'input_validation' }), now), [])
})
