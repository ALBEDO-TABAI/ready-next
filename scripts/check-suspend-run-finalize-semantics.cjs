'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = process.cwd()
const runtimePath = path.join(root, 'src/main/modules/agent-control/runtime-core/runtime.ts')
const orchestratorPath = path.join(root, 'src/main/modules/agent-control/runtime-core/orchestrator.ts')
const sdkRuntimePath = path.join(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts')
// V3 Phase 5-B: sendMessage's manual-suspend abort branch + buildResult return live here now.
const sdkTurnOrchestratorPath = path.join(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-turn-orchestrator.ts')
const finalizerPath = path.join(root, 'src/main/modules/agent-control/runtime-core/run-finalizer.ts')

function read(relPath) {
  return fs.readFileSync(relPath, 'utf8')
}

function fail(message) {
  console.error(`check-suspend-run-finalize-semantics: ${message}`)
  process.exitCode = 1
}

function extractMethod(source, methodName) {
  const marker = `${methodName}(`
  const start = source.indexOf(marker)
  if (start === -1) return ''
  let brace = -1
  let lineStart = source.lastIndexOf('\n', start) + 1
  while (lineStart < source.length) {
    const lineEnd = source.indexOf('\n', lineStart)
    const end = lineEnd === -1 ? source.length : lineEnd
    const line = source.slice(lineStart, end)
    const localBrace = line.lastIndexOf('{')
    const beforeBrace = localBrace === -1 ? '' : line.slice(0, localBrace)
    const openSignatureContinues = beforeBrace.includes('(') && !beforeBrace.includes(')')
    if (
      localBrace !== -1
      && line.slice(localBrace).trim() === '{'
      && !/^\s*\w+\??:\s*\{/.test(line.trim())
      && !openSignatureContinues
    ) {
      brace = lineStart + localBrace
      break
    }
    lineStart = end + 1
  }
  if (brace === -1) return ''
  let depth = 0
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ''
}

const runtime = read(runtimePath)
const orchestrator = read(orchestratorPath)
const sdkTurnOrchestrator = read(sdkTurnOrchestratorPath)
const finalizer = read(finalizerPath)

const suspendRun = extractMethod(runtime, 'suspendRun')
if (!suspendRun) {
  fail('runtime.ts is missing suspendRun()')
} else {
  if (/\.kill\s*\(/.test(suspendRun)) {
    fail('suspendRun() must not call orchestrator.kill(); use interruptForSuspend()')
  }
  if (/emitScopeRunEvent\s*\(/.test(suspendRun)) {
    fail('suspendRun() must not hand-write suspended projection events')
  }
  if (!/interruptForSuspend\s*\(/.test(suspendRun)) {
    fail('suspendRun() must mechanically stop via interruptForSuspend()')
  }
  if (!/finalizeRunOutcome\s*\(\s*\{[\s\S]*kind:\s*'interrupted'[\s\S]*terminalReason:\s*'manual_suspend'/.test(suspendRun)) {
    fail('suspendRun() must finalize manual pause as interrupted/manual_suspend')
  }
  if (!/buildManualSuspendProjectionPatch\s*\(/.test(suspendRun)) {
    fail('suspendRun() must use buildManualSuspendProjectionPatch()')
  }
}

const kill = extractMethod(orchestrator, 'kill')
const interrupt = extractMethod(orchestrator, 'interruptForSuspend')
if (!kill || !interrupt) {
  fail('orchestrator must expose kill() and interruptForSuspend() separately')
} else {
  if (!/sessions\.setState\(\s*taskKey\s*,\s*'cancelled'\s*\)/.test(kill)) {
    fail('kill() must remain the cancelled path')
  }
  if (/sessions\.setState\([^)]*'cancelled'/.test(interrupt)) {
    fail('interruptForSuspend() must not mark the session cancelled')
  }
  if (!/manual_suspend/.test(interrupt)) {
    fail('interruptForSuspend() must thread manual_suspend as the abort initiator')
  }
}

if (!/manual_suspend/.test(sdkTurnOrchestrator) || !/abortInitiator === 'manual_suspend'/.test(sdkTurnOrchestrator)) {
  fail('AgentSdkRuntime abort path must branch on manual_suspend')
}
if (!/return this\.buildResult\(\{[\s\S]*terminalReason,[\s\S]*taskBudgetRuntime/.test(sdkTurnOrchestrator)) {
  fail('AgentSdkRuntime manual suspend branch must return without cancelled finalization')
}

if (!/function buildManualSuspendProjectionPatch/.test(finalizer)) {
  fail('run-finalizer.ts must own buildManualSuspendProjectionPatch()')
}
if (!/canResumeAsUserPoint/.test(finalizer) || !/recoverable_paused/.test(finalizer)) {
  fail('manual suspend projection patch must use real resume proof before recoverable_paused')
}

if (!process.exitCode) {
  console.log('check-suspend-run-finalize-semantics: ok')
}
