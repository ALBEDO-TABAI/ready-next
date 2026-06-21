'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-suspend-run-finalize-semantics.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suspend-run-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(rootDir, rel, body) {
  const p = path.join(rootDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

function writeSharedHarness(root) {
  writeFile(root, 'src/main/modules/agent-control/runtime-core/orchestrator.ts', `
export class ReadyAgentOrchestrator {
  kill(agent: string, sessionId?: string): void {
    const taskKey = ''
    this.stopActiveGeneration(agent, sessionId, 'user_stop')
    this.sessions.setState(taskKey, 'cancelled')
  }
  interruptForSuspend(agent: string, sessionId?: string) {
    return this.stopActiveGeneration(agent, sessionId, 'manual_suspend')
  }
}
`)
  writeFile(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts', `
export class AgentSdkRuntime {
  async sendMessage() {
    if (abortInitiator === 'manual_suspend') {
      return this.buildResult({
        success: true,
        terminalReason,
        taskBudgetRuntime,
      })
    }
  }
}
`)
  writeFile(root, 'src/main/modules/agent-control/runtime-core/run-finalizer.ts', `
export function buildManualSuspendProjectionPatch() {
  const canResume = canResumeAsUserPoint()
  return { status: canResume ? 'recoverable_paused' : 'blocked' }
}
`)
}

test('suspend finalize semantics gate fails on legacy kill plus hand event', (t) => {
  const root = makeHarnessRoot(t)
  writeSharedHarness(root)
  writeFile(root, 'src/main/modules/agent-control/runtime-core/runtime.ts', `
export class AgentControlRuntime {
  async suspendRun() {
    this.orchestrator.kill('butler', 'scope')
    this.emitScopeRunEvent({ interactionState: 'suspended' })
  }
}
`)

  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /must not call orchestrator\.kill/)
  assert.match(result.stderr, /must not hand-write suspended projection events/)
})

test('suspend finalize semantics gate passes on real codebase', () => {
  const result = runIn(REPO_ROOT)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-suspend-run-finalize-semantics: ok/)
})
