import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { BrowserWindow } from 'electron'
import type { AgentInputItem } from '@openai/agents'

import { getDatabase } from '../main/modules/database'
import { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  bootIncarnationIdFromPhysicalTargetToken,
  partitionForBrowserProfile,
  type BrowserTargetClaim,
  type BrowserTargetClaimIdentity,
} from '../main/modules/browser-engine/browser-target-claims'
import {
  __resetBrowserTargetClaimServiceForTests,
  getBrowserTargetClaimService,
} from '../main/modules/browser-engine/browser-target-claim-singleton'
import { AgentSessionCheckpointRepository, workflowDigest } from '../main/modules/repositories/agent-session-checkpoint-repository'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import {
  providerCheckpointExecutionBinding,
  providerCheckpointPreparedSkill,
} from './provider-checkpoint-test-fixtures'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'

async function waitFor<T>(read: () => T | null, label: string): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function identity(claim: BrowserTargetClaim): BrowserTargetClaimIdentity {
  if (!claim.physicalTargetToken || !claim.bootIncarnationId) throw new Error('claim physical identity missing')
  return {
    partition: claim.logicalKey.partition,
    tabId: claim.logicalKey.tabId,
    physicalTargetToken: claim.physicalTargetToken,
    bootIncarnationId: claim.bootIncarnationId,
    claimId: claim.claimId,
    generation: claim.generation,
    ownerRunId: claim.ownerRunId,
  }
}

