'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const SCRIPT = path.resolve(__dirname, '../check-active-run-liveness-single-source.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function writeFile(root, rel, body) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function makeHarnessRoot(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-active-liveness-gate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeFile(root, 'src/main/modules/agent-control/runtime-core/orchestrator.ts', overrides.orchestrator ?? `
export interface ChildLivenessProvider {
  hasActiveChildRunForScope(scopeId: string): boolean
}
export class ReadyAgentOrchestrator {
  private childLivenessProvider: ChildLivenessProvider | null = null
  hasActiveRun(agent: string, sessionId?: string): boolean { return false }
  setChildLivenessProvider(provider: ChildLivenessProvider | null): void {
    this.childLivenessProvider = provider
  }
  isScopeLive(agent: string, scopeId: string): boolean {
    return this.hasActiveRun(agent, scopeId)
      || (this.childLivenessProvider?.hasActiveChildRunForScope(scopeId) ?? false)
  }
  interruptActiveRunIfMatches(): void {}
}
`)
  writeFile(root, 'src/main/modules/agent-control/skills/skill-child-runner.ts', overrides.childRunner ?? `
export class SkillChildRunner {
  private active = new Map<string, { scopeId: string | null }>()
  hasActiveChildRunForScope(scopeId: string): boolean {
    const normalizedScopeId = String(scopeId || '').trim()
    if (!normalizedScopeId) return false
    for (const run of this.active.values()) {
      if (run.scopeId === normalizedScopeId) return true
    }
    return false
  }
  async startSkillChildRun(): Promise<void> {}
}
`)
  writeFile(root, 'src/main/modules/agent-control/runtime-core/runtime.ts', overrides.runtime ?? `
export class AgentControlRuntime {
  private orchestrator: any
  private async boot(): Promise<void> {
    const childRunner = configureSkillChildRunner({})
    this.orchestrator.setChildLivenessProvider(childRunner)
  }
  private async finalizeStaleWithoutHandleProjectionsForScope(scope: { agent: string; id: string }): Promise<number> {
    if (this.orchestrator.isScopeLive(scope.agent, scope.id)) return 0
    return finalizeStaleWithoutHandleProjections({
      hasActiveRun: () => this.orchestrator.isScopeLive(scope.agent, scope.id),
    })
  }
  async suspendRun(): Promise<void> {}
}
`)
  return root
}

test('gate passes on the real codebase', () => {
  const r = runIn(REPO_ROOT)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /check-active-run-liveness-single-source] OK/)
})

test('gate fails when stale closeout bypasses isScopeLive', (t) => {
  const root = makeHarnessRoot(t, {
    runtime: `
export class AgentControlRuntime {
  private orchestrator: any
  private async boot(): Promise<void> {
    const childRunner = configureSkillChildRunner({})
    this.orchestrator.setChildLivenessProvider(childRunner)
  }
  private async finalizeStaleWithoutHandleProjectionsForScope(scope: { agent: string; id: string }): Promise<number> {
    if (this.orchestrator.hasActiveRun(scope.agent, scope.id)) return 0
    return finalizeStaleWithoutHandleProjections({
      hasActiveRun: () => this.orchestrator.hasActiveRun(scope.agent, scope.id),
    })
  }
  async suspendRun(): Promise<void> {}
}
`,
  })
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /must not bypass isScopeLive/)
})

test('gate accepts runtime without the retired child-liveness wiring', (t) => {
  const root = makeHarnessRoot(t, {
    runtime: `
export class AgentControlRuntime {
  private orchestrator: any
  private async boot(): Promise<void> {
    configureSkillChildRunner({})
  }
  private async finalizeStaleWithoutHandleProjectionsForScope(scope: { agent: string; id: string }): Promise<number> {
    if (this.orchestrator.isScopeLive(scope.agent, scope.id)) return 0
    return finalizeStaleWithoutHandleProjections({
      hasActiveRun: () => this.orchestrator.isScopeLive(scope.agent, scope.id),
    })
  }
  async suspendRun(): Promise<void> {}
}
`,
  })
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('gate fails when child runner has no scope liveness provider', (t) => {
  const root = makeHarnessRoot(t, {
    childRunner: `
export class SkillChildRunner {
  async startSkillChildRun(): Promise<void> {}
}
`,
  })
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /must expose hasActiveChildRunForScope/)
})
