/**
 * Stage U PR U0.4 — phase-smoke-runner meta tests.
 *
 * Validates the runner's routing (which smokes for which phase), graceful
 * skip behaviour, and the per-smoke shape contracts. These are behaviour
 * tests against the real CommonJS module — no source grep. The runner's
 * smokes themselves are flow-connectivity checks; this meta-test exercises
 * the dispatcher invariants the gate depends on.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')
const require = createRequire(import.meta.url)

interface SmokeOutcome {
  ok: boolean
  reason?: string
  info?: string
}

interface RunnerModule {
  parseArgs: (argv: string[]) => { phase: number | null; json: boolean; help?: boolean }
  runPhase: (phase: number, opts?: { json?: boolean }) => Promise<number>
  smokesForPhase: (phase: number) => string[]
  isElectronEnvAvailable: () => boolean
  runBrowserSmoke: () => SmokeOutcome | Promise<SmokeOutcome>
  runAgentSmoke: () => Promise<SmokeOutcome>
  runSettingsSmoke: () => Promise<SmokeOutcome>
  SUPPORTED_PHASES: number[]
}

interface GateModule {
  collectLabels: (env: NodeJS.ProcessEnv) => string[]
  extractPhases: (labels: string[]) => number[]
  PHASE_LABEL_REGEX: RegExp
}

const runner = require(path.join(REPO_ROOT, 'scripts/phase-smoke-runner.cjs')) as RunnerModule
const gate = require(path.join(REPO_ROOT, 'scripts/check-phase-smoke-gate.cjs')) as GateModule

describe('phase-smoke-runner CLI parsing', () => {
  it('parses --phase as integer', () => {
    const opts = runner.parseArgs(['--phase', '3'])
    assert.equal(opts.phase, 3)
    assert.equal(opts.json, false)
  })

  it('parses --json flag', () => {
    const opts = runner.parseArgs(['--phase', '0', '--json'])
    assert.equal(opts.json, true)
  })

  it('rejects unknown arguments', () => {
    assert.throws(() => runner.parseArgs(['--bogus']), /Unknown argument/)
  })

  it('rejects non-integer --phase', () => {
    assert.throws(() => runner.parseArgs(['--phase', 'abc']), /expects an integer/)
  })
})

describe('phase-smoke-runner phase routing', () => {
  it('supports phases 0 through 8 (Stage U §9)', () => {
    assert.deepEqual([...runner.SUPPORTED_PHASES].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('returns the 3 baseline smokes for every supported phase', () => {
    for (const phase of runner.SUPPORTED_PHASES) {
      const smokes = runner.smokesForPhase(phase)
      assert.deepEqual(smokes, ['browser', 'agent', 'settings'], `phase ${phase} smokes`)
    }
  })

  it('returns an empty list for unsupported phases', () => {
    assert.deepEqual(runner.smokesForPhase(-1), [])
    assert.deepEqual(runner.smokesForPhase(9), [])
    assert.deepEqual(runner.smokesForPhase(99), [])
  })
})

describe('phase-smoke-runner individual smokes', () => {
  it('browser smoke verifies the BrowserView IPC surface is wired', async () => {
    const result = await runner.runBrowserSmoke()
    assert.equal(result.ok, true, `browser smoke should pass: ${result.reason}`)
    assert.match(String(result.info), /createTab/)
  })

  it('agent smoke resolves to a done close event', async () => {
    const result = await runner.runAgentSmoke()
    assert.equal(result.ok, true, `agent smoke should pass: ${result.reason}`)
  })

  it('settings smoke round-trips a provider workspace', async () => {
    const result = await runner.runSettingsSmoke()
    assert.equal(result.ok, true, `settings smoke should pass: ${result.reason}`)
  })
})

describe('phase-smoke-runner graceful skip', () => {
  it('runPhase returns 0 when READY_PHASE_SMOKE_SKIP=1 (electron-dependent smokes skip)', async () => {
    const prev = process.env.READY_PHASE_SMOKE_SKIP
    process.env.READY_PHASE_SMOKE_SKIP = '1'
    try {
      const code = await runner.runPhase(0, { json: true })
      assert.equal(code, 0, 'graceful skip must exit 0')
      assert.equal(runner.isElectronEnvAvailable(), false, 'env must report unavailable when forced skip')
    } finally {
      if (prev == null) delete process.env.READY_PHASE_SMOKE_SKIP
      else process.env.READY_PHASE_SMOKE_SKIP = prev
    }
  })

  it('runPhase returns 2 for unsupported phase', async () => {
    const code = await runner.runPhase(99, { json: true })
    assert.equal(code, 2)
  })

  it('READY_PHASE_SMOKE_FORCE=1 forces electron-dependent smokes to run', async () => {
    const prev = process.env.READY_PHASE_SMOKE_FORCE
    process.env.READY_PHASE_SMOKE_FORCE = '1'
    try {
      assert.equal(runner.isElectronEnvAvailable(), true, 'force flag must override absence checks')
    } finally {
      if (prev == null) delete process.env.READY_PHASE_SMOKE_FORCE
      else process.env.READY_PHASE_SMOKE_FORCE = prev
    }
  })
})

describe('check-phase-smoke-gate label parsing', () => {
  it('detects phase labels from GITHUB_PR_LABELS JSON array', () => {
    const labels = gate.collectLabels({ GITHUB_PR_LABELS: JSON.stringify(['phase:3', 'other']) })
    assert.deepEqual(gate.extractPhases(labels), [3])
  })

  it('detects phase labels from GITHUB_PR_LABELS object array (gh api shape)', () => {
    const labels = gate.collectLabels({
      GITHUB_PR_LABELS: JSON.stringify([{ name: 'phase:5' }, { name: 'noise' }]),
    })
    assert.deepEqual(gate.extractPhases(labels), [5])
  })

  it('detects phase labels from comma-separated GITHUB_PR_LABELS', () => {
    const labels = gate.collectLabels({ GITHUB_PR_LABELS: 'phase:0, ready, phase:7' })
    assert.deepEqual(gate.extractPhases(labels), [0, 7])
  })

  it('detects phase label from STAGE_U_PHASE_LABEL env', () => {
    const labels = gate.collectLabels({ STAGE_U_PHASE_LABEL: 'phase:2' })
    assert.deepEqual(gate.extractPhases(labels), [2])
  })

  it('ignores non-phase labels', () => {
    const labels = gate.collectLabels({ GITHUB_PR_LABELS: 'release, blocked, phase:abc' })
    assert.deepEqual(gate.extractPhases(labels), [])
  })

  it('PHASE_LABEL_REGEX only matches phase:0-8', () => {
    for (let i = 0; i <= 8; i += 1) {
      assert.match(`phase:${i}`, gate.PHASE_LABEL_REGEX)
    }
    assert.doesNotMatch('phase:9', gate.PHASE_LABEL_REGEX)
    assert.doesNotMatch('phase:10', gate.PHASE_LABEL_REGEX)
    assert.doesNotMatch('Phase:1', gate.PHASE_LABEL_REGEX)
    assert.doesNotMatch('phase-1', gate.PHASE_LABEL_REGEX)
  })

  it('returns no labels when neither env is set', () => {
    const labels = gate.collectLabels({})
    assert.deepEqual(gate.extractPhases(labels), [])
  })
})
