/**
 * P0-2 — 本地文档过滤器必须保留技能地板；收窄管线末端不得为空。
 * 母合同：2026-07-06 skill-envelope §4 T2/T3。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  selectedSkillFloorToolNames,
  recoverEmptyToolSurface,
  isLocalDocumentToolDefinition,
  narrowToolSurfaceForLocalDocument,
  shouldPreserveTaskIntentToolDuringDocumentNarrowing,
} from '../main/modules/agent-control/runtime-core/agent-sdk-utils'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('skill-doc-toolset-floor declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'skill-doc-toolset-floor transitive sqlite guard')
})

const def = (name: string, domain: string) => ({ name, domain }) as never

test('selectedSkillFloorToolNames returns primitives+typed actions for selected, empty for none', () => {
  const selected = buildSelectedSkillToolAuthorization({
    skillId: 'ready-human-touch-ppt',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact', 'skill_write_artifact', 'skill_export_artifact', 'skill_run_shell'],
    source: 'explicit',
    reason: 'test',
  })
  const floor = selectedSkillFloorToolNames(selected)
  assert.ok(floor.has('skill_read_artifact') && floor.has('skill_run_shell'))
  assert.equal(selectedSkillFloorToolNames({ mode: 'none', reason: 'no_skill_signal' }).size, 0)
})

test('local-document narrowing keeps skill floor members (D2 regression)', () => {
  const selected = buildSelectedSkillToolAuthorization({
    skillId: 'ready-human-touch-ppt',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact', 'skill_write_artifact'],
    source: 'explicit',
    reason: 'test',
  })
  const floor = selectedSkillFloorToolNames(selected)
  const surface = [def('skill_read_artifact', 'skill'), def('skill_write_artifact', 'skill'), def('browser_navigate', 'browser')]
  const narrowed = surface.filter(
    (d: { name: string }) => isLocalDocumentToolDefinition(d as never) || floor.has(d.name),
  )
  assert.deepEqual(narrowed.map((d: { name: string }) => d.name), ['skill_read_artifact', 'skill_write_artifact'])
})

test('recoverEmptyToolSurface restores pre-narrowing surface only when narrowed is empty', () => {
  const pre = [def('file_read_excerpt', 'file')]
  assert.deepEqual(recoverEmptyToolSurface([], pre), { definitions: pre, recovered: true })
  const kept = [def('skill_read_artifact', 'skill')]
  assert.deepEqual(recoverEmptyToolSurface(kept, pre), { definitions: kept, recovered: false })
  assert.deepEqual(recoverEmptyToolSurface([], []), { definitions: [], recovered: false })
})

// The following tests drive the REAL narrowToolSurfaceForLocalDocument — the exact function
// the orchestrator calls — with load-bearing fixtures (a browser tool that MUST be dropped,
// an empty-inducing surface that MUST trigger recovery). A regression to the narrowing logic
// (dropping the skill floor) or to the recovery would fail these, unlike a re-implementation.

test('narrowToolSurfaceForLocalDocument drops non-floor non-document tools and keeps skill floor + document tools (load-bearing)', () => {
  const selected = buildSelectedSkillToolAuthorization({
    skillId: 'ready-human-touch-ppt',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact', 'skill_write_artifact'],
    source: 'explicit',
    reason: 'test',
  })
  const surface = [
    def('skill_read_artifact', 'skill'),
    def('skill_write_artifact', 'skill'),
    def('file_read_excerpt', 'file'),
    def('browser_navigate', 'browser'), // must be dropped: non-floor, non-document
    def('browser_collect', 'browser'), // must be dropped: write-classified collection tool
  ]
  const narrowed = narrowToolSurfaceForLocalDocument(surface as never, selected).map((d: { name: string }) => d.name)
  assert.deepEqual(narrowed, ['skill_read_artifact', 'skill_write_artifact', 'file_read_excerpt'])
  assert.equal(narrowed.includes('browser_navigate'), false)
  assert.equal(narrowed.includes('browser_collect'), false)
})

test('research capability and completion declaration survive incidental current-document narrowing', () => {
  const selected = buildSelectedSkillToolAuthorization({
    skillId: 'deep-research',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_write_artifact', 'skill_export_artifact'],
    source: 'explicit',
    reason: 'test',
  })
  const surface = [
    { name: 'document_read_section', domain: 'document', groupId: 'document' },
    { name: 'skill_write_artifact', domain: 'skill', groupId: 'skills' },
    { name: 'skill_export_artifact', domain: 'skill', groupId: 'skills' },
    { name: 'web_search', domain: 'research', groupId: 'general_research' },
    { name: 'web_fetch', domain: 'research', groupId: 'general_research' },
    { name: 'browser_collect', domain: 'browser', groupId: 'browser_interaction' },
    { name: 'declare_completion_criteria', domain: 'agent', groupId: 'agent_interaction' },
    { name: 'pet_set_note', domain: 'pet', groupId: 'pet' },
  ]
  const narrowed = narrowToolSurfaceForLocalDocument(surface as never, selected, {
    preserveDefinition: shouldPreserveTaskIntentToolDuringDocumentNarrowing,
  }).map((entry: { name: string }) => entry.name)

  for (const required of [
    'document_read_section',
    'skill_write_artifact',
    'skill_export_artifact',
    'web_search',
    'web_fetch',
    'browser_collect',
    'declare_completion_criteria',
  ]) {
    assert.ok(narrowed.includes(required), `${required} must survive the mixed research/document turn`)
  }
  assert.equal(narrowed.includes('pet_set_note'), false)
})

test('narrowToolSurfaceForLocalDocument on a none-mode turn keeps only document tools, never skill/browser (no primitive leak)', () => {
  const narrowed = narrowToolSurfaceForLocalDocument(
    [
      def('skill_read_artifact', 'skill'),
      def('browser_navigate', 'browser'),
      def('file_read_excerpt', 'file'),
      def('document_read_section', 'document'),
    ] as never,
    { mode: 'none', reason: 'no_skill_signal' },
  ).map((d: { name: string }) => d.name)
  assert.deepEqual(narrowed, ['file_read_excerpt', 'document_read_section'])
})

test('narrowToolSurfaceForLocalDocument emptying a pure-browser surface triggers recovery (recovered=true)', () => {
  const selected = buildSelectedSkillToolAuthorization({
    skillId: 'ready-human-touch-ppt',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact'],
    source: 'explicit',
    reason: 'test',
  })
  // A pure-browser surface carries neither a document tool nor the skill floor member → narrows to empty.
  const pre = [def('browser_navigate', 'browser'), def('browser_collect', 'browser')]
  const narrowed = narrowToolSurfaceForLocalDocument(pre as never, selected)
  assert.equal(narrowed.length, 0, 'pure-browser surface narrows to empty under local-document narrowing')
  const recovery = recoverEmptyToolSurface(narrowed, pre)
  assert.equal(recovery.recovered, true)
  assert.deepEqual(
    recovery.definitions.map((d) => (d as { name: string }).name),
    ['browser_navigate', 'browser_collect'],
  )
})
