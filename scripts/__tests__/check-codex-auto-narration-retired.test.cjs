const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  check,
  expectedSendScopedIdentifiers,
  forbiddenByFile,
  retiredFiles,
} = require('../check-codex-auto-narration-retired.cjs')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-narration-retired-'))
  for (const rel of Object.keys(forbiddenByFile)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'export {}\n')
  }
  const bridge = path.join(root, 'src/main/modules/browser-engine/task-event-bridge.ts')
  fs.mkdirSync(path.dirname(bridge), { recursive: true })
  fs.writeFileSync(bridge, 'export const taskEventBridge = { registerProjectionSink() {} }\n')
  const persistence = path.join(root, 'src/main/modules/browser-engine/task-persistence-service.ts')
  fs.writeFileSync(persistence, "import { taskEventBridge } from './task-event-bridge'\nvoid taskEventBridge\n")
  const subscription = path.join(root, 'src/main/modules/agent-control/runtime-core/task-event-proof-subscription.ts')
  fs.mkdirSync(path.dirname(subscription), { recursive: true })
  fs.writeFileSync(subscription, [
    "import { taskEventBridge } from '../../browser-engine/task-event-bridge'",
    'taskEventBridge.registerProjectionSink(createTaskEventProofListener(createTaskProofSink(store)))',
  ].join('\n'))
  const retirementMigration = path.join(
    root,
    'src/main/modules/agent-control/codex-runtime/codex-thread-retirement-cleanup-migration.ts',
  )
  fs.mkdirSync(path.dirname(retirementMigration), { recursive: true })
  fs.writeFileSync(retirementMigration, 'export function applyCodexThreadRetirementCleanupMigration() {}\n')
  const migrations = path.join(root, 'src/main/modules/migrations.ts')
  fs.mkdirSync(path.dirname(migrations), { recursive: true })
  fs.writeFileSync(migrations, "import { applyCodexThreadRetirementCleanupMigration } from './agent-control/codex-runtime/codex-thread-retirement-cleanup-migration'\nvoid applyCodexThreadRetirementCleanupMigration\n")
  for (const [rel, count] of expectedSendScopedIdentifiers) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const call = rel.endsWith('ipc-handler.ts')
      ? 'runtime.sendScoped(payload)\n'
      : rel.endsWith('agent-lifecycle-group.ts')
        ? 'deps.sendScoped(payload)\n'
        : rel.endsWith('useAgent.ts')
          ? 'window.electronAPI.agent.sendScoped(payload)\n'
          : ''
    const remaining = count - (call ? 1 : 0)
    fs.writeFileSync(abs, `${call}${'// sendScoped\n'.repeat(remaining)}`)
  }
  return root
}

