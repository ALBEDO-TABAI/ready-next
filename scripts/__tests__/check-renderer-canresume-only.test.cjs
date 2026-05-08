/**
 * Stage Q (Stage 11) — gate behavior tests for check-renderer-canresume-only.cjs.
 *
 * Pin that the gate (a) passes on the real repo, (b) fails when a
 * fixture has resumableActions.includes('continue') without an
 * adjacent canResume gate, (c) passes with the gate present, (d) does
 * NOT false-positive on string-literal mentions.
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-renderer-canresume-only.cjs')

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
}

function makeFixture(filesByPath) {
  const root = mkdtempSync(join(tmpdir(), 'ready-q-rco-gate-'))
  for (const [rel, body] of Object.entries(filesByPath)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

test('positive: real repo passes', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
})

test('negative: continue button without canResume gate fails', () => {
  const root = makeFixture({
    'src/renderer/components/agent/ChatPanel.tsx': [
      'import React from "react"',
      'export function ChatPanel({ run }: { run: any }) {',
      '  return (',
      '    <div>',
      '      {(run.resumableActions || []).includes("continue") && (',
      '        <button onClick={() => continueIt()}>继续</button>',
      '      )}',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /resumableActions includes\("continue"\|"retry"\) without adjacent canResume gate/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: continue button WITH canResume gate passes', () => {
  const root = makeFixture({
    'src/renderer/components/agent/ChatPanel.tsx': [
      'import React from "react"',
      'export function ChatPanel({ run }: { run: any }) {',
      '  return (',
      '    <div>',
      '      {run.canResume === true && (run.resumableActions || []).includes("continue") && (',
      '        <button onClick={() => continueIt()}>继续</button>',
      '      )}',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: retry button WITH canResume gate passes', () => {
  const root = makeFixture({
    'src/renderer/modules/agent/taskCardViewModel.ts': [
      'export function deriveTaskCardRuntimeState(run: any) {',
      '  const actions = run.resumableActions',
      '  // gateActionsByCanResume strips retry when canResume !== true',
      '  return gateActionsByCanResume(actions.filter(a => a === "retry"), run.canResume)',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: retry button without canResume fails', () => {
  const root = makeFixture({
    'src/renderer/components/agent/ChatPanel.tsx': [
      'import React from "react"',
      'export function ChatPanel({ run }: { run: any }) {',
      '  return (',
      '    <div>',
      '      {(run.resumableActions || []).includes("retry") && (',
      '        <button onClick={() => retry()}>重试</button>',
      '      )}',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /retry/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: comment mentioning continue does NOT trigger', () => {
  const root = makeFixture({
    'src/renderer/components/agent/ChatPanel.tsx': [
      'import React from "react"',
      '// Note: resumableActions.includes("continue") would render a button',
      '/* see resumableActions.includes("retry") in the gate */',
      'export function ChatPanel() { return null }',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: cancel-only includes() does NOT trigger', () => {
  const root = makeFixture({
    'src/renderer/components/agent/ChatPanel.tsx': [
      'import React from "react"',
      'export function ChatPanel({ run }: { run: any }) {',
      '  return (',
      '    <div>',
      '      {(run.resumableActions || []).includes("cancel") && (',
      '        <button>取消</button>',
      '      )}',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    // cancel is allowed without canResume gate
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
