import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_CURRENT_PAGE_TOOL_NAMES,
  BROWSER_EXPLICIT_READ_TOOL_NAMES,
} from '../main/modules/agent-control/codex-runtime/codex-browser-admission'
import {
  assertReadyCapabilityCatalogInvariants,
  BROWSER_CURRENT_ACT_TOOL_NAMES,
  BROWSER_CURRENT_READ_TOOL_NAMES,
  readyCapabilityCatalogDigest,
  readyCapabilityGroups,
  readyCapabilityToolOwner,
  READY_DEFERRED_BROWSER_TOOLS,
} from '../main/modules/agent-control/codex-runtime/codex-capability-catalog'

test('capability catalog is stable, exclusive, and keeps observe-only reads', () => {
  assertReadyCapabilityCatalogInvariants()
  const first = readyCapabilityGroups()
  const second = readyCapabilityGroups()
  assert.equal(readyCapabilityCatalogDigest(), readyCapabilityCatalogDigest())
  assert.deepEqual(first, second)
  assert.deepEqual([...BROWSER_CURRENT_READ_TOOL_NAMES], [...BROWSER_EXPLICIT_READ_TOOL_NAMES])
  const owner = readyCapabilityToolOwner()
  assert.equal(owner.browser_research, undefined)
  assert.equal(owner.web_search, 'public_research')
  assert.equal(owner.browser_click, 'browser_current_act')
  assert.equal(owner.browser_dialog, 'browser_current_act')
  assert.equal(owner.browser_collect, 'browser_current_act')
  assert.equal(owner.calendar_list_window, 'calendar_read')
  assert.equal(owner.calendar_create_event, 'calendar_write')
  const act = new Set(BROWSER_CURRENT_ACT_TOOL_NAMES)
  const read = new Set(BROWSER_CURRENT_READ_TOOL_NAMES)
  for (const name of act) assert.equal(read.has(name), false)
  assert.equal(act.has('browser_research'), false)
  const remainder = BROWSER_CURRENT_PAGE_TOOL_NAMES.filter(
    (name) => name !== 'browser_research' && !read.has(name),
  )
  assert.deepEqual([...remainder].sort(), [...act].sort())
  assert.equal(READY_DEFERRED_BROWSER_TOOLS.size, 16)
  assert.equal(READY_DEFERRED_BROWSER_TOOLS.has('browser_click'), false)
  assert.equal(READY_DEFERRED_BROWSER_TOOLS.has('browser_cdp'), true)
  assert.equal(first.find((group) => group.id === 'public_research')?.loading, 'always')
  assert.equal(first.find((group) => group.id === 'calendar_read')?.loading, 'always')
})
