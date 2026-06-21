'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-run-finalize-funnel.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-finalize-gate-'))
  writeFile(dir, 'src/shared/run-meta-terminal-status.ts', `
export const RUN_META_TERMINAL_STATUSES = [
  'done',
  'error',
  'cancelled',
  'preempted',
  'interrupted',
  'checkpoint',
  'completed',
  'failed',
  'killed',
] as const
`)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(rootDir, rel, body) {
  const p = path.join(rootDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

test('run finalize gate fails when a synthetic terminal writer is present', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/runtime-core/run-finalizer.ts', `
export function buildTerminalProjectionPatch() {
  return { status: 'killed' }
}
`)
  writeFile(root, 'src/main/modules/agent-control/task-projection/rogue-terminal.ts', `
export function rogue(runMetaRepository: any) {
  runMetaRepository.update('run-1', { status: 'done', terminalReason: 'done' })
  return {
    status: 'killed',
    interactionState: 'suspended',
    taskSummary: '已被新消息接管',
    blockedReason: '已被新消息接管',
    continuationRef: { blockerType: 'superseded' },
  }
}
`)

  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /run_meta_terminal_update/)
  assert.match(r.stderr, /terminal_projection_patch_literal/)
})

test('run finalize gate fails when C03a early-return families bypass finalizer', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/runtime-core/run-finalizer.ts', `
export function buildTerminalProjectionPatch() {
  return { status: 'killed' }
}
`)
  writeFile(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts', `
export async function sendMessage() {
  const emitStatus = () => {}
  const configDetail = this.loadAIConfig()
  if (!configDetail.ok) {
    emitStatus('error', configDetail.reason === 'json_corrupt' ? 'blocked_config' : 'persistence_failed')
    return this.buildResult({})
  }
  if (!configDetail.config?.apiKey) {
    emitStatus('error', 'blocked_config')
    return this.buildResult({})
  }
  const normalizedConfig = normalizeAIConfig(configDetail.config)
  const resumeChildRunId = continuationChildRunId()
  if (resumeChildRunId) {
    emitStatus(outcome.status, outcome.terminalReason)
    return this.buildResult({})
  }
  const currentLocalSendImTurn = hasLocalSendImIntentForTurn()
  if (restoredToolSurface.missingToolNames.length > 0) {
    emitStatus('error', 'blocked_tool_error')
    return this.buildResult({})
  }
  const hasVeaPipelineTool = false
  assertCurrentMessageCapability(blocksForCheck)
  try {} catch {
    emitStatus('error', 'blocked_config')
    return this.buildResult({})
  }
  let nextInput = toSdkInput(providerContent)
  const finishBudgetCheckpointIfNeeded = async () => {
    emitStatus('checkpoint', 'checkpoint_budget')
    return this.buildResult({})
  }
  const hasUnfinishedActionTaskReference = () => false
  const contentIssue = await inspectDocumentTargetContent(documentTargetGuardForRecovery)
  if (!contentIssue) {
    emitStatus('done', 'done')
    return this.buildResult({})
  }
  if (
    /Max turns (16) exceeded/i.test(message)
    && documentTargetGuardForRecovery
    && !hasSuccessfulDocumentTargetMutation
  ) {}
}
`)

  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /agent_sdk_c03_early_return/)
})

test('run finalize gate passes on the real codebase', () => {
  const r = runIn(REPO_ROOT)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /check-run-finalize-funnel: ok/)
})
