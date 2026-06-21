'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-specialist-create-funnel.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function makeRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specialist-create-funnel-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(root, rel, body) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function writeValidFactoryBoundary(root) {
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', `
// P5e/C23 legacy dormant derivation path
export function prepareSpecialistAgentDerivation() {
  return {}
}
// P5e/C23 legacy dormant derivation path
export function deriveSpecialistAgent() {
  return {}
}
export function deriveSpecialistAgentFromBlueprint(registry, store) {
  const createdRelPaths = []
  const createdDirPaths = []
  const migratedCards = []
  try {
    const routing = store.writeCard({})
    const agent = registry.create({ id: 'ok' })
    return { agent, routing }
  } catch (error) {
    rollbackMigratedCards(store, migratedCards)
    for (const relPath of createdRelPaths.reverse()) {
      rmSync(absInside(store.rootPath, relPath), { force: true })
    }
    for (const relPath of createdDirPaths.reverse()) {
      rmSync(absInside(store.rootPath, relPath), { recursive: true, force: true })
    }
    throw error
  }
}
`)
}

test('specialist create funnel gate fails on direct registry.create outside agent-factory', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', `
export function allowed(registry) {
  return registry.create({ id: 'ok' })
}
`)
  writeFile(root, 'src/main/modules/rogue-specialist-create.ts', `
export function rogue(registry) {
  return registry.create({ id: 'bypass' })
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /registry\.create/)
})

test('specialist create funnel gate fails on direct getAgentRegistry or agentRegistry create', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', '')
  writeFile(root, 'src/main/modules/rogue-runtime-create.ts', `
export function rogue(runtime) {
  return runtime.getAgentRegistry().create({ id: 'bypass' })
}
`)
  writeFile(root, 'src/main/modules/rogue-agent-registry-create.ts', `
export function alsoRogue(agentRegistry) {
  return agentRegistry.create({ id: 'bypass-2' })
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /rogue-runtime-create/)
  assert.match(result.stderr, /rogue-agent-registry-create/)
})

test('specialist create funnel gate fails on direct deriveSpecialistAgent outside agent-factory', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', `
export function deriveSpecialistAgent() {
  return { agent: { id: 'ok' } }
}
`)
  writeFile(root, 'src/main/modules/claude-bridge/ipc/agent-derivation-group.ts', `
import { deriveSpecialistAgent, prepareSpecialistAgentDerivation } from '../../agent-control/agents/agent-factory'
export function rogue(registry, store, input) {
  prepareSpecialistAgentDerivation(registry, store, input)
  return deriveSpecialistAgent(registry, store, input)
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /legacy specialist derivation functions/)
  assert.match(result.stderr, /agent-derivation-group/)
})

test('specialist create funnel gate fails on aliased legacy derivation import', (t) => {
  const root = makeRoot(t)
  writeValidFactoryBoundary(root)
  writeFile(root, 'src/main/modules/rogue-legacy-alias.ts', `
import { deriveSpecialistAgent as createSpecialistFromCandidate } from './agent-control/agents/agent-factory'
export function rogue(registry, store, input) {
  return createSpecialistFromCandidate(registry, store, input)
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /legacy specialist derivation helpers must not be imported or re-exported/)
  assert.match(result.stderr, /rogue-legacy-alias/)
})

test('specialist create funnel gate fails on deferred chat creation IPC', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', '')
  writeFile(root, 'src/preload/index.ts', `
export const agent = {
  confirmSpecialistBlueprint: () => ipcRenderer.invoke('agent:specialist:confirm')
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /chat-driven specialist creation IPC/)
})

test('specialist create funnel gate fails on unapproved blueprint upsert', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', '')
  writeFile(root, 'src/main/modules/rogue-blueprint-write.ts', `
import type { SpecialistAgentBlueprint } from '../../shared/agent-specialist-blueprint'
export function rogue(blueprintStore, blueprint: SpecialistAgentBlueprint) {
  return blueprintStore.upsert(blueprint)
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /blueprint persistence/)
  assert.match(result.stderr, /rogue-blueprint-write/)
})

test('specialist create funnel gate fails when FOUNDATION is prompt-injected', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', '')
  writeFile(root, 'src/main/modules/agent-control/prompt-assembly.ts', `
export function loadFoundation(readMemoryFile) {
  return readMemoryFile('agents/visual/FOUNDATION.md')
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /FOUNDATION\.md/)
})

test('specialist create funnel gate fails when semantic review metadata is prompt-injected', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', '')
  writeFile(root, 'src/main/modules/agent-control/prompt-assembly.ts', `
export function injectSemantic(blueprint) {
  return blueprint.semanticReview
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /semanticReview/)
})

test('specialist create funnel gate fails when semantic issue enum is duplicated outside shared schema', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', '')
  writeFile(root, 'src/main/modules/agent-control/agents/rogue-semantic-enum.ts', `
export const SPECIALIST_FOUNDATION_SEMANTIC_ISSUES = ['scope_too_generic']
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /semantic issue enum/)
})

