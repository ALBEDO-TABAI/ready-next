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
} from '../main/modules/agent-control/runtime-core/agent-sdk-utils'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'

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
