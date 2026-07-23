import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed contract: cross-process lease wiring requires static IPC/preload/renderer surface assertions.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser target-claim transitions push the supervision snapshot to the renderer', () => {
  const controllerComposition = readWorkspaceFile('src/main/modules/browser-engine/browser-controller-composition.ts')
  const takeoverRuntime = readWorkspaceFile('src/main/modules/browser-engine/browser-human-takeover-runtime.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const supervisionHook = readWorkspaceFile('src/renderer/modules/browser/useAgentBrowserSupervision.ts')

  assert.match(controllerComposition, /getBrowserTargetClaimService\(\)\.onTransition/)
  assert.match(takeoverRuntime, /sendToRenderer\('browser:leaseChanged', this\.getBrowserLeaseSnapshot\(\)\)/)
  assert.match(preload, /onLeaseChanged/)
  assert.match(preload, /ipcRenderer\.on\('browser:leaseChanged'/)
  assert.match(supervisionHook, /onLeaseChanged/)
  assert.match(supervisionHook, /applyLeaseSnapshotToSupervisionState/)
})

test('physical user input takes over only the exact driven target', () => {
  const takeoverRuntime = readWorkspaceFile('src/main/modules/browser-engine/browser-human-takeover-runtime.ts')
  const agentTabControlGate = readWorkspaceFile('src/main/modules/browser-engine/agent-tab-control-gate.ts')
  const ipcSupervision = readWorkspaceFile('src/main/modules/browser-engine/ipc-supervision.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')

  assert.match(takeoverRuntime, /attachTargetClaimSupervision/)
  assert.match(takeoverRuntime, /attachAgentTabSupervision/)
  assert.match(takeoverRuntime, /requestAgentInterruption\(tabId, 'physical_input'\)/)
  assert.match(takeoverRuntime, /requestedTabId[\s\S]*claim\.logicalKey\.tabId === requestedTabId/)
  assert.match(takeoverRuntime, /isAgentNavigationEcho\(\{[\s\S]*signalSource,[\s\S]*hasActiveAgentAction: claimService\.hasActiveAgentAction\(\{/)
  assert.match(agentTabControlGate, /input\.signalSource === 'navigation' && input\.hasActiveAgentAction/)
  assert.doesNotMatch(takeoverRuntime, /source: 'tab-switch'/)
  assert.doesNotMatch(takeoverRuntime, /task\.kind === 'site_research'/)
  const agentTabSupervision = takeoverRuntime.match(/protected attachAgentTabSupervision[\s\S]*?protected isAgentActivelyDrivingTab/)?.[0] || ''
  assert.doesNotMatch(agentTabSupervision, /preventDefault/)
  assert.doesNotMatch(ipcSupervision, /confirmAgentInterruption|dismissAgentInterruption/)
  assert.doesNotMatch(preload, /confirmAgentInterruption|dismissAgentInterruption/)
})

test('target resume is wired through Main, preload, renderer types, and a concrete supervision action', () => {
  const ipcSupervision = readWorkspaceFile('src/main/modules/browser-engine/ipc-supervision.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const rendererTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const hook = readWorkspaceFile('src/renderer/modules/browser/useAgentBrowserSupervision.ts')
  const panel = readWorkspaceFile('src/renderer/components/browser/AgentBrowserSupervisionPanel.tsx')

  assert.match(ipcSupervision, /ipcMain\.handle\('browser:resumeTargetClaim'/)
  assert.match(preload, /resumeTargetClaim:[\s\S]*ipcRenderer\.invoke\('browser:resumeTargetClaim'/)
  assert.match(rendererTypes, /resumeTargetClaim:/)
  assert.match(hook, /oldGeneration: claim\.generation/)
  assert.match(hook, /checkpointId: claim\.suspensionCheckpointId/)
  assert.match(hook, /wakeNonce: crypto\.randomUUID\(\)/)
  assert.match(panel, /继续 Agent/)
  assert.match(panel, /其他页面不受影响/)
})

test('P7c live-proof helpers are env-gated and used only by the live proof script', () => {
  const liveProofRuntime = readWorkspaceFile('src/main/modules/browser-engine/browser-live-proof-runtime.ts')
  const ipcShell = readWorkspaceFile('src/main/modules/browser-engine/ipc-shell.ts')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const liveProofScript = readWorkspaceFile('scripts/run-p7c-browser-decoupling-live-proof.mjs')

  assert.match(liveProofRuntime, /READY_P7C_LIVE_PROOF/)
  assert.match(liveProofRuntime, /createP7cLiveProofManualTab/)
  assert.match(liveProofRuntime, /prepareP7cLiveProofForegroundProbe/)
  assert.match(liveProofRuntime, /sampleP7cLiveProofActiveTabState/)
  assert.match(liveProofRuntime, /startP7cLiveProofUserViewLease/)
  assert.match(liveProofRuntime, /sendP7cLiveProofUserKey/)
  assert.match(liveProofRuntime, /checkP7cLiveProofWriteDenied/)
  assert.match(liveProofRuntime, /clearP7cLiveProofState/)
  assert.match(ipcShell, /browser:p7cLiveProofCreateManualTab/)
  assert.match(ipcShell, /browser:p7cLiveProofPrepareForegroundProbe/)
  assert.match(ipcShell, /browser:p7cLiveProofSampleActiveTabState/)
  assert.match(ipcShell, /browser:p7cLiveProofStartUserViewLease/)
  assert.match(preload, /p7cLiveProofCreateManualTab/)
  assert.match(preload, /p7cLiveProofPrepareForegroundProbe/)
  assert.match(preload, /p7cLiveProofSampleActiveTabState/)
  assert.match(preload, /p7cLiveProofStartUserViewLease/)
  assert.match(liveProofScript, /p7cLiveProofStartUserViewLease/)
  assert.match(liveProofScript, /P7c2-foreground-preservation-and-takeover/)
  assert.match(liveProofScript, /activeTabFocusPreserved/)
  assert.match(liveProofScript, /activeTabScrollPreserved/)
})