test('specialist create funnel gate fails when specialist semantic code bypasses the shared hash helper', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', '')
  writeFile(root, 'src/main/modules/agent-control/agents/specialist-foundation-semantic-judge.ts', `
import { createHash } from 'node:crypto'
export function rogueHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /semantic review hash/)
})

test('specialist create funnel gate fails when confirmation IPC omits semantic review contract helpers', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', '')
  writeFile(root, 'src/main/modules/claude-bridge/ipc/agent-specialist-blueprint-group.ts', `
export function requestConfirmation(blueprint) {
  return { ok: blueprint.admissionVerdict.kind === 'admit' }
}
`)
  writeFile(root, 'src/main/modules/agent-control/agents/specialist-foundation-semantic-judge.ts', `
export function runSpecialistFoundationSemanticReview() {
  return { review: { status: 'passed' } }
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /canonical review materialization/)
})

test('specialist create funnel gate fails when semantic review runner is called outside blueprint paths', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', '')
  writeFile(root, 'src/main/modules/agent-control/runtime-core/rogue-semantic-review.ts', `
import { runSpecialistFoundationSemanticReview } from '../agents/specialist-foundation-semantic-judge'
export function rogue(blueprint, deps) {
  return runSpecialistFoundationSemanticReview(blueprint, deps)
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /semantic review runner/)
  assert.match(result.stderr, /rogue-semantic-review/)
})

test('specialist create funnel gate fails when semantic judge resolver is called outside propose dispatch and IPC', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', '')
  writeFile(root, 'src/main/modules/agent-control/runtime-core/rogue-semantic-resolver.ts', `
import { resolveSpecialistFoundationSemanticJudge } from '../agents/specialist-foundation-semantic-judge-provider'
export function rogue() {
  return resolveSpecialistFoundationSemanticJudge()
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /semantic judge resolver/)
  assert.match(result.stderr, /rogue-semantic-resolver/)
})

test('specialist create funnel gate fails on bare sourceMessageId null without unavailable reason', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', '')
  writeFile(root, 'src/main/modules/claude-bridge/ipc/rogue-blueprint-source.ts', `
export function rogue() {
  return {
    provenance: {
      sourceMessageId: null,
      createdAt: new Date().toISOString(),
    },
  }
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /sourceMessageId:null/)
  assert.match(result.stderr, /rogue-blueprint-source/)
})

test('specialist create funnel gate fails when legacy derivation helpers lack dormant markers', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', `
export function prepareSpecialistAgentDerivation() {
  return {}
}
export function deriveSpecialistAgent() {
  return {}
}
export function deriveSpecialistAgentFromBlueprint(registry, store) {
  const createdRelPaths = []
  const createdDirPaths = []
  const migratedCards = []
  try {
    const routing = store.writeCard({})
    const agent = registry.create({ id: 'ok' })
    return { agent, routing }
  } catch (error) {
    rollbackMigratedCards(store, migratedCards)
    for (const relPath of createdRelPaths.reverse()) {
      rmSync(absInside(store.rootPath, relPath), { force: true })
    }
    for (const relPath of createdDirPaths.reverse()) {
      rmSync(absInside(store.rootPath, relPath), { recursive: true, force: true })
    }
    throw error
  }
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /P5e dormant marker/)
})

