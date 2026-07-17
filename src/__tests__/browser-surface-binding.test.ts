import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isBrowserBackgroundHandoffTool,
  resolveBrowserToolSurfaceBinding,
} from '../main/modules/browser-engine/browser-surface-binding'

test('browser surface binding maps reads to read-only-observe without an engine write surface', () => {
  const result = resolveBrowserToolSurfaceBinding({
    toolName: 'browser_read',
    dispatch: 'tool-executor',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.binding.effect, 'read')
  assert.equal(result.binding.intent, 'read-only-observe')
  assert.equal(result.binding.engineSurface, null)
  assert.equal(result.binding.requiresTurnLease, false)
})

test('browser surface binding rejects tool-executor writes without a turn lease', () => {
  const result = resolveBrowserToolSurfaceBinding({
    toolName: 'browser_navigate',
    args: { action: 'back' },
    dispatch: 'tool-executor',
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.errorCode, 'browser_surface_undeclared')
})

test('browser surface binding maps foreground writes to user-view-assisted', () => {
  const result = resolveBrowserToolSurfaceBinding({
    toolName: 'browser_navigate',
    args: { action: 'back' },
    dispatch: 'tool-executor',
    hasTurnLease: true,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.binding.intent, 'user-view-assisted')
  assert.equal(result.binding.engineSurface, 'user-view')
  assert.equal(result.binding.requiresTurnLease, true)
})

test('browser surface binding marks collect_notes as an agent-view background handoff', () => {
  const result = resolveBrowserToolSurfaceBinding({
    toolName: 'browser_collect',
    args: { mode: 'notes' },
    dispatch: 'tool-executor',
    hasTurnLease: true,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(isBrowserBackgroundHandoffTool('browser_collect', { mode: 'notes' }), true)
  assert.equal(result.binding.backgroundHandoff, true)
  assert.equal(result.binding.intent, 'agent-view-background')
  assert.equal(result.binding.engineSurface, 'agent-view')
})

test('scoped facade agent-view writes require an agent tab id', () => {
  const result = resolveBrowserToolSurfaceBinding({
    toolName: 'browser_navigate',
    dispatch: 'scoped-facade',
    scopedSurface: 'agent-view',
    agentTabId: '',
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.errorCode, 'browser_surface_binding_violation')
})

test('scoped facade defaults concrete agent tab writes to agent-view-background', () => {
  const result = resolveBrowserToolSurfaceBinding({
    toolName: 'browser_navigate',
    dispatch: 'scoped-facade',
    agentTabId: 'agent-tab-1',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.binding.intent, 'agent-view-background')
  assert.equal(result.binding.engineSurface, 'agent-view')
  assert.equal(result.binding.requiresTurnLease, false)
})

test('browser-agent-runner declares user-view-assisted workflow binding', () => {
  const result = resolveBrowserToolSurfaceBinding({
    toolName: 'browser_click',
    dispatch: 'browser-agent-runner',
    hasRunnerLeaseGate: true,
    boundSurface: 'user-view',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.binding.intent, 'user-view-assisted')
  assert.equal(result.binding.engineSurface, 'user-view')
})

test('browser-agent-runner declares agent-view foreground workflow binding', () => {
  const result = resolveBrowserToolSurfaceBinding({
    toolName: 'browser_click',
    dispatch: 'browser-agent-runner',
    hasRunnerLeaseGate: true,
    boundSurface: 'agent-view',
    agentTabId: 'agent-tab-1',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.binding.intent, 'agent-view-foreground')
  assert.equal(result.binding.engineSurface, 'agent-view')
  assert.equal(result.binding.requiresTurnLease, true)
})

test('browser-agent-runner agent-view writes require a bound agent tab', () => {
  const result = resolveBrowserToolSurfaceBinding({
    toolName: 'browser_click',
    dispatch: 'browser-agent-runner',
    hasRunnerLeaseGate: true,
    boundSurface: 'agent-view',
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.errorCode, 'browser_surface_binding_violation')
})

test('browser-agent-runner writes require the runner lease gate at each tool call', () => {
  const result = resolveBrowserToolSurfaceBinding({
    toolName: 'browser_click',
    dispatch: 'browser-agent-runner',
    hasRunnerLeaseGate: false,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.errorCode, 'browser_surface_undeclared')
})
