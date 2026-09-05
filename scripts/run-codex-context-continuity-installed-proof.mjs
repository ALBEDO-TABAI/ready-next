#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
  existsSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertRecordedProcessesExited,
  captureProcessCensus,
  closeChildProcess,
  enableAgentPanelHarness,
  evaluateCdp,
  openCdp,
  runCdpCommand,
  sha256File,
  sqlQuote,
  sqliteJson,
} from './codex-runtime/live-proof-runtime.mjs'

const root = resolve(process.cwd())
const dmgPath = resolve(process.argv[2] || '')
const profileModeArg = process.argv.find((value) => value.startsWith('--profile-mode='))
const profileMode = profileModeArg?.slice('--profile-mode='.length) || 'fresh'
const legacyFixtureArg = process.argv.find((value) => value.startsWith('--legacy-db-fixture='))
const legacyFixturePath = legacyFixtureArg
  ? resolve(legacyFixtureArg.slice('--legacy-db-fixture='.length))
  : null
if (!process.argv[2] || !existsSync(dmgPath) || !statSync(dmgPath).isFile()) {
  throw new Error('usage: node scripts/run-codex-context-continuity-installed-proof.mjs /absolute/path/Ready.dmg')
}
if (!['fresh', 'upgrade'].includes(profileMode)
  || (profileMode === 'upgrade' && (!legacyFixturePath || !existsSync(legacyFixturePath)))) {
  throw new Error('upgrade profile requires --legacy-db-fixture=/absolute/path/pre118.db')
}

const proofId = randomBytes(16).toString('hex')
const packageSha256 = sha256File(dmgPath)
const runRoot = resolve(root, 'outputs/codex-context-continuity-installed', packageSha256, proofId)
const profilePath = mkdtempSync(resolve(tmpdir(), 'ready-context-proof-profile-'))
const tempPath = resolve(runRoot, '.tmp')
const databasePath = resolve(profilePath, 'ready.db')
const reportPath = resolve(runRoot, 'installed-proof.json')
const retryScreenshotPath = resolve(runRoot, 'failed-turn-same-thread-continuity.png')
const contextScreenshotPath = resolve(runRoot, 'context-usage-meter.png')
const replySurfaceScreenshotPath = resolve(runRoot, 'reply-list-and-live-duration.png')
const installedRoot = mkdtempSync(resolve(tmpdir(), 'ready-context-proof-install-'))
const mountPoint = mkdtempSync(resolve(tmpdir(), 'ready-context-proof-dmg-'))
const proofNonce = randomBytes(24).toString('hex')
const fixtureCredential = `ready-context-proof-${proofId}`
const fixtureModel = 'ready-context-proof-model'
const expectedEffectiveContextWindow = 258_400
const expectedLatestInputTokens = 40
const setupMarker = `READY_CONTEXT_SETUP_${proofId}`
const followupMarker = `READY_CONTEXT_FOLLOWUP_${proofId}`
const firstAnswer = `已记住：广州花都，9月27日。校验词 ${setupMarker}`
const secondAnswer = '连续上下文已确认：广州花都，9月27日。'
const retryRootMarker = `READY_EXPLICIT_RETRY_ROOT_${proofId}`
const retryRootPrompt = `${retryRootMarker}：总结一下我现在看的这个小红书内容`
const retryFollowupMarker = `READY_FAILED_TURN_FOLLOWUP_${proofId}`
const retryAnswer = `失败轮上下文仍在同一线程中。校验词 ${retryRootMarker}`
const replySurfaceMarker = `READY_REPLY_SURFACE_${proofId}`
const replySurfaceAnswer = '回复呈现验收\n\n1. 第一项\n1. 第二项\n1. 第三项'
const divergenceAcceptedMarker = `READY_DIVERGENCE_ACCEPTED_${proofId}`
const divergenceTailMarker = `READY_DIVERGENCE_TAIL_${proofId}`
const divergenceFollowupMarker = `READY_DIVERGENCE_FOLLOWUP_${proofId}`
const divergenceAnswer = `分叉后的遗漏消息已恰好消费一次。${divergenceTailMarker}`
const multiTailAcceptedMarker = `READY_MULTI_TAIL_ACCEPTED_${proofId}`
const multiTailOlderMarker = `READY_MULTI_TAIL_OLDER_${proofId}`
const multiTailSelectedMarker = `READY_MULTI_TAIL_SELECTED_${proofId}`
const freshRetryMarker = `READY_FRESH_RETRY_${proofId}`
const resourceAcceptedMarker = `READY_RESOURCE_ACCEPTED_${proofId}`
const resourceTailMarker = `READY_RESOURCE_TAIL_${proofId}`
const resourceFollowupMarker = `READY_RESOURCE_FOLLOWUP_${proofId}`
const resourceAnswer = '资源尾部已省略，当前任务没有继承旧资源。'
const resetAcceptedMarker = `READY_RESET_ACCEPTED_${proofId}`
const resetTailMarker = `READY_RESET_TAIL_${proofId}`
const resetFollowupMarker = `READY_RESET_FOLLOWUP_${proofId}`
const resetAnswer = '重置后的新会话没有继承旧内容。'
const effectRootMarker = `READY_EFFECT_ROOT_${proofId}`
const effectFollowupMarker = `READY_EFFECT_FOLLOWUP_${proofId}`
const effectAnswer = '普通新消息没有重放上一轮动作。'
const effectContent = `READY_EFFECT_CONTENT_${proofId}\n`
const effectContentSha256 = createHash('sha256').update(effectContent).digest('hex')
const resourceFilePath = resolve(runRoot, 'resource-tail.txt')
const effectTargetRoot = resolve(runRoot, 'effect-target')

mkdirSync(profilePath, { recursive: true, mode: 0o700 })
mkdirSync(tempPath, { recursive: true, mode: 0o700 })
mkdirSync(effectTargetRoot, { recursive: true, mode: 0o700 })
writeFileSync(resourceFilePath, `RESOURCE_SENTINEL_${proofId}\n`, { mode: 0o600 })
if (profileMode === 'upgrade') copyFileSync(legacyFixturePath, databasePath)

const fixture = await startFixtureProvider()
seedIsolatedProvider(fixture.baseUrl)

