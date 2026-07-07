'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const { check } = require('../check-overlay-command-group-parity.cjs')

const PROTOCOL = 'src/shared/browser-vertical-rail-overlay.ts'
const RAIL = 'src/renderer/components/browser/VerticalTabRail.tsx'

const GROUP_CMDS = [
  'reorder', 'create-group', 'add-to-group', 'remove-from-group', 'rename-group',
  'recolor-group', 'set-group-collapsed', 'disband-group', 'delete-group', 'new-tab-in-group',
]

function protocolUnion(commands) {
  const variants = commands
    .map((type) => {
      if (type === 'reorder') return `  | { type: 'reorder'; movedTabId: string; toRank: number; intoGroupId: string | null }`
      return `  | { type: '${type}'; x?: string }`
    })
    .join('\n')
  return `export type VerticalRailOverlayCommand =\n${variants}\n`
}

function railSwitch(cases) {
  const body = cases.map((type) => `        case '${type}':\n          break`).join('\n')
  return `export default function VerticalTabRail() {\n  const buildSnapshot = () => null\n  function handle(command) {\n    switch (command.type) {\n${body}\n    }\n  }\n}\n`
}

function writeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'ready-overlay-parity-gate-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

test('parity gate passes the current workspace', () => {
  assert.equal(check().ok, true, check().errors.join('\n'))
})

test('passes a synthetic all-correct fixture', () => {
  const all = ['hover-enter', 'switch', 'close', 'new-tab', 'toggle-bookmark', 'reference', ...GROUP_CMDS]
  const root = writeFixture({ [PROTOCOL]: protocolUnion(all), [RAIL]: railSwitch(all) })
  assert.equal(check({ root }).ok, true, check({ root }).errors.join('\n'))
})

test('rejects a group command with no handler in the switch', () => {
  const all = ['switch', ...GROUP_CMDS]
  const root = writeFixture({
    [PROTOCOL]: protocolUnion(all),
    [RAIL]: railSwitch(all.filter((t) => t !== 'delete-group')), // handler dropped
  })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(errors.includes('command_without_handler:delete-group'))
})

test('rejects an index-based reorder (D-CMD retired {fromIndex,toIndex})', () => {
  const union = `export type VerticalRailOverlayCommand =\n  | { type: 'reorder'; fromIndex: number; toIndex: number }\n`
  const root = writeFixture({ [PROTOCOL]: union, [RAIL]: railSwitch(['reorder']) })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(errors.includes('reorder_still_index_based'))
  assert.ok(errors.includes('reorder_not_id_based'))
})

test('fail-closed when the command union is missing', () => {
  const root = writeFixture({ [PROTOCOL]: 'export const nothing = 1', [RAIL]: railSwitch(['switch']) })
  const { ok, errors } = check({ root })
  assert.equal(ok, false)
  assert.ok(errors.includes('command_union_not_found'))
})