export async function runBrowserControllerTakeoverNativeSignalTest(): Promise<void> {
  const dbManager = getDatabase()
  const db = dbManager.getRawDb()
  if (!db) throw new Error('native takeover database unavailable')
  const accessor = { getRawDb: () => db }
  const projections = new TaskProjectionRepository(accessor)
  const runMeta = new RunMetaRepository(db)
  const repository = new AgentSessionCheckpointRepository(accessor)
  const parentTaskId = 'native-browser-takeover-parent'
  const ownerRunId = 'native-browser-takeover-run'
  const scopeId = 'native-browser-takeover-scope'
  const sourceMessageId = 'native-browser-takeover-message'
  const now = '2026-07-23T00:00:00.000Z'
  const executionBinding = providerCheckpointExecutionBinding(ownerRunId)

  projections.create({
    taskId: parentTaskId,
    scopeId,
    runId: ownerRunId,
    taskType: 'research',
    module: 'browser',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'none',
    steps: [],
    ownerAgentId: 'butler',
    taskOrigin: 'user_root',
    executionBinding,
    createdAt: now,
    updatedAt: now,
  })
  runMeta.create({
    runId: ownerRunId,
    taskId: parentTaskId,
    scopeId,
    agentId: 'butler',
    executionBinding,
    status: 'running',
  }, Date.parse(now))
  db.prepare(
    `INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
     VALUES (?, 'butler', 'Native browser takeover', ?, ?)`,
  ).run(scopeId, now, now)
  db.prepare(
    `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
     VALUES (?, ?, 'user', '验证真实浏览器接管', ?, '{}')`,
  ).run(sourceMessageId, scopeId, now)
  const route = await repository.bindBrowserWorkflowRoute({
    parentTaskId,
    ownerRunId,
    sourceMessageId,
    executionBinding,
    now,
  })
  const sourceItems = [{ role: 'user', content: '验证真实浏览器接管' } as AgentInputItem]
  await repository.writeCleanBoundary({
    parentTaskId,
    browserTaskId: route.browserTaskId,
    ownerRunId,
    sourceItems,
    sdkSourceItems: sourceItems,
    sdkSourceItemCount: sourceItems.length,
    sdkSourcePrefixDigest: workflowDigest(sourceItems),
    preparedSkill: providerCheckpointPreparedSkill(),
    activatedCapabilityGroups: ['browser'],
    now,
  })

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body><input autofocus value="ready"></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('native takeover fixture server unavailable')
  const url = `http://127.0.0.1:${address.port}/`
  const mainWindow = new BrowserWindow({ show: false, width: 900, height: 700 })
  await mainWindow.loadURL(url)
  const controller = new BrowserController(mainWindow)
  let claimService = getBrowserTargetClaimService()
  const cleanCheckpoint = repository.current(parentTaskId, 'clean_base')
  assert.ok(cleanCheckpoint)

  controller.setHumanTakeoverIntentPort(async (input) => repository.createHumanTakeoverIntent({
    parentTaskId: input.parentTaskId,
    ownerRunId: input.ownerRunId,
    browserTaskId: input.browserTaskId,
    targetClaimId: input.targetClaimId,
    targetClaimGeneration: input.targetClaimGeneration,
    physicalTarget: {
      surface: input.surface,
      scopeId: input.scopeId,
      profileId: input.profileId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      physicalTargetToken: input.physicalTargetToken,
      source: input.source,
    },
  }))

  const claims = new Map<string, BrowserTargetClaim>()
  const webContentsByTab = new Map<string, Electron.WebContents>()
  const bindings = new Map<string, ReturnType<typeof makeBinding>>()
  const makeClaim = async (label: string): Promise<string> => {
    const created = await controller.createTab(`${url}?tab=${label}`, { background: true, owner: 'agent' })
    if (!created.success || !created.tabId) throw new Error(created.error || `failed to create ${label}`)
    const tabId = created.tabId
    const physicalTargetToken = controller.getPhysicalTargetToken(tabId)
    const claim = claimService.acquire({
      partition: partitionForBrowserProfile(null),
      tabId,
      physicalTargetToken,
      bootIncarnationId: bootIncarnationIdFromPhysicalTargetToken(physicalTargetToken),
      profileId: null,
      surface: 'agent-view',
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      scopeId,
      sessionId: null,
    })
    if (isAgentBrowserError(claim)) throw new Error(`${label}: ${claim.message}`)
    const binding = makeBinding(claim)
    controller.bindBrowserWorkflowPhysicalTarget(binding)
    claims.set(tabId, claim)
    bindings.set(tabId, binding)
    const tab = (controller as unknown as { tabs: Map<string, { view?: { webContents: Electron.WebContents } }> }).tabs.get(tabId)
    if (!tab?.view) throw new Error(`${label}: real webContents missing`)
    webContentsByTab.set(tabId, tab.view.webContents)
    const supervisionListenerCount = (eventName: 'before-input-event' | 'before-mouse-event') => (
      tab.view!.webContents.listeners(eventName)
        .filter((listener) => String(listener).includes('inputTakeover')).length
    )
    assert.equal(supervisionListenerCount('before-input-event'), 1, `${label}: duplicate keyboard supervision listener`)
    assert.equal(supervisionListenerCount('before-mouse-event'), 1, `${label}: duplicate pointer supervision listener`)
    return tabId
  }
  const makeBinding = (claim: BrowserTargetClaim) => ({
    partition: claim.logicalKey.partition,
    parentTaskId,
    ownerRunId,
    browserTaskId: route.browserTaskId,
    surface: claim.surface,
    scopeId,
    profileId: null,
    sessionId: null,
    tabId: claim.logicalKey.tabId,
    physicalTargetToken: claim.physicalTargetToken!,
    bootIncarnationId: claim.bootIncarnationId!,
    claimId: claim.claimId,
    generation: claim.generation,
  })

  try {
    const keyTab = await makeClaim('key')
    const pointerTab = await makeClaim('pointer')
    const navigationTabs = await Promise.all(['navigate', 'back', 'forward', 'reload', 'echo', 'sibling'].map(makeClaim))

    const keyContents = webContentsByTab.get(keyTab)!
    keyContents.focus()
    keyContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
    await waitFor(() => claimService.read({ partition: partitionForBrowserProfile(null), tabId: keyTab })?.state === 'user_owned' ? true : null, 'keyboard takeover')
    assert.equal(controller.isBrowserWorkflowWriteAdmitted(bindings.get(keyTab)!), false)

    const pointerContents = webContentsByTab.get(pointerTab)!
    pointerContents.focus()
    pointerContents.sendInputEvent({ type: 'mouseDown', x: 12, y: 12, button: 'left', clickCount: 1 })
    await waitFor(() => claimService.read({ partition: partitionForBrowserProfile(null), tabId: pointerTab })?.state === 'user_owned' ? true : null, 'pointer takeover')
    assert.equal(controller.isBrowserWorkflowWriteAdmitted(bindings.get(pointerTab)!), false)

    const [navigateTab, backTab, forwardTab, reloadTab, echoTab, siblingTab] = navigationTabs
    await controller.navigate(navigateTab, `${url}?navigated=1`)
    controller.goBack(backTab)
    controller.goForward(forwardTab)
    controller.reload(reloadTab)
    for (const [label, tabId] of [['navigate', navigateTab], ['back', backTab], ['forward', forwardTab], ['reload', reloadTab]] as const) {
      await waitFor(() => claimService.read({ partition: partitionForBrowserProfile(null), tabId })?.state === 'user_owned' ? true : null, `${label} takeover`)
    }
    assert.equal(claimService.read({ partition: partitionForBrowserProfile(null), tabId: siblingTab })?.state, 'held')

    const echoClaim = claims.get(echoTab)!
    const actionId = claimService.beginAgentAction(identity(echoClaim))
    if (typeof actionId !== 'string') throw new Error(actionId.message)
    controller.reload(echoTab)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(claimService.read(echoClaim.logicalKey)?.state, 'held', 'same-target agent navigation echo must be suppressed')
    assert.equal(claimService.read({ partition: partitionForBrowserProfile(null), tabId: siblingTab })?.state, 'held', 'echo suppression must not alter a sibling target')
    claimService.endAgentAction(identity(echoClaim), actionId)
    controller.reload(echoTab)
    await waitFor(() => claimService.read(echoClaim.logicalKey)?.state === 'user_owned' ? true : null, 'user navigation after echo')

    const parent = db.prepare('SELECT human_takeover_ref_json FROM task_projections WHERE task_id = ?')
      .get<{ human_takeover_ref_json: string | null }>(parentTaskId)
    assert.equal(JSON.parse(parent?.human_takeover_ref_json || '{}').state, 'pending')
    assert.equal(repository.current(parentTaskId, 'clean_base')?.checkpointId, cleanCheckpoint.checkpointId)

    const expiredTakeovers = await repository.expirePendingHumanTakeovers({ now: '2026-07-23T00:01:00.000Z' })
    assert.deepEqual(expiredTakeovers, [parentTaskId])
    const expiredParent = db.prepare('SELECT human_takeover_ref_json, waiting_for FROM task_projections WHERE task_id = ?')
      .get<{ human_takeover_ref_json: string | null; waiting_for: string }>(parentTaskId)
    assert.equal(expiredParent?.human_takeover_ref_json, null)
    assert.equal(expiredParent?.waiting_for, 'none')

    db.prepare(
      `UPDATE browser_target_claims
          SET boot_incarnation_id = 'old-boot', physical_target_token = 'old-boot:stale:1'
        WHERE state IN ('held', 'user_owned', 'suspended')`,
    ).run()
    __resetBrowserTargetClaimServiceForTests()
    claimService = getBrowserTargetClaimService()
    const restartedClaims = claimService.list()
    assert.equal(restartedClaims.filter((claim) => ['held', 'user_owned', 'suspended'].includes(claim.state)).length, 0)

    const freshTab = await makeClaim('fresh-after-restart')
    assert.equal(claimService.read({ partition: partitionForBrowserProfile(null), tabId: freshTab })?.state, 'held')
  } finally {
    for (const tab of controller.getTabList()) controller.closeTab(tab.id)
    mainWindow.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    dbManager.close()
  }
}