let mounted = false
let runtime = null
let proofFailed = false
try {
  execFileSync('/usr/bin/hdiutil', ['verify', dmgPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('/usr/bin/hdiutil', [
    'attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  mounted = true

  const appPath = resolve(mountPoint, 'Ready.app')
  const applicationsLink = resolve(mountPoint, 'Applications')
  const seedPath = resolve(appPath, 'Contents/Resources/ai-settings.seed.json')
  const codexPath = resolve(appPath, 'Contents/Resources/codex-runtime/aarch64-apple-darwin/codex')
  const packagedSeed = JSON.parse(readFileSync(seedPath, 'utf8'))
  if (!lstatSync(applicationsLink).isSymbolicLink() || readlinkSync(applicationsLink) !== '/Applications') {
    throw new Error('mounted Applications link mismatch')
  }
  if (!packagedSeed || Array.isArray(packagedSeed) || Object.keys(packagedSeed).length !== 0) {
    throw new Error('packaged AI seed is not empty')
  }
  if (existsSync(resolve(appPath, 'Contents/Resources/skill-runtime'))) {
    throw new Error('slim package unexpectedly contains skill-runtime')
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=1', appPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const appVersion = execFileSync('/usr/libexec/PlistBuddy', [
    '-c', 'Print :CFBundleShortVersionString', resolve(appPath, 'Contents/Info.plist'),
  ], { encoding: 'utf8' }).trim()
  const codexVersion = execFileSync(codexPath, ['--version'], { encoding: 'utf8' }).trim()
  const mountedExecutablePath = realpathSync(resolve(appPath, 'Contents/MacOS/Ready'))
  const mountedAsarPath = resolve(appPath, 'Contents/Resources/app.asar')
  const installedAppPath = resolve(installedRoot, 'Ready.app')
  mkdirSync(installedRoot, { recursive: true, mode: 0o700 })
  execFileSync('/usr/bin/ditto', [appPath, installedAppPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const executablePath = realpathSync(resolve(installedAppPath, 'Contents/MacOS/Ready'))
  const installedAsarPath = resolve(installedAppPath, 'Contents/Resources/app.asar')
  if (sha256File(executablePath) !== sha256File(mountedExecutablePath)
    || sha256File(installedAsarPath) !== sha256File(mountedAsarPath)) {
    throw new Error('isolated installed app identity mismatch')
  }
  execFileSync('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=1', installedAppPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  mounted = false
  rmSync(mountPoint, { recursive: true, force: true })

  runtime = await launchInstalledApp(executablePath)
  let upgradeBoot = null
  if (profileMode === 'upgrade') {
    upgradeBoot = await evaluateCdp(runtime.cdp, `(async () => {
      const before = await window.electronAPI.agent.readCodexActionSurface({
        aliasId: 'pre118-scope', aliasGeneration: 1,
      });
      if (!before.success) return { ok: false, stage: 'surface-before', before };
      const lifecycle = before.data.lifecycle;
      const resetGate = lifecycle.actions.reset;
      const closeGate = lifecycle.actions.close;
      const legacyPresentation = await window.electronAPI.agent.readProductTurnPresentation(
        'pre118-run-terminal', 'browser',
      );
      const afterPresentationSurface = await window.electronAPI.agent.readCodexActionSurface({
        aliasId: 'pre118-scope', aliasGeneration: 1,
      });
      if (resetGate.availability !== 'ready' || !resetGate.requestRef) {
        return { ok: false, stage: 'reset-gate', before, legacyPresentation, afterPresentationSurface };
      }
      const reset = await window.electronAPI.agent.resetSession({
        aliasId: 'pre118-scope',
        aliasGeneration: 1,
        readyRunId: lifecycle.activeReadyRunId,
        actionRequestRef: resetGate.requestRef,
      });
      if (!reset.ok) return { ok: false, stage: 'reset', before, reset, legacyPresentation, afterPresentationSurface };
      const after = await window.electronAPI.agent.readCodexActionSurface({
        aliasId: 'pre118-scope', aliasGeneration: reset.newGeneration,
      });
      return { ok: after.success === true, before, reset, after, closeGate, legacyPresentation, afterPresentationSurface };
    })()`, 30_000)
    const beforeLifecycle = upgradeBoot?.before?.data?.lifecycle
    const beforeHead = upgradeBoot?.before?.data?.head
    const legacyAction = upgradeBoot?.legacyPresentation?.data?.actionProjection
    if (!upgradeBoot?.ok
      || beforeLifecycle?.activeReadyRunId !== 'pre118-run-e1'
      || beforeHead?.actions?.send_new_message?.availability !== 'blocked'
      || !beforeHead?.actions?.send_new_message?.blockers?.includes('legacy_prepared_contract')
      || beforeLifecycle?.actions?.stop?.availability !== 'not_applicable'
      || beforeLifecycle?.actions?.reset?.availability !== 'ready'
      || beforeLifecycle?.actions?.close?.availability !== 'ready'
      || beforeLifecycle?.actions?.manual_compact?.availability !== 'not_applicable'
      || !beforeLifecycle?.actions?.manual_compact?.blockers?.includes('legacy_context_boundary')
      || upgradeBoot.reset?.newGeneration !== 2
      || upgradeBoot.after?.data?.head?.actions?.send_new_message?.availability !== 'ready'
      || legacyAction?.retryEvidenceKind !== 'unavailable_legacy'
      || legacyAction?.headProjectionRef !== null
      || legacyAction?.currentReadyMemoryRef !== null
      || legacyAction?.currentTrustedEnvironmentRef !== null
      || legacyAction?.retry_failed_task?.availability !== 'not_applicable') {
      throw new Error(`installed upgrade action contract mismatch: ${JSON.stringify(upgradeBoot)}`)
    }
  }
  const scenario = await evaluateCdp(runtime.cdp, `(async () => {
    const harness = window.__READY_AGENT_TEST__;
    const succeeded = (result) => result?.ok && result.sendResult?.disposition === 'terminal_success';
    document.querySelector('button[title="展开聊天面板"]')?.click();
    const created = await harness.createVisibleSession();
    if (!created.ok) return { ok: false, stage: 'create', error: created.error };
    const first = await harness.submit(${JSON.stringify(`${setupMarker}：我9月27日去广州花都。`)}, {
      mode: 'store', waitForIdle: true, awaitStoreSend: true,
      timeoutMs: 120000, attachments: [], requireAssistantMessage: true,
    });
    if (!succeeded(first)) return { ok: false, stage: 'first', first };
    const firstScopeId = first.after?.currentScopeId;
    const second = await harness.submit(${JSON.stringify(`${followupMarker}：那么降雨概率怎么样？`)}, {
      mode: 'store', waitForIdle: true, awaitStoreSend: true,
      timeoutMs: 120000, attachments: [], requireAssistantMessage: true,
    });
    if (!succeeded(second)) return { ok: false, stage: 'context-second', first, second };
    await new Promise((resolve) => setTimeout(resolve, 750));
    const contextSnapshot = await harness.snapshot?.() || {};
    const contextMessages = second.after?.messages || contextSnapshot.messages || [];
    const contextRequestId = contextSnapshot.runtime?.activeRun?.requestId || null;
    const contextRunIds = contextRequestId
      ? [contextRequestId]
      : contextMessages.flatMap((message) => {
          const match = /^assistant:[^:]+:([^:]+):terminal$/.exec(String(message.id || ''));
          return match?.[1] ? [match[1]] : [];
        });
    const contextReceipts = contextRunIds.length > 0
      ? await window.electronAPI.agent.readProductTurnPresentations(contextRunIds, 'browser')
      : { success: true, data: [] };
    const receiptContextUsage = contextReceipts.success
      ? contextReceipts.data?.at(-1)?.contextUsage || null
      : null;
    const immediateMeter = document.querySelector('[data-agent-context-usage-meter="true"]');
    const immediateMeterState = immediateMeter ? {
      title: immediateMeter.getAttribute('title'),
      ariaLabel: immediateMeter.getAttribute('aria-label'),
    } : null;

    const retryCreated = await harness.createVisibleSession();
    if (!retryCreated.ok) return { ok: false, stage: 'retry-create', retryCreated };
    const failed = await harness.submit(${JSON.stringify(retryRootPrompt)}, {
      mode: 'store', waitForIdle: true, awaitStoreSend: true,
      timeoutMs: 120000, attachments: [], requireAssistantMessage: true,
    });
    if (failed.sendResult?.disposition !== 'terminal_failure_after_persistence') {
      return { ok: false, stage: 'retry-failure', failed };
    }
    const retryScopeId = failed.after?.currentScopeId;
    const retried = await harness.submit(${JSON.stringify(`${retryFollowupMarker}：继续处理刚才的任务。`)}, {
      mode: 'store', waitForIdle: true, awaitStoreSend: true,
      timeoutMs: 120000, attachments: [], requireAssistantMessage: true,
    });
    if (!succeeded(retried)) return { ok: false, stage: 'retry-followup', retried };
    const retrySnapshot = await harness.snapshot?.() || {};
    const visibleMessages = retried.after?.messages || retrySnapshot.messages || [];
    const replyCreated = await harness.createVisibleSession();
    if (!replyCreated.ok) return { ok: false, stage: 'reply-create', replyCreated };
    const replyPromise = harness.submit(${JSON.stringify(replySurfaceMarker)}, {
      mode: 'store', waitForIdle: true, awaitStoreSend: true,
      timeoutMs: 120000, attachments: [], requireAssistantMessage: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const liveMeter = document.querySelector('[data-agent-run-duration-meter="true"]');
    const liveMeterText = liveMeter?.textContent || '';
    const liveDuration = {
      present: Boolean(liveMeter),
      text: liveMeterText,
      labelCount: (liveMeterText.match(/本轮用时/g) || []).length,
      ariaLabel: liveMeter?.getAttribute('aria-label') || null,
    };
    const reply = await replyPromise;
    if (!succeeded(reply)) return { ok: false, stage: 'reply', reply, liveDuration };
    await new Promise((resolve) => setTimeout(resolve, 200));
    const lists = Array.from(document.querySelectorAll(
      '.ready-agent-prose ol[data-ready-ordered-list="true"]',
    ));
    const list = lists.at(-1) || null;
    const listStyle = list ? getComputedStyle(list) : null;
    const orderedList = list ? {
      tagName: list.tagName,
      start: list.getAttribute('start'),
      itemCount: Array.from(list.children).filter((child) => child.tagName === 'LI').length,
      listStyleType: listStyle?.listStyleType || null,
      listStylePosition: listStyle?.listStylePosition || null,
      itemDisplays: Array.from(list.children).map((child) => getComputedStyle(child).display),
      text: list.textContent || '',
    } : null;
    return {
      ok: true,
      firstScopeId,
      secondScopeId: second.after?.currentScopeId || retrySnapshot.currentScopeId,
      retryScopeId,
      retriedScopeId: retried.after?.currentScopeId || retrySnapshot.currentScopeId,
      replyScopeId: reply.after?.currentScopeId || null,
      first,
      second,
      failed,
      retried,
      reply,
      liveDuration,
      orderedList,
      contextUsage: contextSnapshot.runtime?.activeRun?.contextUsage || null,
      contextRequestId,
      receiptContextUsage,
      contextReceiptProbe: contextReceipts,
      immediateMeterState,
      contextMessages: contextMessages.map((message) => ({
        type: message.type,
        content: message.content,
        meta: message.meta,
      })),
      messages: visibleMessages.map((message) => ({
        type: message.type,
        content: message.content,
        meta: message.meta,
      })),
    };
  })()`, 270_000)
  const continuityScenarios = await evaluateCdp(runtime.cdp, `(async () => {
    const harness = window.__READY_AGENT_TEST__;
    const documentModeButton = document.querySelector(
      '.ready-chat-mode-tabs-dock button[data-mode="document"]',
    );
    if (!documentModeButton) return { ok: false, stage: 'document-mode-button' };
    documentModeButton.click();
    for (let attempt = 0; attempt < 80
      && !documentModeButton.classList.contains('is-active'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!documentModeButton.classList.contains('is-active')) {
      return { ok: false, stage: 'document-mode-switch' };
    }
    const runIdOf = (result) => {
      const direct = result?.sendResult?.requestId || result?.after?.runtime?.activeRun?.requestId;
      if (direct) return direct;
      return (result?.after?.messages || []).flatMap((message) => {
        const match = /^assistant:[^:]+:([^:]+):terminal$/.exec(String(message.id || ''));
        return match?.[1] ? [match[1]] : [];
      }).at(-1) || null;
    };
    const waitSurface = async (scopeId, aliasGeneration) => {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const surface = await window.electronAPI.agent.readCodexActionSurface({
          aliasId: scopeId, aliasGeneration,
        });
        if (surface.success
          && surface.data?.head?.actions?.send_new_message?.availability === 'ready') {
          return surface;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return null;
    };
    const readPresentation = async (readyRunId) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const result = await window.electronAPI.agent.readProductTurnPresentation(
          readyRunId, 'document',
        );
        if (result.success) return result;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return null;
    };
    const submit = (text, attachments = []) => harness.submit(text, {
      mode: 'store', waitForIdle: true, awaitStoreSend: true,
      timeoutMs: 180000, attachments, requireAssistantMessage: true,
    });
    const clickRetry = async (predecessorRunId) => {
      const button = document.querySelector('button[aria-label="再试一次"]');
      if (!button || button.disabled) throw new Error('visible_retry_button_missing');
      button.click();
      for (let attempt = 0; attempt < 720; attempt += 1) {
        const state = await harness.snapshot();
        const terminal = [...state.messages].reverse().find((m) => m.type === 'agent'
          && m.runId && m.runId !== predecessorRunId && m.terminalReason);
        const idle = !state.runtime.isStreaming && !state.runtime.foregroundBusy;
        if (terminal && idle) return { state, terminal };
        if (idle && state.infoCards?.some((card) => card.kind === 'soft_error')) {
          throw new Error('visible_retry_button_rejected: ' + JSON.stringify(state.infoCards));
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('visible_retry_button_terminal_timeout');
    };
    const succeeded = (result) => result?.ok && result.sendResult?.disposition === 'terminal_success';
    const failed = (result) => result?.sendResult?.disposition === 'terminal_failure_after_persistence';

    const divergenceCreated = await harness.createVisibleSession();
    if (!divergenceCreated.ok) return { ok: false, stage: 'divergence-create' };
    const divergenceAccepted = await submit(${JSON.stringify(divergenceAcceptedMarker)});
    if (!succeeded(divergenceAccepted)) return { ok: false, stage: 'divergence-accepted', divergenceAccepted };
    const divergenceFailed = await submit(${JSON.stringify(divergenceTailMarker)});
    if (!failed(divergenceFailed)) return { ok: false, stage: 'divergence-failure', divergenceFailed };
    const divergenceScopeId = divergenceFailed.after?.currentScopeId;
    const divergenceRunId = runIdOf(divergenceFailed);
    if (!divergenceScopeId || !divergenceRunId) {
      return { ok: false, stage: 'divergence-identity', divergenceFailed };
    }
    const divergenceSurface = await waitSurface(divergenceScopeId, 2);
    const divergencePresentation = await readPresentation(divergenceRunId);
    if (!divergenceSurface || !divergencePresentation?.success) {
      return { ok: false, stage: 'divergence-materialization', divergenceSurface, divergencePresentation };
    }
    const divergenceFollowup = await submit(${JSON.stringify(divergenceFollowupMarker)});
    if (!succeeded(divergenceFollowup)) {
      return { ok: false, stage: 'divergence-followup', divergenceFollowup };
    }

    const freshCreated = await harness.createVisibleSession();
    if (!freshCreated.ok) return { ok: false, stage: 'fresh-retry-create' };
    const freshFailed = await submit(${JSON.stringify(freshRetryMarker)});
    if (!failed(freshFailed)) return { ok: false, stage: 'fresh-retry-failure', freshFailed };
    const freshScopeId = freshFailed.after.currentScopeId;
    const freshRunId = runIdOf(freshFailed);
    const freshSurface = await waitSurface(freshScopeId, 2);
    const freshPresentation = await readPresentation(freshRunId);
    if (!freshSurface || freshPresentation?.data?.actionProjection?.retry_failed_task?.availability !== 'ready') {
      return { ok: false, stage: 'fresh-retry-gate', freshSurface, freshPresentation };
    }
    const scopes = await window.electronAPI.agent.listConversationScopes();
    const freshScope = scopes.data.find((scope) => scope.id === freshScopeId);
    const rejectionChecks = [];
    for (const variant of ['continue', 'resume', 'resource', 'attachment']) {
      const text = variant === 'continue' || variant === 'resume' ? variant : '再试一次';
      const requestId = 'proof-reject-' + variant + '-' + ${JSON.stringify(proofId)};
      const result = await window.electronAPI.agent.sendScoped({
        scopeId: freshScopeId, requestId, message: text,
        expectedAliasGeneration: 2, expectedMessageVisibilityEpoch: freshSurface.data.scopeEpoch,
        explicitRetry: { predecessorRunId: freshRunId, predecessorPresentationDigest: freshPresentation.data.presentationDigest },
        ...(variant === 'resource' ? { resources: [{ kind: 'quoted_text', id: 'new-resource', name: 'new', text: 'new target' }] } : {}),
        userMessage: { id: requestId + '-message', content: text, timestamp: new Date().toISOString(),
          meta: { sourceKind: freshScope.sourceKind, sourceId: freshScope.sourceId, threadKey: freshScope.threadKey,
            direction: 'local-input', workbenchMode: 'document', actionAuthorizationMode: freshScope.meta?.actionAuthorizationMode || 'ask' },
          attachmentConfirmation: { selectedCount: variant === 'attachment' ? 1 : 0,
            metadataCount: 0, inputIncludedCount: 0, inputFailedCount: 0 } },
      });
      rejectionChecks.push({ variant, requestId, result });
      if (result.disposition !== 'rejected_before_persistence' || result.errorKind !== 'explicit_retry_control_invalid'
        || result.recoveryActionRef) return { ok: false, stage: 'fresh-retry-rejection', rejectionChecks };
    }
    const freshRetried = await clickRetry(freshRunId);
    if (freshRetried.terminal.terminalReason !== 'done') return { ok: false, stage: 'fresh-retry-button', freshRetried };

    const multiTailCreated = await harness.createVisibleSession();
    if (!multiTailCreated.ok) return { ok: false, stage: 'multi-tail-create' };
    const multiTailAccepted = await submit(${JSON.stringify(multiTailAcceptedMarker)});
    if (!succeeded(multiTailAccepted)) return { ok: false, stage: 'multi-tail-accepted', multiTailAccepted };
    const multiTailOlder = await submit(${JSON.stringify(multiTailOlderMarker)});
    if (!failed(multiTailOlder)) return { ok: false, stage: 'multi-tail-older', multiTailOlder };
    const multiTailSelected = await submit(${JSON.stringify(multiTailSelectedMarker)});
    if (!failed(multiTailSelected)) return { ok: false, stage: 'multi-tail-selected', multiTailSelected };
    const multiTailScopeId = multiTailSelected.after?.currentScopeId;
    const multiTailSelectedRunId = runIdOf(multiTailSelected);
    if (!multiTailScopeId || !multiTailSelectedRunId) {
      return { ok: false, stage: 'multi-tail-identity', multiTailSelected };
    }
    const multiTailRetries = [];
    let predecessorRunId = multiTailSelectedRunId;
    for (let generation = 2; generation <= 3; generation += 1) {
      const surface = await waitSurface(multiTailScopeId, generation);
      const presentation = await readPresentation(predecessorRunId);
      if (!surface || presentation?.data?.actionProjection?.retry_failed_task?.availability !== 'ready') {
        return { ok: false, stage: 'multi-tail-retry-gate', generation, surface, presentation };
      }
      // Use the public composer route, including natural Retry resolution and Main.prepareIngress.
      const before = await harness.snapshot();
      const latestTerminal = [...before.messages].reverse().find((message) => message.type === 'agent'
        && message.runId && message.terminalReason);
      if (latestTerminal?.runId !== predecessorRunId || latestTerminal.terminalReason === 'done') {
        return { ok: false, stage: 'multi-tail-retry-message-owner', generation, predecessorRunId,
          messages: before.messages.map(({ id, type, runId, terminalReason }) => ({ id, type, runId, terminalReason })) };
      }
      const result = await submit('再试一次');
      const readyRunId = runIdOf(result);
      if (!readyRunId || readyRunId === predecessorRunId
        || (generation === 2 ? !failed(result) : !succeeded(result))) {
        return { ok: false, stage: 'multi-tail-retry-submit', generation, result };
      }
      multiTailRetries.push({ readyRunId, predecessorRunId, displayedTerminal: latestTerminal });
      predecessorRunId = readyRunId;
    }

    const resourceCreated = await harness.createVisibleSession();
    if (!resourceCreated.ok) return { ok: false, stage: 'resource-create' };
    const resourceAccepted = await submit(${JSON.stringify(resourceAcceptedMarker)});
    if (!succeeded(resourceAccepted)) return { ok: false, stage: 'resource-accepted', resourceAccepted };
    const resourceFailed = await submit(${JSON.stringify(resourceTailMarker)}, [{
      path: ${JSON.stringify(resourceFilePath)}, name: ${JSON.stringify(basename(resourceFilePath))},
      size: ${statSync(resourceFilePath).size},
    }]);
    if (!failed(resourceFailed)) return { ok: false, stage: 'resource-failure', resourceFailed };
    const resourceScopeId = resourceFailed.after?.currentScopeId;
    const resourceRunId = runIdOf(resourceFailed);
    if (!resourceScopeId || !resourceRunId) {
      return { ok: false, stage: 'resource-identity', resourceFailed };
    }
    const resourceSurface = await waitSurface(resourceScopeId, 2);
    const resourcePresentation = await readPresentation(resourceRunId);
    if (!resourceSurface || !resourcePresentation?.success) {
      return { ok: false, stage: 'resource-materialization', resourceSurface, resourcePresentation, resourceFailed };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const resourceConsequenceText = document.querySelector('[data-ready-send-consequence="true"]')?.textContent || '';
    if (!resourceConsequenceText.includes('上一项') || !resourceConsequenceText.includes('1项需重新附加资源')) {
      return { ok: false, stage: 'resource-consequence-visible', resourceConsequenceText };
    }
    const resourceFollowup = await submit(${JSON.stringify(resourceFollowupMarker)});
    if (!succeeded(resourceFollowup)) return { ok: false, stage: 'resource-followup', resourceFollowup };

    const resetCreated = await harness.createVisibleSession();
    if (!resetCreated.ok) return { ok: false, stage: 'reset-create' };
    const resetAccepted = await submit(${JSON.stringify(resetAcceptedMarker)});
    if (!succeeded(resetAccepted)) return { ok: false, stage: 'reset-accepted', resetAccepted };
    const resetFailed = await submit(${JSON.stringify(resetTailMarker)});
    if (!failed(resetFailed)) return { ok: false, stage: 'reset-failure', resetFailed };
    const resetScopeId = resetFailed.after?.currentScopeId;
    if (!resetScopeId) return { ok: false, stage: 'reset-identity', resetFailed };
    const resetSurface = await waitSurface(resetScopeId, 2);
    const resetGate = resetSurface?.data?.lifecycle?.actions?.reset;
    if (resetGate?.availability !== 'ready' || !resetGate.requestRef) {
      return { ok: false, stage: 'reset-gate', resetSurface };
    }
    const conversationMenu = document.querySelector('button[title="当前对话操作"]');
    if (!conversationMenu) return { ok: false, stage: 'reset-menu' };
    conversationMenu.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const resetButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '重置当前对话',
    );
    if (!resetButton || resetButton.disabled) return { ok: false, stage: 'reset-button' };
    resetButton.click();
    let resetSnapshot = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      resetSnapshot = await harness.snapshot();
      if (resetSnapshot.currentScopeId === resetScopeId && resetSnapshot.messages.length === 0
        && !resetSnapshot.runtime.activeRun) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (resetSnapshot?.currentScopeId !== resetScopeId || resetSnapshot.messages.length !== 0
      || resetSnapshot.runtime.activeRun) return { ok: false, stage: 'reset-visible-state', resetSnapshot };
    const resetAfter = await waitSurface(resetScopeId, 3);
    if (!resetAfter) return { ok: false, stage: 'reset-after', resetAfter };
    const reset = { entry: 'visible_reset_button', visibleMessagesAfter: resetSnapshot.messages.length,
      headVersionAfter: resetAfter.data.head.actionProjectionVersion };
    const resetFollowup = await submit(${JSON.stringify(resetFollowupMarker)});
    if (!succeeded(resetFollowup)) return { ok: false, stage: 'reset-followup', resetFollowup };

    const effectCreated = await harness.createVisibleSession();
    if (!effectCreated.ok) return { ok: false, stage: 'effect-create' };
    const effectFailed = await submit(${JSON.stringify(effectRootMarker)}, [{
      path: ${JSON.stringify(effectTargetRoot)}, name: ${JSON.stringify(basename(effectTargetRoot))},
      isDirectory: true,
    }]);
    if (!failed(effectFailed)) return { ok: false, stage: 'effect-failure', effectFailed };
    const effectScopeId = effectFailed.after?.currentScopeId;
    const effectRunId = runIdOf(effectFailed);
    if (!effectScopeId || !effectRunId) return { ok: false, stage: 'effect-identity', effectFailed };
    const effectSurface = await waitSurface(effectScopeId, 2);
    const effectPresentation = await readPresentation(effectRunId);
    if (!effectSurface || !effectPresentation?.success) {
      return { ok: false, stage: 'effect-materialization', effectSurface, effectPresentation };
    }
    const effectFollowup = await submit(${JSON.stringify(effectFollowupMarker)});
    if (!succeeded(effectFollowup)) return { ok: false, stage: 'effect-followup', effectFollowup };

    return {
      ok: true,
      divergence: {
        scopeId: divergenceScopeId, failedRunId: divergenceRunId,
        followupRunId: runIdOf(divergenceFollowup),
        surface: divergenceSurface.data,
        retry: divergencePresentation.data.actionProjection.retry_failed_task,
      },
      freshRetry: { scopeId: freshScopeId, predecessorRunId: freshRunId,
        readyRunId: freshRetried.terminal.runId, entry: 'visible_retry_button', rejectionChecks },
      multiTailRetry: {
        scopeId: multiTailScopeId, olderRunId: runIdOf(multiTailOlder),
        selectedRunId: multiTailSelectedRunId, retries: multiTailRetries,
      },
      resource: {
        scopeId: resourceScopeId, failedRunId: resourceRunId,
        followupRunId: runIdOf(resourceFollowup),
        surface: resourceSurface.data,
        retry: resourcePresentation.data.actionProjection.retry_failed_task,
        displayedConsequence: resourceConsequenceText,
      },
      reset: { scopeId: resetScopeId, action: reset, surface: resetAfter.data },
      effect: {
        scopeId: effectScopeId, failedRunId: effectRunId,
        followupRunId: runIdOf(effectFollowup),
        surface: effectSurface.data,
        retry: effectPresentation.data.actionProjection.retry_failed_task,
      },
    };
  })()`, 480_000)
  if (!scenario?.ok || !scenario.firstScopeId
    || scenario.firstScopeId !== scenario.secondScopeId
    || !scenario.retryScopeId || scenario.retryScopeId !== scenario.retriedScopeId) {
    throw new Error(`installed two-turn scenario failed: ${JSON.stringify(scenario)}`)
  }
  if (!continuityScenarios?.ok) {
    throw new Error(`installed continuity scenario failed: ${JSON.stringify(continuityScenarios)}`)
  }
  if (!scenario.contextMessages.some((message) => (
    message.type === 'agent' && String(message.content || '').includes(secondAnswer)
  ))) {
    throw new Error('installed second-turn answer did not confirm the first-turn context')
  }
  if (scenario.receiptContextUsage?.usedInputTokens !== expectedLatestInputTokens
    || scenario.receiptContextUsage?.windowTokens !== expectedEffectiveContextWindow
    || scenario.receiptContextUsage?.source !== 'last_model_request'
    || scenario.contextUsage?.usedInputTokens !== expectedLatestInputTokens
    || scenario.contextUsage?.windowTokens !== expectedEffectiveContextWindow
    || scenario.contextUsage?.source !== 'last_model_request') {
    throw new Error(`installed context meter did not receive native usage: ${JSON.stringify({
      active: scenario.contextUsage,
      receipt: scenario.receiptContextUsage,
      receiptProbe: scenario.contextReceiptProbe,
      immediateMeter: scenario.immediateMeterState,
    })}`)
  }
  if (!String(scenario.immediateMeterState?.title || '').includes('40 / 258,400 tokens')) {
    throw new Error(`installed immediate context meter mismatch: ${JSON.stringify({
      active: scenario.contextUsage,
      meter: scenario.immediateMeterState,
    })}`)
  }
  if (!scenario.messages.some((message) => (
    message.type === 'agent' && String(message.content || '').includes(retryAnswer)
  ))) {
    throw new Error('installed failed-turn follow-up did not retain the original task')
  }

  if (!scenario.liveDuration?.present
    || scenario.liveDuration.labelCount !== 1
    || !/本轮用时\s*00:0[1-9]/.test(String(scenario.liveDuration.text || ''))
    || String(scenario.liveDuration.text || '').includes('进行中')) {
    throw new Error(`installed live duration surface mismatch: ${JSON.stringify(scenario.liveDuration)}`)
  }
  if (scenario.orderedList?.tagName !== 'OL'
    || scenario.orderedList?.start !== '1'
    || scenario.orderedList?.itemCount !== 3
    || scenario.orderedList?.listStyleType !== 'decimal'
    || scenario.orderedList?.listStylePosition !== 'outside'
    || scenario.orderedList?.itemDisplays?.some((display) => display !== 'list-item')) {
    throw new Error(`installed ordered list surface mismatch: ${JSON.stringify(scenario.orderedList)}`)
  }

  await runCdpCommand(runtime.cdp, 'Page.enable')
  const replyActivated = await evaluateCdp(runtime.cdp, `(async () => {
    const harness = window.__READY_AGENT_TEST__;
    const target = harness.sessionSummary().sessions.find(
      (session) => session.conversationId === ${JSON.stringify(scenario.replyScopeId)},
    );
    if (!target) return false;
    return (await harness.activateSession(target.id)).ok === true;
  })()`)
  if (!replyActivated) throw new Error('installed reply session activation failed')
  const screenshot = await runCdpCommand(runtime.cdp, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(replySurfaceScreenshotPath, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 })
  const retryActivated = await evaluateCdp(runtime.cdp, `(async () => {
    const harness = window.__READY_AGENT_TEST__;
    const target = harness.sessionSummary().sessions.find(
      (session) => session.conversationId === ${JSON.stringify(scenario.retryScopeId)},
    );
    if (!target) return false;
    return (await harness.activateSession(target.id)).ok === true;
  })()`)
  if (!retryActivated) throw new Error('installed retry session activation failed')
  const retryScreenshot = await runCdpCommand(runtime.cdp, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(retryScreenshotPath, Buffer.from(retryScreenshot.data, 'base64'), { mode: 0o600 })
  const contextMeter = await evaluateCdp(runtime.cdp, `(async () => {
    const harness = window.__READY_AGENT_TEST__;
    const target = harness.sessionSummary().sessions.find(
      (session) => session.conversationId === ${JSON.stringify(scenario.firstScopeId)},
    );
    if (!target) return { ok: false, error: 'context_session_missing' };
    const activated = await harness.activateSession(target.id);
    if (!activated.ok) return { ok: false, error: activated.error || 'context_session_activate_failed' };
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const snapshot = await harness.snapshot();
      const usage = snapshot.runtime?.activeRun?.contextUsage || null;
      const meter = document.querySelector('[data-agent-context-usage-meter="true"]');
      if (usage?.usedInputTokens > 0 && meter) {
        meter.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          ok: true,
          usage,
          title: meter.getAttribute('title'),
          ariaLabel: meter.getAttribute('aria-label'),
          tooltip: document.querySelector('[data-agent-context-usage-tooltip="true"]')?.textContent || null,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, error: 'context_meter_timeout' };
  })()`, 35_000)
  if (!contextMeter?.ok
    || contextMeter.usage?.windowTokens !== expectedEffectiveContextWindow
    || contextMeter.usage?.usedInputTokens !== expectedLatestInputTokens
    || !String(contextMeter.title || '').includes('40 / 258,400 tokens')
    || String(contextMeter.title || '').includes('暂无数据')
    || !String(contextMeter.tooltip || '').includes('上一轮实际请求')) {
    throw new Error(`installed context meter UI mismatch: ${JSON.stringify(contextMeter)}`)
  }
  const contextScreenshot = await runCdpCommand(runtime.cdp, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(contextScreenshotPath, Buffer.from(contextScreenshot.data, 'base64'), { mode: 0o600 })
  const handshake = runtime.handshake
  await stopInstalledApp(runtime)
  runtime = null
  if (!existsSync(databasePath)) throw new Error('installed proof database missing after first shutdown')
  const firstShutdownEvidenceDatabasePath = `${pathToFileURL(databasePath).href}?immutable=1`
  const upgradeCardBeforeSecondBoot = profileMode === 'upgrade'
    ? sqliteJson(firstShutdownEvidenceDatabasePath, `
        SELECT meta_json FROM chat_messages WHERE id = 'pre118-ambiguous-card';
      `)
    : null
  runtime = await launchInstalledApp(executablePath)
  const rehydratedContextMeter = await evaluateCdp(runtime.cdp, `(async () => {
    let harness = window.__READY_AGENT_TEST__;
    for (let attempt = 0; attempt < 120 && !harness; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      harness = window.__READY_AGENT_TEST__;
    }
    if (!harness) return null;
    let summary = harness.sessionSummary();
    let target = summary.sessions.find(
      (session) => session.conversationId === ${JSON.stringify(scenario.firstScopeId)},
    );
    for (let attempt = 0; attempt < 240 && !target; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      summary = harness.sessionSummary();
      target = summary.sessions.find(
        (session) => session.conversationId === ${JSON.stringify(scenario.firstScopeId)},
      );
    }
    if (!target) return null;
    if (summary.activeSessionId !== target.id) {
      const activated = await harness.activateSession(target.id);
      if (!activated.ok) return null;
    }
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const snapshot = await harness.snapshot?.() || {};
      const usage = snapshot.runtime?.activeRun?.contextUsage || null;
      const meter = document.querySelector('[data-agent-context-usage-meter="true"]');
      const title = meter?.getAttribute('title') || null;
      if (title?.includes('40 / 258,400 tokens')) {
        return { usage, title, ariaLabel: meter?.getAttribute('aria-label') || null };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  })()`, 70_000)
  if (!String(rehydratedContextMeter?.title || '').includes('40 / 258,400 tokens')
    || rehydratedContextMeter?.usage?.usedInputTokens !== expectedLatestInputTokens
    || rehydratedContextMeter?.usage?.windowTokens !== expectedEffectiveContextWindow
    || rehydratedContextMeter?.usage?.source !== 'last_model_request') {
    throw new Error(`installed context meter did not rehydrate: ${JSON.stringify(rehydratedContextMeter)}`)
  }
  await stopInstalledApp(runtime)
  runtime = null
  if (!existsSync(databasePath)) throw new Error('installed proof database missing after shutdown')
  const evidenceDatabasePath = `${pathToFileURL(databasePath).href}?immutable=1`

  const threadRows = sqliteJson(evidenceDatabasePath, `
    SELECT thread_binding_id, ready_conversation_alias, alias_generation,
           ready_scope_id, codex_thread_id, retired_at, retired_reason,
           runtime_manifest_digest, protocol_schema_digest
      FROM codex_thread_bindings
     WHERE ready_scope_id = ${sqlQuote(scenario.firstScopeId)}
     ORDER BY created_at ASC;
  `)
  if (threadRows.length !== 1 || !threadRows[0].codex_thread_id
    || threadRows[0].retired_at !== null || threadRows[0].alias_generation !== 1) {
    throw new Error(`installed thread continuity mismatch: ${JSON.stringify(threadRows)}`)
  }
  const turnRows = sqliteJson(evidenceDatabasePath, `
    SELECT ready_run_id, thread_binding_id, codex_thread_id, codex_turn_id,
           product_closeout_at
      FROM codex_turn_bindings
     WHERE thread_binding_id = ${sqlQuote(threadRows[0].thread_binding_id)}
     ORDER BY ingress_admitted_at ASC;
  `)
  if (turnRows.length !== 2
    || turnRows.some((turn) => turn.codex_thread_id !== threadRows[0].codex_thread_id
      || !turn.codex_turn_id || !turn.product_closeout_at)
    || turnRows[0].codex_turn_id === turnRows[1].codex_turn_id) {
    throw new Error(`installed turn continuity mismatch: ${JSON.stringify(turnRows)}`)
  }
  const contextWindowRows = sqliteJson(evidenceDatabasePath, `
    SELECT run_id, context_window
      FROM run_meta
     WHERE run_id IN (${turnRows.map((row) => sqlQuote(row.ready_run_id)).join(',')})
     ORDER BY created_at ASC;
  `)
  if (contextWindowRows.length !== 2
    || contextWindowRows.some((row) => row.context_window !== expectedEffectiveContextWindow)) {
    throw new Error(`installed context window persistence mismatch: ${JSON.stringify(contextWindowRows)}`)
  }
  if (fixture.contextChecks.length !== 1 || fixture.contextChecks[0].seen !== true) {
    throw new Error(`fixture did not receive first-turn context: ${JSON.stringify(fixture.contextChecks)}`)
  }
  let upgradeEvidence = null
  if (profileMode === 'upgrade') {
    const sentinel = sqliteJson(evidenceDatabasePath, `
      SELECT value FROM settings WHERE key = 'codex_pre118_fixture_sentinel';
    `)
    const migratedThread = sqliteJson(evidenceDatabasePath, `
      SELECT thread_binding_id, alias_generation, thread_materialization_kind,
             action_projection_sequence, retired_at, retired_reason,
             runtime_manifest_digest, protocol_schema_digest
        FROM codex_thread_bindings
       WHERE ready_conversation_alias = 'pre118-scope'
       ORDER BY alias_generation;
    `)
    const migratedTurn = sqliteJson(evidenceDatabasePath, `
      SELECT ready_run_id, turn_start_reservation_released_at,
             turn_start_reservation_release_reason, effect_authority_closed_at,
             terminal_facts_digest, product_terminal_digest
        FROM codex_turn_bindings
       WHERE ready_run_id IN ('pre118-run-e1', 'pre118-run-malformed', 'pre118-run-terminal')
       ORDER BY ready_run_id;
    `)
    const migration = sqliteJson(evidenceDatabasePath, `
      SELECT name FROM migrations
       WHERE name = '118_codex_native_continuity_terminal_head_v3';
    `)
    const legacyCard = sqliteJson(evidenceDatabasePath, `
      SELECT meta_json,
             json_extract(meta_json, '$.askUserQuestions.status') AS status,
             json_extract(meta_json, '$.askUserQuestions.cancelReason') AS cancel_reason
        FROM chat_messages WHERE id = 'pre118-ambiguous-card';
    `)
    const legacyFence = sqliteJson(evidenceDatabasePath, `
      SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = 'pre118-thread-binding';
    `)
    const schemaObjects = sqliteJson(evidenceDatabasePath, `
      SELECT type, name FROM sqlite_master
       WHERE name IN (
         'idx_codex_turn_gateway_claim',
         'codex_native_coverage_no_delete',
         'codex_product_effect_no_delete',
         'codex_turn_coverage_ref_update'
       ) ORDER BY type, name;
    `)
    const retired = migratedThread[0]
    const successor = migratedThread[1]
    const openLegacyTurns = migratedTurn.filter((row) => (
      row.ready_run_id === 'pre118-run-e1' || row.ready_run_id === 'pre118-run-malformed'
    ))
    if (sentinel[0]?.value !== 'preserved'
      || retired?.thread_materialization_kind !== 'legacy'
      || retired?.action_projection_sequence !== 1
      || retired?.retired_reason !== 'user_reset'
      || !retired?.retired_at
      || successor?.alias_generation !== 2
      || successor?.thread_materialization_kind !== 'fresh_start'
      || successor?.runtime_manifest_digest !== threadRows[0]?.runtime_manifest_digest
      || successor?.protocol_schema_digest !== threadRows[0]?.protocol_schema_digest
      || openLegacyTurns.length !== 2
      || openLegacyTurns.some((row) => (
        row.turn_start_reservation_release_reason !== 'legacy_prepared_contract_reset'
        || !row.turn_start_reservation_released_at
        || !row.effect_authority_closed_at
        || row.terminal_facts_digest !== null
      ))
      || legacyFence[0]?.count !== 0
      || legacyCard[0]?.status !== 'cancelled'
      || !String(legacyCard[0]?.cancel_reason || '').includes('restart')
      || upgradeCardBeforeSecondBoot?.[0]?.meta_json !== legacyCard[0]?.meta_json
      || schemaObjects.length !== 4
      || migration.length !== 1) {
      throw new Error(`installed upgrade evidence mismatch: ${JSON.stringify({
        sentinel, migratedThread, migratedTurn, migration, legacyCard,
        legacyFence, schemaObjects, upgradeCardBeforeSecondBoot, upgradeBoot,
      })}`)
    }
    upgradeEvidence = {
      sentinel,
      migratedThread,
      migratedTurn,
      migration,
      legacyCard,
      legacyFence,
      schemaObjects,
      actionSurface: upgradeBoot,
      secondBootIdempotent: true,
    }
  }

  const retryThreadRows = sqliteJson(evidenceDatabasePath, `
    SELECT thread_binding_id, ready_conversation_alias, alias_generation,
           ready_scope_id, codex_thread_id, retired_at, retired_reason
      FROM codex_thread_bindings
     WHERE ready_scope_id = ${sqlQuote(scenario.retryScopeId)}
     ORDER BY created_at ASC;
  `)
  if (retryThreadRows.length !== 1
    || retryThreadRows[0].retired_at !== null
    || retryThreadRows[0].alias_generation !== 1) {
    throw new Error(`installed retry thread lineage mismatch: ${JSON.stringify(retryThreadRows)}`)
  }
  const retryTurnRows = sqliteJson(evidenceDatabasePath, `
    SELECT ready_run_id, thread_binding_id, codex_thread_id, codex_turn_id,
           attempt_kind, predecessor_run_id, ingress_json, engine_terminal_status,
           product_closeout_at
      FROM codex_turn_bindings
     WHERE thread_binding_id IN (
       ${retryThreadRows.map((row) => sqlQuote(row.thread_binding_id)).join(',')}
     )
     ORDER BY ingress_admitted_at ASC;
  `)
  const retryIngress = retryTurnRows[1]?.ingress_json
    ? JSON.parse(retryTurnRows[1].ingress_json)
    : null
  if (retryTurnRows.length !== 2
    || retryTurnRows[0].attempt_kind !== 'user_ingress'
    || retryTurnRows[1].attempt_kind !== 'user_ingress'
    || retryTurnRows[1].predecessor_run_id !== null
    || retryTurnRows[0].thread_binding_id !== retryTurnRows[1].thread_binding_id
    || retryTurnRows[0].codex_thread_id !== retryTurnRows[1].codex_thread_id
    || !retryTurnRows[1].product_closeout_at
    || retryIngress?.prepared?.ingress?.canonicalCurrentInputRef?.input?.[0]?.text
      !== `${retryFollowupMarker}：继续处理刚才的任务。`
    || retryIngress?.prepared?.ingress?.taskRootInput !== undefined) {
    throw new Error(`installed retry turn lineage mismatch: ${JSON.stringify({ retryTurnRows, retryIngress })}`)
  }
  if (fixture.retryChecks.length !== 2
    || fixture.retryChecks[0].outcome !== 'failed_once'
    || fixture.retryChecks[1].outcome !== 'same_thread_context_retained') {
    throw new Error(`fixture did not receive failed-turn context: ${JSON.stringify(fixture.retryChecks)}`)
  }

  const readScopeThreads = (scopeId) => sqliteJson(evidenceDatabasePath, `
    SELECT thread_binding_id, alias_generation, codex_thread_id,
           thread_materialization_kind, materialization_state,
           fork_expected_prefix_turn_ids_json, materialization_effective_receipt_json,
           history_seed_digest, uncommitted_user_tail_json, retired_reason
      FROM codex_thread_bindings
     WHERE ready_scope_id = ${sqlQuote(scopeId)}
     ORDER BY alias_generation;
  `)
  const readScopeTurns = (scopeId) => sqliteJson(evidenceDatabasePath, `
    SELECT turn.ready_run_id, turn.thread_binding_id, turn.codex_thread_id, turn.codex_turn_id,
           turn.ingress_json, turn.terminal_facts_json,
           turn.turn_start_request_digest, turn.turn_start_child_write_digest, turn.turn_start_reconciled_at
      FROM codex_turn_bindings turn
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
     WHERE thread.ready_scope_id = ${sqlQuote(scopeId)}
     ORDER BY turn.ingress_admitted_at;
  `)
  const preparedIngress = (turn) => JSON.parse(turn.ingress_json).prepared.ingress
  const modelInputMarkerCount = (readyRunId, marker) => fixture.continuityChecks
    .filter((entry) => entry.readyRunId === readyRunId)
    .reduce((count, entry) => count + entry.modelInputText.split(marker).length - 1, 0)

  const divergenceThreads = readScopeThreads(continuityScenarios.divergence.scopeId)
  const divergenceTurns = readScopeTurns(continuityScenarios.divergence.scopeId)
  const divergenceFailedTurn = divergenceTurns.find(
    (turn) => turn.ready_run_id === continuityScenarios.divergence.failedRunId,
  )
  const divergenceFollowupTurn = divergenceTurns.find(
    (turn) => turn.ready_run_id === continuityScenarios.divergence.followupRunId,
  )
  const divergenceFollowupIngress = divergenceFollowupTurn
    ? preparedIngress(divergenceFollowupTurn) : null
  if (divergenceThreads.length !== 2
    || divergenceThreads[0].retired_reason !== 'publication_diverged'
    || divergenceThreads[1].thread_materialization_kind !== 'native_fork'
    || divergenceThreads[1].materialization_state !== 'confirmed'
    || !divergenceThreads[1].fork_expected_prefix_turn_ids_json
    || !divergenceThreads[1].materialization_effective_receipt_json
    || JSON.parse(divergenceFailedTurn?.terminal_facts_json || '{}').history?.kind !== 'diverged'
    || continuityScenarios.divergence.retry?.availability !== 'ready'
    || divergenceFollowupIngress?.uncommittedTailAssignments?.length !== 1
    || divergenceFollowupIngress.uncommittedTailAssignments[0].plan !== 'deliver_untrusted_history'
    || divergenceFollowupIngress?.supersededUncommittedItems?.length !== 0
    || divergenceFollowupTurn?.turn_start_request_digest !== divergenceFollowupTurn?.turn_start_child_write_digest
    || !divergenceFollowupTurn?.turn_start_reconciled_at
    || modelInputMarkerCount(continuityScenarios.divergence.followupRunId, divergenceTailMarker) !== 1
    || modelInputMarkerCount(continuityScenarios.divergence.followupRunId, divergenceFollowupMarker) !== 1) {
    throw new Error(`installed divergence handoff mismatch: ${JSON.stringify({
      divergenceThreads, divergenceTurns, divergenceFollowupIngress,
      surface: continuityScenarios.divergence.surface,
      retry: continuityScenarios.divergence.retry,
      captures: fixture.continuityChecks.filter((entry) => (
        entry.readyRunId === continuityScenarios.divergence.followupRunId
      )),
    })}`)
  }

  const freshRetry = continuityScenarios.freshRetry
  const freshTurns = readScopeTurns(freshRetry.scopeId)
  const freshThreads = readScopeThreads(freshRetry.scopeId)
  const freshTurn = freshTurns.find((turn) => turn.ready_run_id === freshRetry.readyRunId)
  const freshIngress = freshTurn ? preparedIngress(freshTurn) : null
  if (freshTurns.length !== 2 || freshThreads.length !== 2
    || freshThreads[1].thread_materialization_kind !== 'fresh_root_with_tail'
    || freshIngress?.attemptKind !== 'explicit_retry'
    || freshIngress.predecessorRunId !== freshRetry.predecessorRunId
    || modelInputMarkerCount(freshRetry.readyRunId, freshRetryMarker) !== 1
    || JSON.stringify(freshIngress.canonicalCurrentInputRef.input).includes('再试一次')
    || freshRetry.rejectionChecks.some((check) => fixture.continuityChecks.some((capture) => capture.readyRunId === check.requestId))) {
    throw new Error('installed fresh-root Retry or zero-effect rejection mismatch')
  }

  const multiTail = continuityScenarios.multiTailRetry
  const multiTailThreads = readScopeThreads(multiTail.scopeId)
  const multiTailTurns = readScopeTurns(multiTail.scopeId)
  const olderIngress = preparedIngress(multiTailTurns.find((turn) => turn.ready_run_id === multiTail.olderRunId))
  const selectedIngress = preparedIngress(multiTailTurns.find((turn) => turn.ready_run_id === multiTail.selectedRunId))
  const multiTailPlans = multiTail.retries.map(({ readyRunId, predecessorRunId, displayedTerminal }) => {
    const turn = multiTailTurns.find((entry) => entry.ready_run_id === readyRunId)
    const ingress = turn ? preparedIngress(turn) : null
    const capture = fixture.continuityChecks.filter((entry) => entry.readyRunId === readyRunId)
    const modelInput = capture[0]?.modelInput || []
    const olderMessages = modelInput.filter((item) => JSON.stringify(item).includes(multiTailOlderMarker))
    const selectedMessages = modelInput.filter((item) => JSON.stringify(item).includes(multiTailSelectedMarker))
    const lastUserMessage = modelInput.filter((item) => item.role === 'user').at(-1)
    const expectedPlans = [
      [olderIngress.canonicalCurrentInputRef.messageId, 'deliver_untrusted_history'],
      [selectedIngress.canonicalCurrentInputRef.messageId, 'replace_with_explicit_retry'],
    ]
    if (displayedTerminal?.runId !== predecessorRunId || displayedTerminal.terminalReason === 'done'
      || ingress?.attemptKind !== 'explicit_retry'
      || ingress?.predecessorRunId !== predecessorRunId
      || ingress?.modelVisibleRootOriginRef?.sourceReadyRunId !== multiTail.selectedRunId
      || ingress?.canonicalCurrentInputRef?.messageId !== selectedIngress.canonicalCurrentInputRef.messageId
      || JSON.stringify(ingress?.taskRootInput) !== JSON.stringify(selectedIngress.canonicalCurrentInputRef.input)
      || JSON.stringify(ingress?.uncommittedTailAssignments?.map((item) => [item.originUserMessageId, item.plan]))
        !== JSON.stringify(expectedPlans)
      || !ingress?.controlAuditMessageRef?.messageId
      || ingress.controlAuditMessageRef.messageId === ingress.canonicalCurrentInputRef.messageId
      || turn.turn_start_request_digest !== turn.turn_start_child_write_digest
      || !turn.turn_start_reconciled_at
      || capture.length !== 1
      || modelInputMarkerCount(readyRunId, multiTailOlderMarker) !== 1
      || modelInputMarkerCount(readyRunId, multiTailSelectedMarker) !== 1
      || olderMessages.length !== 1 || selectedMessages.length !== 1
      || olderMessages[0].role !== 'user' || selectedMessages[0].role !== 'user'
      || modelInput.indexOf(olderMessages[0]) >= modelInput.indexOf(selectedMessages[0])
      || selectedMessages[0] !== lastUserMessage
      || JSON.stringify([capture[0].modelInstructions, modelInput]).includes('再试一次')) {
      throw new Error(`installed multi-tail Retry mismatch: ${JSON.stringify({ turn, ingress, capture, expectedPlans })}`)
    }
    return { readyRunId, predecessorRunId,
      displayedTerminal: { id: displayedTerminal.id, runId: displayedTerminal.runId,
        terminalReason: displayedTerminal.terminalReason },
      assignments: ingress.uncommittedTailAssignments,
      controlMessageId: ingress.controlAuditMessageRef.messageId, providerOlderCount: 1, providerSelectedCount: 1 }
  })
  const multiTailCoverage = sqliteJson(evidenceDatabasePath, `
    SELECT newly_covered_json FROM codex_native_coverage_receipts
     WHERE producer_owner_id = ${sqlQuote(multiTail.retries.at(-1).readyRunId)};
  `).flatMap((row) => JSON.parse(row.newly_covered_json))
  const coveredOriginIds = multiTailCoverage.map((item) => item.messageId)
  if (multiTailThreads.length !== 3 || multiTailTurns.length !== 5
    || multiTailThreads.slice(1).some((thread) => thread.thread_materialization_kind !== 'native_fork'
      || thread.materialization_state !== 'confirmed')
    || multiTailPlans.length !== 2
    || !coveredOriginIds.includes(olderIngress.canonicalCurrentInputRef.messageId)
    || !coveredOriginIds.includes(selectedIngress.canonicalCurrentInputRef.messageId)
    || multiTailPlans.some((plan) => coveredOriginIds.includes(plan.controlMessageId))
    || JSON.parse(multiTailTurns.at(-1).terminal_facts_json).product?.terminal !== 'done') {
    throw new Error(`installed multi-tail Retry coverage mismatch: ${JSON.stringify({ multiTailThreads, multiTailTurns, multiTailCoverage })}`)
  }

  const resourceThreads = readScopeThreads(continuityScenarios.resource.scopeId)
  const resourceTurns = readScopeTurns(continuityScenarios.resource.scopeId)
  const resourceFailedTurn = resourceTurns.find(
    (turn) => turn.ready_run_id === continuityScenarios.resource.failedRunId,
  )
  const resourceFollowupTurn = resourceTurns.find(
    (turn) => turn.ready_run_id === continuityScenarios.resource.followupRunId,
  )
  const resourceFailedIngress = resourceFailedTurn ? preparedIngress(resourceFailedTurn) : null
  const resourceFollowupIngress = resourceFollowupTurn ? preparedIngress(resourceFollowupTurn) : null
  const resourceConsequence = continuityScenarios.resource.surface?.head
    ?.actions?.send_new_message?.consequence
  if (resourceThreads.length !== 2
    || resourceThreads[0].retired_reason !== 'publication_diverged'
    || resourceThreads[1].thread_materialization_kind !== 'native_fork'
    || resourceThreads[1].materialization_state !== 'confirmed'
    || JSON.parse(resourceFailedTurn?.terminal_facts_json || '{}').history?.kind !== 'diverged'
    || resourceFailedIngress?.explicitResourceEnvelope?.resourceRefs?.length !== 1
    || resourceConsequence?.kind !== 'supersedes_uncommitted_structured_tail'
    || resourceConsequence?.omittedItemCount !== 1
    || resourceConsequence?.resourceReattachItemCount !== 1
    || continuityScenarios.resource.retry?.availability !== 'not_applicable'
    || !continuityScenarios.resource.retry?.blockers?.includes('resource_restatement_required')
    || resourceFollowupIngress?.uncommittedTailAssignments?.length !== 1
    || resourceFollowupIngress.uncommittedTailAssignments[0].plan !== 'omit_from_current_run'
    || resourceFollowupIngress?.supersededUncommittedItems?.length !== 1
    || resourceFollowupIngress?.explicitResourceEnvelope?.resourceRefs?.length !== 0
    || modelInputMarkerCount(continuityScenarios.resource.followupRunId, resourceTailMarker) !== 0
    || modelInputMarkerCount(continuityScenarios.resource.followupRunId, basename(resourceFilePath)) !== 0
    || modelInputMarkerCount(continuityScenarios.resource.followupRunId, resourceFollowupMarker) !== 1) {
    throw new Error(`installed resource handoff mismatch: ${JSON.stringify({
      resourceThreads, resourceTurns, resourceFailedIngress, resourceFollowupIngress,
      consequence: resourceConsequence, retry: continuityScenarios.resource.retry,
      captures: fixture.continuityChecks.filter((entry) => (
        entry.readyRunId === continuityScenarios.resource.followupRunId
      )),
    })}`)
  }

  const resetThreads = readScopeThreads(continuityScenarios.reset.scopeId)
  const resetTurns = readScopeTurns(continuityScenarios.reset.scopeId)
  const resetFollowupTurn = resetTurns.at(-1)
  const resetFollowupIngress = resetFollowupTurn ? preparedIngress(resetFollowupTurn) : null
  if (resetThreads.length !== 3
    || resetThreads[0].retired_reason !== 'publication_diverged'
    || resetThreads[1].retired_reason !== 'user_reset'
    || resetThreads[2].thread_materialization_kind !== 'fresh_start'
    || resetThreads[2].retired_reason !== null
    || resetThreads[2].history_seed_digest !== null
    || resetThreads[2].uncommitted_user_tail_json !== null
    || continuityScenarios.reset.action?.entry !== 'visible_reset_button'
    || continuityScenarios.reset.action?.visibleMessagesAfter !== 0
    || continuityScenarios.reset.action?.headVersionAfter?.headGeneration !== 3
    || resetFollowupIngress?.uncommittedTailAssignments?.length !== 0
    || resetFollowupIngress?.supersededUncommittedItems?.length !== 0
    || modelInputMarkerCount(resetFollowupTurn?.ready_run_id, resetAcceptedMarker) !== 0
    || modelInputMarkerCount(resetFollowupTurn?.ready_run_id, resetTailMarker) !== 0
    || modelInputMarkerCount(resetFollowupTurn?.ready_run_id, resetFollowupMarker) !== 1) {
    throw new Error(`installed reset clear mismatch: ${JSON.stringify({
      resetThreads, resetTurns, resetFollowupIngress, action: continuityScenarios.reset.action,
      captures: fixture.continuityChecks.filter((entry) => entry.readyRunId === resetFollowupTurn?.ready_run_id),
    })}`)
  }

  const effectThreads = readScopeThreads(continuityScenarios.effect.scopeId)
  const effectTurns = readScopeTurns(continuityScenarios.effect.scopeId)
  const effectFailedTurn = effectTurns.find(
    (turn) => turn.ready_run_id === continuityScenarios.effect.failedRunId,
  )
  const effectFollowupTurn = effectTurns.find(
    (turn) => turn.ready_run_id === continuityScenarios.effect.followupRunId,
  )
  const effectFollowupIngress = effectFollowupTurn ? preparedIngress(effectFollowupTurn) : null
  const effectBindings = sqliteJson(evidenceDatabasePath, `
    SELECT call.ready_run_id, call.codex_thread_id, call.codex_turn_id, call.codex_call_id,
           call.tool_name, call.ready_action_id, call.receipt_id, call.result_digest,
           action.state, action.receipt_id AS action_receipt_id,
           action.result_digest AS action_result_digest, action.result_json
      FROM codex_tool_call_bindings call
      JOIN codex_turn_bindings turn_owner ON turn_owner.ready_run_id = call.ready_run_id
      JOIN codex_thread_bindings owner ON owner.thread_binding_id = turn_owner.thread_binding_id
      LEFT JOIN ready_tool_action_receipts action ON action.ready_action_id = call.ready_action_id
     WHERE owner.ready_scope_id = ${sqlQuote(continuityScenarios.effect.scopeId)}
     ORDER BY call.created_at, call.codex_call_id;
  `)
  const expectedEffectCalls = [
    ['declare_completion_criteria', `call-effect-declare-${continuityScenarios.effect.failedRunId}`],
    ['skill_write_artifact', `call-effect-write-${continuityScenarios.effect.failedRunId}`],
    ['skill_export_artifact', `call-effect-export-${continuityScenarios.effect.failedRunId}`],
  ]
  const effectToolCalls = sqliteJson(evidenceDatabasePath, `
    SELECT ready_run_id, tool_name, COUNT(*) AS count
      FROM codex_tool_call_bindings
     WHERE ready_run_id IN (
       ${sqlQuote(continuityScenarios.effect.failedRunId)},
       ${sqlQuote(continuityScenarios.effect.followupRunId)}
     )
     GROUP BY ready_run_id, tool_name ORDER BY ready_run_id, tool_name;
  `)
  if (effectThreads.length !== 2
    || effectThreads[0].retired_reason !== 'publication_diverged'
    || effectThreads[1].thread_materialization_kind !== 'fresh_root_with_tail'
    || effectThreads[1].materialization_state !== 'confirmed'
    || JSON.parse(effectFailedTurn?.terminal_facts_json || '{}').effect?.state !== 'confirmed'
    || continuityScenarios.effect.retry?.availability !== 'not_applicable'
    || !continuityScenarios.effect.retry?.blockers?.includes('effectful_or_interactive_retry_unsupported')
    || effectBindings.length !== expectedEffectCalls.length
    || expectedEffectCalls.some(([toolName, callId]) => (
      effectBindings.filter((entry) => entry.tool_name === toolName && entry.codex_call_id === callId).length !== 1
    ))
    || effectBindings.some((entry) => (
      entry.ready_run_id !== continuityScenarios.effect.failedRunId
      || entry.codex_thread_id !== effectFailedTurn?.codex_thread_id
      || entry.codex_turn_id !== effectFailedTurn?.codex_turn_id
      || entry.state !== 'confirmed'
      || !entry.receipt_id || entry.receipt_id !== entry.action_receipt_id
      || !entry.result_digest || entry.result_digest !== entry.action_result_digest
      || JSON.parse(entry.result_json || '{}').envelope?.ok !== true
    ))
    || effectToolCalls.some((entry) => (
      entry.ready_run_id === continuityScenarios.effect.followupRunId
    ))
    || effectFollowupIngress?.uncommittedTailAssignments?.length !== 1
    || effectFollowupIngress.uncommittedTailAssignments[0].plan !== 'omit_from_current_run'
    || modelInputMarkerCount(continuityScenarios.effect.followupRunId, effectRootMarker) !== 0
    || modelInputMarkerCount(continuityScenarios.effect.followupRunId, effectFollowupMarker) !== 1
    || !existsSync(resolve(effectTargetRoot, 'effect.txt'))
    || createHash('sha256').update(readFileSync(resolve(effectTargetRoot, 'effect.txt'))).digest('hex')
      !== effectContentSha256) {
    throw new Error(`installed effect no-replay mismatch: ${JSON.stringify({
      effectThreads, effectTurns, effectFollowupIngress, effectBindings, effectToolCalls,
      retry: continuityScenarios.effect.retry,
      captures: fixture.continuityChecks.filter((entry) => (
        entry.readyRunId === continuityScenarios.effect.followupRunId
      )),
    })}`)
  }

  const report = {
    schemaVersion: 1,
    status: 'INSTALLED_NATIVE_CONTINUITY_TERMINAL_AND_REPLY_SURFACE_PASS',
    observedAt: new Date().toISOString(),
    proofId,
    profileMode,
    package: {
      path: dmgPath,
      bytes: statSync(dmgPath).size,
      sha256: packageSha256,
      mode: statSync(dmgPath).mode & 0o777,
      appVersion,
      architecture: process.arch,
      codexVersion,
      slim: true,
      seedEntryCount: 0,
    },
    runtime: {
      execSha256: handshake.execSha256,
      asarSha256: handshake.asarSha256,
      sourceManifestDigest: handshake.sourceManifestDigest,
      userDataIsolated: handshake.userDataPath === profilePath,
      databaseIsolated: handshake.databasePath === databasePath,
    },
    scenario: {
      scopeId: scenario.firstScopeId,
      firstAnswerSeen: scenario.contextMessages.some(
        (message) => String(message.content || '').includes(firstAnswer),
      ),
      secondAnswerSeen: true,
      fixtureContextSeen: true,
      liveContextUsage: scenario.contextUsage,
      rehydratedContextUsage: rehydratedContextMeter.usage,
      rehydratedMeter: rehydratedContextMeter,
      meter: contextMeter,
      requestCount: fixture.requestCount,
      replySurface: {
        scopeId: scenario.replyScopeId,
        orderedList: scenario.orderedList,
        liveDuration: scenario.liveDuration,
      },
    },
    thread: threadRows[0],
    turns: turnRows,
    contextWindows: contextWindowRows,
    failedTurnContinuity: {
      scopeId: scenario.retryScopeId,
      answerSeen: true,
      originalTaskSeenByProvider: true,
      threads: retryThreadRows,
      turns: retryTurnRows.map(({ ingress_json: _ingressJson, ...row }) => row),
      sameNativeThread: true,
      fixtureChecks: fixture.retryChecks,
    },
    nativeContinuity: {
      freshRootRetry: freshRetry,
      multiTailRetry: {
        scopeId: multiTail.scopeId, threads: multiTailThreads,
        retries: multiTailPlans, finalCoverage: multiTailCoverage,
        currentRootStable: true, controlMessageConsumed: false,
      },
      divergence: {
        scopeId: continuityScenarios.divergence.scopeId,
        threads: divergenceThreads,
        turns: divergenceTurns.map(({ ingress_json: _ingress, terminal_facts_json: _facts, ...turn }) => turn),
        deliveryPlan: divergenceFollowupIngress.uncommittedTailAssignments,
        providerTailOccurrenceCount: 1,
      },
      resourceRestatement: {
        scopeId: continuityScenarios.resource.scopeId,
        consequence: resourceConsequence,
        displayedConsequence: continuityScenarios.resource.displayedConsequence,
        retryGate: continuityScenarios.resource.retry,
        deliveryPlan: resourceFollowupIngress.uncommittedTailAssignments,
        providerOldResourceOccurrenceCount: 0,
      },
      effectNoReplay: {
        scopeId: continuityScenarios.effect.scopeId,
        retryGate: continuityScenarios.effect.retry,
        effectBindings,
        toolCalls: effectToolCalls,
        exportedSha256: effectContentSha256,
      },
      resetClear: {
        scopeId: continuityScenarios.reset.scopeId,
        generations: resetThreads,
        reset: continuityScenarios.reset.action,
        providerOldHistoryOccurrenceCount: 0,
      },
    },
    upgradeEvidence,
    screenshots: {
      contextMeter: contextScreenshotPath,
      explicitRetry: retryScreenshotPath,
      replySurface: replySurfaceScreenshotPath,
    },
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ ok: true, reportPath, screenshotPath: retryScreenshotPath, report }, null, 2)}\n`)
} catch (error) {
  proofFailed = true
  const diagnostics = [
    error instanceof Error ? `${error.stack || error.message}\n` : `${String(error)}\n`,
    `${JSON.stringify({ installedRoot, profilePath, databasePath })}\n`,
    ...(runtime?.logs || []).slice(-200),
  ]
  for (const name of ['ready-directchat.log', 'ready-tools.log', 'ready-agent-metrics.log']) {
    const path = resolve(tempPath, name)
    if (existsSync(path)) diagnostics.push(`\n[${name}]\n${readFileSync(path, 'utf8')}`)
  }
  if (existsSync(databasePath)) {
    try {
      diagnostics.push(`\n[context rows]\n${JSON.stringify(sqliteJson(databasePath, `
        SELECT turn.ready_run_id, turn.ingress_json, turn.engine_terminal_candidate_json,
               turn.terminal_native_readback_receipt_json, turn.terminal_facts_json,
               turn.product_closeout_at, run.context_window, task.progress_json
          FROM codex_turn_bindings turn
          LEFT JOIN run_meta run ON run.run_id = turn.ready_run_id
          LEFT JOIN task_projections task ON task.run_id = turn.ready_run_id
         ORDER BY turn.ingress_admitted_at ASC;
      `), null, 2)}\n`)
      diagnostics.push(`\n[continuity heads]\n${JSON.stringify(sqliteJson(databasePath, `
        SELECT thread_binding_id, ready_conversation_alias, alias_generation,
               codex_thread_id, thread_materialization_kind, materialization_state,
               history_source_thread_binding_id, history_seed_digest,
               materialization_request_digest, materialization_evidence_digest,
               materialization_effective_receipt_json,
               fork_accepted_through_codex_turn_id, fork_expected_prefix_turn_ids_json,
               thread_start_request_digest, thread_start_dispatch_intent_at,
               thread_start_child_write_confirmed_at, thread_start_response_at,
               thread_start_reconciled_at, thread_start_late_response_guard_close_reason,
               thread_start_reservation_released_at, thread_start_reservation_release_reason,
               uncommitted_user_tail_json, action_projection_sequence,
               retired_at, retired_reason, continuation_blocked_at,
               continuation_blocked_reason
          FROM codex_thread_bindings
         ORDER BY ready_conversation_alias, alias_generation;
      `), null, 2)}\n`)
    } catch (diagnosticError) {
      diagnostics.push(`\n[context rows failed]\n${String(diagnosticError)}\n`)
    }
  }
  writeFileSync(resolve(runRoot, 'failed-proof.log'), diagnostics.join(''), { mode: 0o600 })
  throw error
} finally {
  if (runtime) await stopInstalledApp(runtime).catch(() => {})
  await fixture.close()
  if (mounted) {
    try {
      execFileSync('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      execFileSync('/usr/bin/hdiutil', ['detach', mountPoint, '-force', '-quiet'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }
  }
  rmSync(mountPoint, { recursive: true, force: true })
  if (!(proofFailed && process.env.READY_CONTEXT_PROOF_KEEP_FAILED === '1')) {
    rmSync(profilePath, { recursive: true, force: true })
    rmSync(tempPath, { recursive: true, force: true })
    rmSync(installedRoot, { recursive: true, force: true })
  }
}

async function launchInstalledApp(executablePath) {
  const remotePort = 11_000 + Number.parseInt(proofId.slice(0, 4), 16) % 2_000
  const child = spawn(executablePath, [`--remote-debugging-port=${remotePort}`], {
    cwd: root,
    env: {
      ...process.env,
      TMPDIR: tempPath,
      READY_BROWSER_LIVE_PROOF_NONCE: proofNonce,
      READY_DB_PATH: databasePath,
      READY_REMOTE_DEBUGGING_PORT: String(remotePort),
      READY_USER_DATA_DIR: profilePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  let cdp
  try {
    cdp = await openCdp(remotePort, { timeoutMs: 90_000 })
    const handshake = await evaluateCdp(
      cdp,
      `window.electronAPI.app.browserLiveProofHandshake(${JSON.stringify(proofNonce)})`,
    )
    if (!handshake?.success || handshake.proofNonce !== proofNonce
      || handshake.userDataPath !== profilePath || handshake.databasePath !== databasePath
      || handshake.execPath !== executablePath || handshake.execSha256 !== sha256File(executablePath)) {
      throw new Error(`installed handshake mismatch: ${JSON.stringify(handshake)}`)
    }
    cdp = await enableAgentPanelHarness(cdp, remotePort)
    return { child, cdp, handshake, logs }
  } catch (error) {
    cdp?.close()
    await closeChildProcess(child, { gracefulSignal: 'SIGTERM', timeoutMs: 30_000 })
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.slice(-80).join('')}`)
  }
}

async function stopInstalledApp(active) {
  const processRecords = Number.isSafeInteger(active.child.pid)
    ? captureProcessCensus({ rootPid: active.child.pid })
    : []
  try {
    await evaluateCdp(
      active.cdp,
      `window.electronAPI.app.browserLiveProofQuit(${JSON.stringify(proofNonce)})`,
      5_000,
    )
  } catch {}
  active.cdp.close()
  await closeChildProcess(active.child, { gracefulSignal: 'SIGTERM', timeoutMs: 30_000 })
  await terminateExactRecordedProcesses(processRecords)
}

async function terminateExactRecordedProcesses(records) {
  if (records.length === 0) return
  try {
    await assertRecordedProcessesExited(records, { timeoutMs: 3_000 })
    return
  } catch {}
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const currentByPid = new Map(captureProcessCensus().map((row) => [row.pid, row]))
    const remaining = records.filter((record) => {
      const current = currentByPid.get(record.pid)
      return current?.processStartIdentity === record.processStartIdentity
        && current.command === record.command
    })
    for (const record of remaining.sort((left, right) => right.pid - left.pid)) {
      if (record.pid <= 1 || record.pid === process.pid) {
        throw new Error('installed_proof_process_identity_unsafe')
      }
      try { process.kill(record.pid, signal) } catch {}
    }
    try {
      await assertRecordedProcessesExited(records, { timeoutMs: 5_000 })
      return
    } catch {}
  }
  await assertRecordedProcessesExited(records, { timeoutMs: 5_000 })
}

function seedIsolatedProvider(baseUrl) {
  const config = {
    provider: 'openai-compatible',
    baseUrl,
    apiKey: fixtureCredential,
    model: fixtureModel,
    agentProtocol: 'openai',
    wireApi: 'responses',
    toolUseMode: 'on',
    contextWindowOverride: 272000,
  }
  const workspace = {
    version: 1,
    activeProfileId: 'context-proof',
    profiles: [{
      id: 'context-proof', category: 'custom', name: 'Context proof', builtIn: false,
      showInChatSwitcher: true, config,
    }],
  }
  const now = new Date().toISOString()
  const rows = {
    ai_provider_workspace: workspace,
    ai_model_config: config,
    ai_saved_configs: { 'openai-compatible': config, 'context-proof': config },
  }
  const values = Object.entries(rows).map(([key, value]) => (
    `(${sqlQuote(key)}, ${sqlQuote(JSON.stringify(value))}, ${sqlQuote(now)})`
  )).join(',')
  execFileSync('/usr/bin/sqlite3', [databasePath, `
    PRAGMA journal_mode=DELETE;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ${values};
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
}

async function startFixtureProvider() {
  const contextChecks = []
  const retryChecks = []
  const continuityChecks = []
  const effectStages = new Map()
  const multiTailSelectedRuns = new Set()
  const freshRetryRuns = new Set()
  let retryRootRequestCount = 0
  let requestCount = 0
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const bodyText = JSON.stringify(body)
    const modelInputText = JSON.stringify(body.input || null)
    const metadataText = body?.client_metadata?.['x-codex-turn-metadata']
    const metadata = typeof metadataText === 'string' ? JSON.parse(metadataText) : {}
    const readyRunId = String(metadata.readyRunId || '')
    const toolNames = Array.isArray(body.tools)
      ? body.tools.map((tool) => String(tool?.name || tool?.function?.name || '')).filter(Boolean)
      : []
    requestCount += 1
    continuityChecks.push({ readyRunId, modelInputText, modelInput: body.input || [],
      modelInstructions: body.instructions || null, toolNames, requestOrdinal: requestCount })
    if (modelInputText.includes(freshRetryMarker)) {
      freshRetryRuns.add(readyRunId)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(freshRetryRuns.size === 1
        ? partialFailureEvents('未发布的首轮片段', 'fresh_retry_failure')
        : messageEvents('首轮任务已重新完成。', 24))
      return
    }
    if (modelInputText.includes(multiTailSelectedMarker)) {
      multiTailSelectedRuns.add(readyRunId)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(multiTailSelectedRuns.size < 3
        ? partialFailureEvents('不得发布的选中任务片段', 'multi_tail_selected_failure')
        : messageEvents('较早的问题保留一次，选中的问题完成。', 24))
      return
    }
    if (modelInputText.includes(multiTailOlderMarker)) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'intentional no-output older task failure' } }))
      return
    }
    if (modelInputText.includes(multiTailAcceptedMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageEvents('多条历史场景已接受边界。', 20))
      return
    }
    if (bodyText.includes(effectFollowupMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageEvents(effectAnswer, 24))
      return
    }
    if (bodyText.includes(effectRootMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const stage = effectStages.get(readyRunId) || 0
      if (stage === 0) {
        effectStages.set(readyRunId, 1)
        response.end(functionCallEvents('declare_completion_criteria', {
          criteria: ['effect.txt 已写入所附文件夹后停止'],
          expected_outputs: ['effect.txt'], folder_output_intent: 'create',
        }, `effect-declare-${readyRunId}`))
        return
      }
      const declaration = readEffectToolResult(body, `call-effect-declare-${readyRunId}`)
      if (declaration.ok !== true || declaration.folderOutputIntent !== 'create'
        || JSON.stringify(declaration.expectedOutputs) !== JSON.stringify(['effect.txt'])
        || !/^local-directory:[a-f0-9]{32}$/.test(declaration.destinationResourceId)) {
        throw new Error('effect declaration receipt mismatch')
      }
      if (stage === 1) {
        effectStages.set(readyRunId, 2)
        response.end(functionCallEvents('skill_write_artifact', {
          relativePath: 'effect.txt', content: effectContent,
          mode: 'overwrite', expectedVersion: 'empty',
        }, `effect-write-${readyRunId}`))
        return
      }
      const written = readEffectToolResult(body, `call-effect-write-${readyRunId}`)
      if (written.relativePath !== 'effect.txt' || !/^sha256:[a-f0-9]{64}$/.test(written.version)
        || written.logicalSha256 !== effectContentSha256
        || written.logicalBytes !== Buffer.byteLength(effectContent)) {
        throw new Error('effect write receipt mismatch')
      }
      if (stage === 2) {
        effectStages.set(readyRunId, 3)
        response.end(functionCallEvents('skill_export_artifact', {
          relativePath: 'effect.txt', targetRelativePath: 'effect.txt',
          destinationResourceId: declaration.destinationResourceId,
          expectedVersion: written.version, expectedSha256: written.logicalSha256,
        }, `effect-export-${readyRunId}`))
        return
      }
      const exported = readEffectToolResult(body, `call-effect-export-${readyRunId}`)
      if (exported.logicalArtifactRef !== written.logicalArtifactRef
        || exported.version !== written.version
        || exported.destinationResourceId !== declaration.destinationResourceId
        || exported.targetRelativePath !== 'effect.txt' || exported.sha256 !== effectContentSha256
        || exported.bytes !== written.logicalBytes || exported.readbackVerified !== true
        || exported.result !== 'created') {
        throw new Error('effect export receipt mismatch')
      }
      response.end(failureEvents('intentional_failure_after_effect', readyRunId))
      return
    }
    if (bodyText.includes(resetFollowupMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageEvents(resetAnswer, 24))
      return
    }
    if (bodyText.includes(resetTailMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(partialFailureEvents('不得发布的重置前片段', 'reset_tail_failure'))
      return
    }
    if (bodyText.includes(resetAcceptedMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageEvents('重置前已接受边界。', 20))
      return
    }
    if (bodyText.includes(resourceFollowupMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageEvents(resourceAnswer, 24))
      return
    }
    if (bodyText.includes(resourceTailMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(partialFailureEvents('不得发布的资源片段', 'resource_tail_failure'))
      return
    }
    if (bodyText.includes(resourceAcceptedMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageEvents('资源场景已接受边界。', 20))
      return
    }
    if (bodyText.includes(divergenceFollowupMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageEvents(divergenceAnswer, 24))
      return
    }
    if (bodyText.includes(divergenceTailMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(partialFailureEvents('不得发布的分叉片段', 'divergence_tail_failure'))
      return
    }
    if (bodyText.includes(divergenceAcceptedMarker)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageEvents('分叉前已接受边界。', 20))
      return
    }
    if (bodyText.includes(replySurfaceMarker)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageEvents(replySurfaceAnswer, 15))
      return
    }
    if (bodyText.includes(retryFollowupMarker)) {
      const retainedPriorUserCount = modelInputText.split(retryRootMarker).length - 1
      const retained = retainedPriorUserCount === 1
      retryChecks.push({
        outcome: retained ? 'same_thread_context_retained' : 'same_thread_context_missing',
        retainedPriorUserCount,
        requestOrdinal: requestCount,
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messageEvents(retained ? retryAnswer : 'FAILED_TURN_CONTEXT_MISSING', 30))
      return
    }
    if (bodyText.includes(retryRootMarker)) {
      retryRootRequestCount += 1
      if (retryRootRequestCount === 1) {
        retryChecks.push({ outcome: 'failed_once', requestOrdinal: requestCount })
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'intentional retry proof failure' } }))
        return
      }
      throw new Error('failed-turn root was replayed instead of receiving an ordinary follow-up')
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (bodyText.includes(followupMarker)) {
      const seen = bodyText.includes(setupMarker) && bodyText.includes(firstAnswer)
      contextChecks.push({ seen, requestOrdinal: requestCount })
      response.end(messageEvents(seen ? secondAnswer : 'CONTEXT_MISSING', expectedLatestInputTokens))
      return
    }
    if (bodyText.includes(setupMarker)) {
      response.end(messageEvents(firstAnswer, 20))
      return
    }
    response.end(messageEvents('UNEXPECTED_CONTEXT_PROOF_REQUEST'))
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    contextChecks,
    retryChecks,
    continuityChecks,
    get requestCount() { return requestCount },
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

function readEffectToolResult(body, callId) {
  const matches = body.input.filter((item) => item.type === 'function_call_output' && item.call_id === callId)
  if (matches.length !== 1 || typeof matches[0].output !== 'string') {
    throw new Error(`effect tool result missing or ambiguous: ${callId}`)
  }
  const result = JSON.parse(matches[0].output)
  if (result?.envelope?.ok !== true || !result.data || typeof result.data !== 'object'
    || Array.isArray(result.data) || result.data.ok === false || result.data.errorKind) {
    throw new Error(`effect tool result did not succeed: ${callId}`)
  }
  return result.data
}

function functionCallEvents(name, args, identity) {
  const argumentsValue = JSON.stringify(args)
  const item = {
    type: 'function_call', id: `item-${identity}`, call_id: `call-${identity}`,
    name, arguments: argumentsValue,
  }
  const responseId = `response-${identity}`
  const events = [
    { type: 'response.created', response: { id: responseId, model: fixtureModel, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: argumentsValue },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: argumentsValue },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: responseId, model: fixtureModel, status: 'completed', output: [item], usage: usage(20) } },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function partialFailureEvents(text, code) {
  const identity = randomBytes(8).toString('hex')
  const item = {
    type: 'message', id: `message-${identity}`, role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text }],
  }
  const responseId = `response-${identity}`
  return [
    { type: 'response.created', response: { id: responseId, model: fixtureModel, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: text },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.failed', response: {
      id: responseId, model: fixtureModel, status: 'failed', output: [item],
      error: { code, message: code, type: 'fixture_error', param: null }, usage: usage(20),
    } },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function failureEvents(code, identity) {
  const responseId = `response-${identity}`
  return [
    { type: 'response.created', response: { id: responseId, model: fixtureModel, status: 'in_progress', output: [] } },
    { type: 'response.failed', response: {
      id: responseId, model: fixtureModel, status: 'failed', output: [],
      error: { code, message: code, type: 'fixture_error', param: null }, usage: usage(20),
    } },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function usage(inputTokens) {
  return {
    input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

function messageEvents(text, inputTokens = 20) {
  const identity = randomBytes(8).toString('hex')
  const item = {
    type: 'message',
    id: `message-${identity}`,
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text }],
  }
  const responseId = `response-${identity}`
  const events = [
    { type: 'response.created', response: {
      id: responseId, model: fixtureModel, status: 'in_progress', output: [],
    } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: text },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: {
      id: responseId,
      model: fixtureModel,
      status: 'completed',
      output: [item],
      usage: usage(inputTokens),
    } },
  ]
  return events.map((event) => (
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  )).join('')
}
