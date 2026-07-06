/**
 * P1-3 — computeCapabilityFloors 三输入正交矩阵（selected × doc-resource × doc-context = 8 case）。
 * 母合同：2026-07-06 skill-envelope §4 T2。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { computeCapabilityFloors, enforceCapabilityFloors, recoverAbsentFloorsFromRegistry } from '../main/modules/agent-control/domain-adapters/capability-floors'
import { buildSelectedSkillToolAuthorization, buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'

const selected = buildSelectedSkillToolAuthorization({
  skillId: 'ready-human-touch-ppt',
  allowedTypedActions: ['skill_make_ppt'],
  allowedPrimitives: ['skill_read_artifact', 'skill_run_shell'],
  source: 'explicit',
  reason: 'test',
})
const none = buildExplicitNoSkillAuthorization('no_skill_signal')

test('computeCapabilityFloors: none turn with no resources → empty floor', () => {
  const floors = computeCapabilityFloors({ authorization: none, hasLocalDocumentResource: false, hasCurrentDocumentContext: false })
  assert.equal(floors.toolNames.size, 0)
  assert.deepEqual(floors.reasons, [])
})

test('computeCapabilityFloors: selected floors typed actions ∪ primitives (never skill on none)', () => {
  const floors = computeCapabilityFloors({ authorization: selected, hasLocalDocumentResource: false, hasCurrentDocumentContext: false })
  assert.deepEqual([...floors.toolNames].sort(), ['skill_make_ppt', 'skill_read_artifact', 'skill_run_shell'])
  assert.ok(floors.reasons.includes('skill_selected:ready-human-touch-ppt'))
  // none turn must never carry a skill floor member
  const noneFloors = computeCapabilityFloors({ authorization: none, hasLocalDocumentResource: true, hasCurrentDocumentContext: true })
  assert.equal([...noneFloors.toolNames].some((n) => n.startsWith('skill_')), false)
})

test('computeCapabilityFloors: local document resource floors file_locate + file_read_excerpt (not document_read_section)', () => {
  const floors = computeCapabilityFloors({ authorization: none, hasLocalDocumentResource: true, hasCurrentDocumentContext: false })
  assert.deepEqual([...floors.toolNames].sort(), ['file_locate', 'file_read_excerpt'])
  assert.equal(floors.toolNames.has('document_read_section'), false)
  assert.ok(floors.reasons.includes('local_document_resource'))
})

test('computeCapabilityFloors: current document context floors document_read_section', () => {
  const floors = computeCapabilityFloors({ authorization: none, hasLocalDocumentResource: false, hasCurrentDocumentContext: true })
  assert.deepEqual([...floors.toolNames], ['document_read_section'])
  assert.ok(floors.reasons.includes('current_document_context'))
})

test('computeCapabilityFloors: full union (selected + doc resource + doc context)', () => {
  const floors = computeCapabilityFloors({ authorization: selected, hasLocalDocumentResource: true, hasCurrentDocumentContext: true })
  assert.deepEqual(
    [...floors.toolNames].sort(),
    ['document_read_section', 'file_locate', 'file_read_excerpt', 'skill_make_ppt', 'skill_read_artifact', 'skill_run_shell'],
  )
  assert.deepEqual(floors.reasons, ['skill_selected:ready-human-touch-ppt', 'local_document_resource', 'current_document_context'])
})

test('computeCapabilityFloors: selected + doc resource, no doc context (P0-4 fixture shape)', () => {
  const floors = computeCapabilityFloors({ authorization: selected, hasLocalDocumentResource: true, hasCurrentDocumentContext: false })
  assert.deepEqual(
    [...floors.toolNames].sort(),
    ['file_locate', 'file_read_excerpt', 'skill_make_ppt', 'skill_read_artifact', 'skill_run_shell'],
  )
  assert.equal(floors.toolNames.has('document_read_section'), false)
})

test('enforceCapabilityFloors adds back missing floor tools from the pre-narrowing surface and reports them', () => {
  const floors = computeCapabilityFloors({ authorization: selected, hasLocalDocumentResource: true, hasCurrentDocumentContext: false })
  const preNarrowing = [
    { name: 'skill_read_artifact' }, { name: 'skill_run_shell' }, { name: 'skill_make_ppt' },
    { name: 'file_locate' }, { name: 'file_read_excerpt' }, { name: 'browser_navigate' },
  ]
  const narrowed = [{ name: 'skill_read_artifact' }] // a downstream filter dropped every other floor member
  const result = enforceCapabilityFloors(narrowed, floors, preNarrowing)
  assert.deepEqual(result.missing.sort(), ['file_locate', 'file_read_excerpt', 'skill_make_ppt', 'skill_run_shell'])
  assert.deepEqual(
    result.definitions.map((d) => d.name).sort(),
    ['file_locate', 'file_read_excerpt', 'skill_make_ppt', 'skill_read_artifact', 'skill_run_shell'],
  )
})

test('enforceCapabilityFloors is a no-op when the surface already covers the floor', () => {
  const floors = computeCapabilityFloors({ authorization: none, hasLocalDocumentResource: true, hasCurrentDocumentContext: false })
  const surface = [{ name: 'file_locate' }, { name: 'file_read_excerpt' }, { name: 'browser_navigate' }]
  const result = enforceCapabilityFloors(surface, floors, [])
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.definitions.map((d) => d.name), ['file_locate', 'file_read_excerpt', 'browser_navigate'])
})

test('enforceCapabilityFloors still reports a floor tool that cannot be recovered', () => {
  const floors = computeCapabilityFloors({ authorization: none, hasLocalDocumentResource: true, hasCurrentDocumentContext: false })
  const result = enforceCapabilityFloors([{ name: 'file_locate' }], floors, []) // file_read_excerpt not in recoverFrom
  assert.deepEqual(result.missing, ['file_read_excerpt'])
  assert.deepEqual(result.definitions.map((d) => d.name), ['file_locate'])
})

// recoverAbsentFloorsFromRegistry isolates the executor hard-floor loop: recovering a floor tool that
// is ABSENT from the surface (group-invisible / intent-suppressed) — the unique job the preserve
// predicate cannot do. A live registry always exposes file_management, so this is only testable here.
test('recoverAbsentFloorsFromRegistry adds an absent floor tool from the registry', () => {
  const floors = computeCapabilityFloors({ authorization: none, hasLocalDocumentResource: true, hasCurrentDocumentContext: false })
  const surface = [{ name: 'browser_navigate' }] // file floor tools absent (group suppressed)
  const registry: Record<string, { name: string }> = { file_locate: { name: 'file_locate' }, file_read_excerpt: { name: 'file_read_excerpt' } }
  const result = recoverAbsentFloorsFromRegistry(surface, floors, (n) => registry[n] ?? null)
  assert.deepEqual(result.definitions.map((d) => d.name).sort(), ['browser_navigate', 'file_locate', 'file_read_excerpt'])
  assert.deepEqual(result.unavailable, [])
})

test('recoverAbsentFloorsFromRegistry reports a floor tool the registry cannot resolve and does not add it', () => {
  const floors = computeCapabilityFloors({ authorization: none, hasLocalDocumentResource: true, hasCurrentDocumentContext: false })
  const surface = [{ name: 'file_locate' }] // file_read_excerpt absent, registry returns null for it
  const result = recoverAbsentFloorsFromRegistry(surface, floors, (n) => (n === 'file_locate' ? { name: n } : null))
  assert.deepEqual(result.definitions.map((d) => d.name), ['file_locate'])
  assert.deepEqual(result.unavailable, ['file_read_excerpt'])
})

test('recoverAbsentFloorsFromRegistry is a no-op when floor tools are already present', () => {
  const floors = computeCapabilityFloors({ authorization: none, hasLocalDocumentResource: true, hasCurrentDocumentContext: false })
  const surface = [{ name: 'file_locate' }, { name: 'file_read_excerpt' }, { name: 'browser_navigate' }]
  let resolveCalls = 0
  const result = recoverAbsentFloorsFromRegistry(surface, floors, (n) => { resolveCalls += 1; return { name: n } })
  assert.equal(resolveCalls, 0)
  assert.deepEqual(result.definitions.map((d) => d.name), ['file_locate', 'file_read_excerpt', 'browser_navigate'])
  assert.deepEqual(result.unavailable, [])
})