test('specialist create funnel gate fails when legacy derivation IPC creates instead of staging a blueprint', (t) => {
  const root = makeRoot(t)
  writeValidFactoryBoundary(root)
  writeFile(root, 'src/main/modules/claude-bridge/ipc/agent-derivation-group.ts', `
export function confirmDerivation(registry) {
  return {
    createdAgent: true,
    routingActivated: true,
    migratedCards: [{ from: 'knowledge/a.md', to: 'agents/a/knowledge/a.md' }],
    agent: registry.create({ id: 'bypass' }),
  }
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /registry\.create|must not create specialist agent rows directly|blueprint-staging only/)
})

test('specialist create funnel gate fails when live blueprint creation creates registry row before routing write', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', `
// P5e/C23 legacy dormant derivation path
export function prepareSpecialistAgentDerivation() {
  return {}
}
// P5e/C23 legacy dormant derivation path
export function deriveSpecialistAgent() {
  return {}
}
export function deriveSpecialistAgentFromBlueprint(registry, store) {
  const createdRelPaths = []
  const createdDirPaths = []
  const migratedCards = []
  try {
    const agent = registry.create({ id: 'bypass' })
    const routing = store.writeCard({})
    return { agent, routing }
  } catch (error) {
    rollbackMigratedCards(store, migratedCards)
    for (const relPath of createdRelPaths.reverse()) {
      rmSync(absInside(store.rootPath, relPath), { force: true })
    }
    for (const relPath of createdDirPaths.reverse()) {
      rmSync(absInside(store.rootPath, relPath), { recursive: true, force: true })
    }
    throw error
  }
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /write routing\/assets before registry\.create/)
})

test('specialist create funnel gate fails when live blueprint creation delegates to legacy helper', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', `
// P5e/C23 legacy dormant derivation path
export function prepareSpecialistAgentDerivation() {
  return {}
}
// P5e/C23 legacy dormant derivation path
export function deriveSpecialistAgent() {
  return {}
}
export function deriveSpecialistAgentFromBlueprint(registry, store, input) {
  const createdRelPaths = []
  const createdDirPaths = []
  const migratedCards = []
  try {
    const routing = store.writeCard({})
    const delegated = deriveSpecialistAgent(registry, store, input)
    const agent = registry.create({ id: 'bypass' })
    return { agent, routing, delegated }
  } catch (error) {
    rollbackMigratedCards(store, migratedCards)
    for (const relPath of createdRelPaths.reverse()) {
      rmSync(absInside(store.rootPath, relPath), { force: true })
    }
    for (const relPath of createdDirPaths.reverse()) {
      rmSync(absInside(store.rootPath, relPath), { recursive: true, force: true })
    }
    throw error
  }
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /must not delegate to legacy derivation helpers/)
})

test('specialist create funnel gate fails when live blueprint rollback cleanup is removed', (t) => {
  const root = makeRoot(t)
  writeFile(root, 'src/main/modules/agent-control/agents/agent-factory.ts', `
// P5e/C23 legacy dormant derivation path
export function prepareSpecialistAgentDerivation() {
  return {}
}
// P5e/C23 legacy dormant derivation path
export function deriveSpecialistAgent() {
  return {}
}
export function deriveSpecialistAgentFromBlueprint(registry, store) {
  try {
    const routing = store.writeCard({})
    const agent = registry.create({ id: 'bypass' })
    return { agent, routing }
  } catch (error) {
    throw error
  }
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /rollback cleanup/)
})

test('specialist create funnel gate passes on the real codebase', () => {
  const result = runIn(REPO_ROOT)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-specialist-create-funnel.*OK/)
})
