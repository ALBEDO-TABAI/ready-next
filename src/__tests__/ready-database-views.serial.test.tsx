import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { performance } from 'node:perf_hooks'
import { Database } from '../renderer/modules/document/database/Database'
import { databaseFixture } from './utils/database-native-fixture'
import { mountDatabase, settle } from './utils/database-view-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('DB-B performance: indexed 1000-file first screen <500ms; bounded DOM and end-to-end scroll update', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-B view performance')) return
  const f = databaseFixture(1000), ui = await mountDatabase(t)
  t.after(() => f.close())
  // Object identities are indexed, but no database read/query or renderer has been warmed.
  const initialCalls: string[] = []
  const measuredAPI = { ...f.api, request: async (request: Parameters<typeof f.api.request>[0]) => { const start = performance.now(); const reply = await f.api.request(request); initialCalls.push(`${request.type}=${(performance.now() - start).toFixed(1)}ms`); return reply } }
  const first = performance.now()
  await ui.render(<Database databaseId={f.databaseId} api={measuredAPI} initialViewId="table" />)
  const firstMs = performance.now() - first
  assert.ok(ui.host.querySelector('[role="table"]'), ui.host.textContent ?? '')
  assert.ok(ui.host.querySelectorAll('[data-row-id]').length <= 20)
  const readStart = performance.now(); f.service.read(f.databaseId); const readMs = performance.now() - readStart
  const queryStart = performance.now(); f.service.query(f.databaseId, 'table'); const queryMs = performance.now() - queryStart
  await ui.render(null)
  const warmStart = performance.now(); await ui.render(<Database databaseId={f.databaseId} api={measuredAPI} initialViewId="table" />); const warmMs = performance.now() - warmStart
  const viewport = ui.host.querySelector<HTMLElement>('[data-testid="table-scroll"]')!
  const measurements: number[] = []
  for (const index of [300, 600, 900, 980]) {
    const started = performance.now()
    await act(async () => { viewport.scrollTop = index * 36; viewport.dispatchEvent(new ui.dom.window.Event('scroll', { bubbles: true })) })
    measurements.push(performance.now() - started)
    const rowIndices = [...ui.host.querySelectorAll('[aria-rowindex]')].map(row => Number(row.getAttribute('aria-rowindex')))
    assert.ok(rowIndices.some(value => value >= index + 2))
    assert.ok(rowIndices.length <= 20)
  }
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
  await settle(ui)
  const state = await f.service.request({ type: 'getState', databaseId: f.databaseId })
  assert.deepEqual(state.scroll, { x: 0, y: 980 * 36 })
  console.log(`DB-B PERFORMANCE files=1000 first-screen=${firstMs.toFixed(1)}ms first-calls=[${initialCalls.slice(0, 3).join(",")}] hot-read=${readMs.toFixed(1)}ms hot-query=${queryMs.toFixed(1)}ms warm-screen=${warmMs.toFixed(1)}ms scroll-commits=${measurements.map(ms => ms.toFixed(1)).join(',')}ms DOM-rows=${ui.host.querySelectorAll('[data-row-id]').length}; JSDOM excludes layout/paint and Electron IPC`)
  assert.ok(firstMs < 500, `Indexed 1000-row first screen took ${firstMs.toFixed(1)}ms; warm=${warmMs.toFixed(1)}ms, Main read=${readMs.toFixed(1)}ms, query=${queryMs.toFixed(1)}ms`)
})