test('retirement gate accepts a graph with no automatic narration entrypoint', () => {
  const root = fixture()
  try {
    assert.deepEqual(check(root), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retirement gate rejects file resurrection, known rewiring, and a new producer file', () => {
  const root = fixture()
  try {
    const retired = path.join(root, retiredFiles[0])
    fs.mkdirSync(path.dirname(retired), { recursive: true })
    fs.writeFileSync(retired, 'export {}\n')
    const runtime = path.join(root, 'src/main/modules/agent-control/runtime-core/runtime.ts')
    fs.writeFileSync(runtime, 'startCodexSystemBackground() {}\n')
    const newProducer = path.join(root, 'src/main/modules/agent-control/automatic-background-narrator.ts')
    fs.mkdirSync(path.dirname(newProducer), { recursive: true })
    fs.writeFileSync(newProducer, "export const ingress = { kind: 'system_background', attemptKind: 'system_background' }\n")
    const errors = check(root)
    assert.ok(errors.some((error) => error.includes('retired file exists')))
    assert.ok(errors.some((error) => error.includes('startCodexSystemBackground')))
    assert.ok(errors.some((error) => error.includes('automatic-background-narrator.ts')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retirement gate rejects lower-camel continuation and ingress hidden in an allowlisted file', () => {
  const root = fixture()
  try {
    const lowerCamel = path.join(root, 'src/main/modules/agent-control/new-narrator.ts')
    fs.mkdirSync(path.dirname(lowerCamel), { recursive: true })
    fs.writeFileSync(lowerCamel, 'export function narrationContinuation() {}\n')
    const lowerSystem = path.join(root, 'src/main/modules/agent-control/new-background-ingress.ts')
    fs.writeFileSync(lowerSystem, 'export function systemBackgroundIngress() {}\n')

    const allowlisted = path.join(
      root,
      'src/main/modules/agent-control/runtime-core/detached-skill-service.ts',
    )
    fs.mkdirSync(path.dirname(allowlisted), { recursive: true })
    fs.writeFileSync(allowlisted, [
      "const taskOrigin = 'system_background'",
      "const ingress = { kind: 'system_background', attemptKind: 'system_background' }",
    ].join('\n'))

    const errors = check(root)
    assert.ok(errors.some((error) => error.includes('new-narrator.ts')))
    assert.ok(errors.some((error) => error.includes('new-background-ingress.ts')))
    assert.ok(errors.some((error) => error.includes('expected exactly 1')))
    assert.ok(errors.some((error) => error.includes('ingress shape')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retirement gate rejects a renamed bridge listener that forwards terminal events into user ingress', () => {
  const root = fixture()
  try {
    const forwarder = path.join(root, 'src/main/modules/agent-control/task-completion-forwarder.ts')
    fs.mkdirSync(path.dirname(forwarder), { recursive: true })
    fs.writeFileSync(forwarder, [
      "import { taskEventBridge } from '../browser-engine/task-event-bridge'",
      'taskEventBridge.registerProjectionSink(event => runtime.sendScoped({ event }))',
    ].join('\n'))

    const errors = check(root)
    assert.ok(errors.some((error) => error.includes('importers changed')))
    assert.ok(errors.some((error) => error.includes('registerProjectionSink production callsites changed')))
    assert.ok(errors.some((error) => error.includes('sendScoped production callsites changed')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retirement gate rejects bind aliases hidden inside an otherwise allowed bridge importer', () => {
  const root = fixture()
  try {
    const persistence = path.join(root, 'src/main/modules/browser-engine/task-persistence-service.ts')
    fs.appendFileSync(persistence, [
      'const subscribe = taskEventBridge.registerProjectionSink.bind(taskEventBridge)',
      'const send = runtime.sendScoped.bind(runtime)',
      'subscribe((event) => void send(event))',
    ].join('\n'))

    const errors = check(root)
    assert.ok(errors.some((error) => error.includes('registerProjectionSink production references changed')))
    assert.ok(errors.some((error) => error.includes('sendScoped production references changed')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retirement gate rejects quoted and qualified pending-event mutations', () => {
  const root = fixture()
  try {
    const migrations = path.join(root, 'src/main/modules/migrations.ts')
    fs.appendFileSync(migrations, [
      'db.exec(\'UPDATE "pending_task_events" SET consumed = 1\')',
      'db.exec(\'INSERT OR REPLACE INTO [main].[pending_task_events] (id) VALUES (1)\')',
    ].join('\n'))

    const errors = check(root)
    assert.ok(errors.some((error) => error.includes('mutates retired pending_task_events')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retirement gate rejects a production importer of the inert migration module', () => {
  const root = fixture()
  try {
    const runtime = path.join(root, 'src/main/modules/agent-control/runtime-core/runtime.ts')
    fs.appendFileSync(runtime, "import { applyCodexThreadRetirementCleanupMigration } from '../codex-runtime/codex-thread-retirement-cleanup-migration'\n")

    const errors = check(root)
    assert.ok(errors.some((error) => error.includes('retirement migration production importers changed')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
