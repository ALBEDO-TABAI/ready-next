#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import releasePackageIdentity from './release-package-identity.cjs'
import { assertFreshRootProviderCaptures, freshRootCases, runFreshRootInstalledProof, runFreshRootTurn } from './codex-runtime/fresh-root-installed-proof.mjs'
import {
  cpSync,
  existsSync,
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
import { join, resolve } from 'node:path'

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

const projectRoot = resolve(process.cwd())
const dmgPath = resolve(process.argv[2] || '')
const sourceDbPath = resolve(argumentValue('--source-db=') || '')
const sourceCodexHome = resolve(argumentValue('--source-codex-home=') || '')
if (!existsSync(dmgPath) || !statSync(dmgPath).isFile()
  || !existsSync(sourceDbPath) || !statSync(sourceDbPath).isFile()
  || !existsSync(join(sourceCodexHome, 'state_5.sqlite'))) {
  throw new Error('usage: node scripts/run-history-continuation-installed-proof.mjs Ready.dmg --source-db=/absolute/ready.db --source-codex-home=/absolute/codex-home')
}

const supportedSources = new Map([
  ['8b2e1f3f4f80fd9ef28657b49e90290e06c63f004eb35fc198c91d59992f3e0b', '0.149'],
  ['d47a3b863ed1975f7d18fb337a508127efe7559bfd47ce8e5f9bcb0ed7ee854f', '0.146'],
])
// A run takes many minutes across several app launches. Without a phase trace a
// failure only says which line threw, not which stage of the run it was in.
function logPhase(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`)
}

// A real installed skill id, so the planted hint is one production would accept.
const HINT_ARMED_SKILL_ID = 'video-copy-analyzer'
const proofId = randomBytes(16).toString('hex')
const packageSha256 = sha256File(dmgPath)
const packageReceipt = releasePackageIdentity.readVerifiedReleasePackageReceipt(dmgPath)
if (!isDeepStrictEqual(packageReceipt.buildIdentity.source, releasePackageIdentity.releaseSourceIdentity(projectRoot))) {
  throw new Error('installed proof package was not built from the current reviewed source')
}
const runRoot = resolve(projectRoot, 'outputs/history-continuation-installed', packageSha256, proofId)
const profilePath = mkdtempSync(join(tmpdir(), 'ready-history-proof-profile-'))
const databasePath = join(profilePath, 'ready.db')
const copiedCodexHome = join(profilePath, 'codex-runtime', 'codex-home')
const tempPath = join(runRoot, '.tmp')
const installedRoot = mkdtempSync(join(tmpdir(), 'ready-history-proof-install-'))
const mountPoint = mkdtempSync(join(tmpdir(), 'ready-history-proof-dmg-'))
const reportPath = join(runRoot, 'installed-proof.json')
const sameThreadScreenshotPath = join(runRoot, 'same-thread-after-restart.png')
const boundaryScreenshotPath = join(runRoot, 'context-boundary-after-restart.png')
const proofNonce = randomBytes(24).toString('hex')

mkdirSync(runRoot, { recursive: true, mode: 0o700 })
mkdirSync(tempPath, { recursive: true, mode: 0o700 })
let mounted = false
let runtime = null
let proofFailed = false
let fixture = null
let sourceTargets = []
let startedTargets = []
let recoveryTarget = null
let isolatedExternalLeaseCount = 0
try {
  copyReadyDatabase()
  isolatedExternalLeaseCount = freezeExternalProcessLeasesInCopy()
  copyCodexHistory()
  sourceTargets = attachNativeHistoryWitnesses(selectSourceTargets())
  const alternateModeTarget = sourceTargets.find((target) => target.started && target.source === '0.149')
  sourceTargets = sourceTargets.map((target) => ({
    ...target,
    workbenchMode: target === alternateModeTarget ? 'document' : 'browser',
  }))
  startedTargets = sourceTargets.filter((target) => target.started)
  recoveryTarget = attachNativeHistoryWitnesses([selectHistoryOnlyTarget()])[0]
  if (sourceTargets.length !== 14 || startedTargets.length !== 11
    || countBySource(startedTargets, '0.149') !== 7
    || countBySource(startedTargets, '0.146') !== 4) {
    throw new Error('installed proof source population does not match the reviewed 14/11/7/4 census')
  }
  const markers = new Map()
  for (const target of startedTargets) {
    for (const round of [1, 2, 3]) {
      markers.set(`READY_HISTORY_${target.label}_R${round}_${proofId}`, {
        label: target.label, round, kind: 'same_thread',
        priorWitnessDigests: target.priorWitnessDigests,
      })
    }
  }
  // The boundary's job is to clear non-input durable state. Planting happens
  // later, while the app is stopped between rounds: an ordinary turn re-persists
  // the reference hint and could otherwise clear the plant before the boundary
  // ever runs, and by then classification has already named both recovery
  // scopes, so the plant lands exactly where the boundary is exercised.
  // `contaminationMarkers` is filled in then; the fixture reads the same array
  // at request time.
  const contaminationMarkers = []

  fixture = await startFixtureProvider(markers, contaminationMarkers)
  seedIsolatedProvider(fixture.baseUrl)

  logPhase('installing from DMG')
  const installedAppPath = installFromDmg()
  mounted = false
  const executablePath = realpathSync(join(installedAppPath, 'Contents', 'MacOS', 'Ready'))

  logPhase('launch #1 + classify heads')
  runtime = await launchInstalledApp(executablePath)
  await showAgentPanel(runtime.cdp)
  const classification = await classifyAllHeads(runtime.cdp, sourceTargets)
  assertClassification(classification, sourceTargets)
  const pristineTargets = sourceTargets.filter((target) => !target.started
    && classification.find((row) => row.label === target.label)?.availability === 'ready')
  if (pristineTargets.length !== 2 || classification.some((row) => !row.started
    && row.availability !== 'ready' && !row.recoveryAvailable)) {
    throw new Error('the two pristine legacy roots or the settled failed-start recovery were omitted')
  }
  for (const target of pristineTargets) for (const round of [1, 2]) {
    markers.set(`READY_HISTORY_${target.label}_R${round}_${proofId}`, {
      label: target.label, round, kind: 'pristine_legacy', priorWitnessDigests: [],
    })
  }
  const pristineFirst = new Map()
  const pristineResults = []
  const runPristineRound = async (round) => {
    for (const target of pristineTargets) {
      const result = await runFreshRootTurn(runtime.cdp, { ...target, round, proofId })
      const row = sqliteJson(databasePath, `SELECT b.alias_generation, b.codex_thread_id, s.message_visibility_epoch
        FROM codex_thread_bindings b JOIN chat_conversations s ON s.id = b.ready_scope_id
        WHERE b.ready_conversation_alias = ${sqlQuote(target.aliasId)} AND b.retired_at IS NULL;`)[0]
      if (!result.ok || !row?.codex_thread_id || Number(row.alias_generation) !== target.originalGeneration + 1
        || Number(row.message_visibility_epoch) !== 0
        || (round === 2 && row.codex_thread_id !== pristineFirst.get(target.label))) {
        throw new Error(`pristine legacy root did not continue after refresh: ${JSON.stringify({ label: target.label, round, result })}`)
      }
      pristineFirst.set(target.label, row.codex_thread_id)
      pristineResults.push({ label: target.label, round, disposition: result.disposition,
        nextSend: result.nextSend, nativeThreadDigest: sha256(row.codex_thread_id) })
    }
  }
  const readyLabels = new Set(classification.filter((result) => result.started
    && result.availability === 'ready').map((result) => result.label))
  const readyStartedTargets = startedTargets.filter((target) => readyLabels.has(target.label))
  // The recovery denominator is production's own answer, never this script's
  // guess: `recoveryAvailable` is `Boolean(surface.beginNewContext)`, the
  // offer the head actually projects. Every head that offers one is exercised.
  // Two shapes exist in this population and both are real product paths:
  // `history_only` (B01, no active binding left) and `active_head` whose
  // `resolveHeadContinuation` returned `requires_new_context` — on this data
  // `native_tool_definition_changed` across the 0.146 group. An earlier
  // revision of this script asserted the second shape was unreachable without
  // a divergence closeout; the classification it printed in the same report
  // said otherwise, and the classification is right.
  const recoverableRows = classification.filter((result) => result.recoveryAvailable)
  const recoveryTargets = [
    {
      ...recoveryTarget, label: 'B01', expectedState: 'history_only',
      reason: 'history_only', workbenchMode: 'browser',
    },
    ...recoverableRows.map((result) => {
      const target = sourceTargets.find((item) => item.label === result.label)
      if (!target) throw new Error(`recoverable head outside the census: ${result.label}`)
      return {
        ...target,
        expectedState: result.state,
        reason: result.blockers.join('+') || 'requires_new_context',
      }
    }),
  ]
  // A boundary marker keeps the real prior-witness digests read out of the
  // rollout file. The boundary assertion is that none of them appear in the
  // request, so an empty list would make it vacuous.
  for (const target of recoveryTargets) {
    for (const round of [1, 2]) {
      markers.set(`READY_HISTORY_${target.label}_R${round}_${proofId}`, {
        label: target.label, round, kind: 'boundary',
        priorWitnessDigests: target.priorWitnessDigests || [],
      })
    }
  }
  // P1-3. `fresh_root_with_tail` is minted by exactly one production shape:
  // a publication-divergence closeout on a head that has NO accepted fork
  // boundary yet. With one, `completePublicationDivergenceCloseoutInOpenTransaction`
  // forks the native thread instead (`native_fork`), and a `legacy` lineage
  // root has no handoff tail at all (`readUncommittedOriginTails` returns
  // empty, and an empty tail is rejected) — so no head in an installed
  // population can produce it. The only candidate is a conversation whose very
  // first turn diverges, which is why this scenario creates a real new
  // conversation through the app and fails its first turn at the provider.
  for (const { label } of freshRootCases) for (const round of [1, 2, 3]) {
    markers.set(`READY_HISTORY_${label}_R${round}_${proofId}`, {
      label, round, priorWitnessDigests: [],
      kind: ['fresh_root_failure', 'fresh_root_recovery', 'fresh_root_continuation'][round - 1],
    })
  }

  // Every ready+started head completes two ordinary rounds and a third after
  // restart. Recovery candidates are tested separately, without dropping any
  // head that production declared continuable from this denominator.
  logPhase('rounds 1-2')
  await runPristineRound(1)
  const firstTwoRounds = await runSameThreadRounds(runtime.cdp, readyStartedTargets, [1, 2])
  assertRoundResults(firstTwoRounds, readyStartedTargets, [1, 2])
  const roundOneTwoLabels = new Set(firstTwoRounds.map((result) => result.label))
  const missingReadyLabels = [...readyLabels].filter((label) => !roundOneTwoLabels.has(label))
  if (missingReadyLabels.length > 0) {
    throw new Error(`ready heads without ordinary rounds: ${missingReadyLabels.join(',')}`)
  }

  await stopInstalledApp(runtime)
  runtime = null
  // Planted while the app is stopped, so the next launch restores the hint from
  // meta_json exactly the way a real resume does.
  const contaminationAliasIds = recoveryTargets.map((target) => target.aliasId)
  logPhase('planting non-input state (pass 1)')
  const contaminationByAlias = plantBoundaryContaminationState(contaminationAliasIds)
  contaminationMarkers.push(...new Set(
    [...contaminationByAlias.values()].map((entry) => entry.donorConversationId),
  ))
  runtime = await launchInstalledApp(executablePath)
  await showAgentPanel(runtime.cdp)

  logPhase('round 3 after restart #1')
  await runPristineRound(2)
  const thirdRound = await runSameThreadRounds(runtime.cdp, readyStartedTargets, [3])
  assertRoundResults(thirdRound, readyStartedTargets, [3])
  const restartRoundLabels = new Set(thirdRound.map((result) => result.label))
  const missingRestartLabels = [...readyLabels].filter((label) => !restartRoundLabels.has(label))
  if (missingRestartLabels.length > 0) {
    throw new Error(`ready heads without a restart round: ${missingRestartLabels.join(',')}`)
  }

  // Round 3 re-persists the reference hint, so the state the boundary is asked
  // to clear is planted again immediately before it runs and read back through
  // the production reader while the app is live. That makes the post-boundary
  // absence a real clearance result instead of an absence that predates it.
  await stopInstalledApp(runtime)
  runtime = null
  logPhase('planting non-input state (pass 2, pre-boundary)')
  const contaminationBeforeBoundary = plantBoundaryContaminationState(contaminationAliasIds)
  contaminationMarkers.push(...new Set(
    [...contaminationBeforeBoundary.values()].map((entry) => entry.donorConversationId),
  ))
  runtime = await launchInstalledApp(executablePath)
  await showAgentPanel(runtime.cdp)
  const contaminationLiveBefore = new Map()
  for (const target of recoveryTargets) {
    const attached = await readAttachedRecallContexts(runtime.cdp, target.aliasId)
    // The live positive control: the production reader itself returns the
    // planted capsule. Only a legally shaped ref survives
    // `readSessionRecallContextRefs` + `canAttachSessionRecallContext`, so a
    // non-empty result proves the state the boundary must clear was real.
    if (!Array.isArray(attached) || attached.length === 0) {
      throw new Error(`planted recall context was not readable by production for ${target.label}`)
    }
    const state = readContaminationStateForAliases([target.aliasId]).get(target.aliasId)
    if (!state.hintLegal || !state.recallLegal) {
      throw new Error(`planted contamination state is not production-legal for ${target.label}`)
    }
    contaminationLiveBefore.set(target.label, {
      attachedRecallContexts: attached.length,
      hintSkillId: state.hintSkillId,
      recallConversationIds: state.recallConversationIds,
      recallIndexRows: countScopeRecallRows(target.aliasId),
    })
  }

  // Boundaries run last, after every continuable head has proven its three
  // rounds, and are then re-verified across a second restart.
  logPhase('boundaries, first boot')
  const boundaryFirst = []
  const boundaryActionRefs = new Map()
  for (const target of recoveryTargets) {
    const { actionRef, ...result } = await beginBoundaryAndSend(runtime.cdp, target)
    if (!result.ok || !result.draftPreserved || !result.boundaryVisible
      || result.visibleMessagesAfterBoundary !== result.visibleMessagesBefore) {
      throw new Error(`installed boundary first boot failed: ${JSON.stringify(result)}`)
    }
    boundaryActionRefs.set(target.label, actionRef)
    boundaryFirst.push({ ...result, label: target.label, reason: target.reason })
  }

  await stopInstalledApp(runtime)
  runtime = null
  runtime = await launchInstalledApp(executablePath)
  await showAgentPanel(runtime.cdp)

  logPhase('boundaries, after restart #3')
  const boundarySecond = []
  for (const [index, target] of recoveryTargets.entries()) {
    const result = await verifyBoundaryAfterRestart(
      runtime.cdp, target, boundaryFirst[index].operationId, boundaryActionRefs.get(target.label),
    )
    if (!result.ok || !result.boundaryVisible || !result.committedReplayVerified
      || result.operationId !== boundaryFirst[index].operationId) {
      throw new Error(`installed boundary restart failed: ${JSON.stringify(result)}`)
    }
    boundarySecond.push({ ...result, label: target.label, reason: target.reason })
  }
  // The denominator check, made after the fact rather than by construction:
  // every head production offered a begin-new-context for has now completed a
  // boundary and both post-boundary rounds.
  const boundaryLabels = new Set(boundarySecond.map((result) => result.label))
  const unverifiedRecoverable = recoverableRows
    .filter((result) => !boundaryLabels.has(result.label))
    .map((result) => result.label)
  if (unverifiedRecoverable.length > 0) {
    throw new Error(`heads production declares recoverable were left unverified: ${unverifiedRecoverable.join(',')}`)
  }

  // Boundary clearance joins legal persisted hints, the live recall reader,
  // and the actual model request. Hint replay/selection is independently tested
  // through the real runtime, not inferred from an unreachable typed tool name.
  logPhase('post-boundary clearance checks')
  const contaminationAfterBoundary = new Map()
  for (const target of recoveryTargets) {
    const state = readContaminationStateForAliases([target.aliasId]).get(target.aliasId)
    if (state.hintPresent || state.recallPresent) {
      throw new Error(`context boundary left non-input state behind for ${target.label}: ${JSON.stringify(state)}`)
    }
    const attached = await readAttachedRecallContexts(runtime.cdp, target.aliasId)
    if (attached.length !== 0) {
      throw new Error(`context boundary left an attached recall context for ${target.label}`)
    }
    // Deliberately not asserted as zero: the boundary deletes the scope's recall
    // index rows, and the turn that follows it re-indexes the new context. Both
    // counts are reported so the rebuild is visible instead of being mistaken
    // for leftovers from the old context.
    const recallIndexRows = countScopeRecallRows(target.aliasId)
    contaminationAfterBoundary.set(target.label, {
      attachedRecallContexts: attached.length,
      hintPresent: state.hintPresent,
      recallPresent: state.recallPresent,
      recallIndexRows,
    })
  }

  const freshRootProof = await runFreshRootInstalledProof({
    getCdp: () => runtime.cdp, databasePath, captures: fixture.captures, proofId, logPhase,
    restart: async () => {
      await stopInstalledApp(runtime)
      runtime = null
      runtime = await launchInstalledApp(executablePath)
      await showAgentPanel(runtime.cdp)
    },
  })

  // Each screenshot must be taken on the surface it claims to show. The
  // previous revision shot the same-thread frame while the app was still
  // parked on the boundary target from the step above, then re-activated that
  // same target — producing two byte-identical PNGs, one of them mislabelled.
  const sameThreadScreenshotTarget = readyStartedTargets[0]
  const sameThreadScope = await activateTarget(runtime.cdp, sameThreadScreenshotTarget.aliasId)
  if (sameThreadScope.currentScopeId !== sameThreadScreenshotTarget.aliasId) {
    throw new Error(`same-thread screenshot is not on ${sameThreadScreenshotTarget.label}: ${JSON.stringify(sameThreadScope)}`)
  }
  const sameThreadFrame = await captureScreenshot(runtime.cdp, sameThreadScreenshotPath,
    '[data-liquid-scroll-root="chat-messages"] .ready-agent-prose', `READY_HISTORY_OK_${sameThreadScreenshotTarget.label}_R3`)
  const boundaryScope = await activateTarget(runtime.cdp, recoveryTargets[0].aliasId)
  if (boundaryScope.currentScopeId !== recoveryTargets[0].aliasId) {
    throw new Error(`boundary screenshot is not on ${recoveryTargets[0].label}: ${JSON.stringify(boundaryScope)}`)
  }
  const boundaryFrame = await captureScreenshot(runtime.cdp, boundaryScreenshotPath,
    `[data-ready-context-boundary="${boundaryFirst[0].operationId}"]`, '从这里开始新的上下文')
  if (sha256File(sameThreadScreenshotPath) === sha256File(boundaryScreenshotPath)) {
    throw new Error('the two acceptance screenshots are identical; at least one is not showing what it claims')
  }

  assertProviderCaptures(fixture.captures, readyStartedTargets, recoveryTargets, pristineTargets, freshRootProof)
  const continuityReadback = verifyDatabaseContinuity(
    sourceTargets, readyStartedTargets, recoveryTargets,
  )
  const report = {
    contract: 'ready_history_continuation_installed_proof_v1',
    status: 'passed',
    logicalConversationTurns: readyStartedTargets.length * 3 + recoveryTargets.length * 2
      + pristineTargets.length * 2 + freshRootCases.length * 3,
    providerRequestAttempts: fixture.captures.length,
    package: {
      sha256: packageSha256,
      buildIdentity: packageReceipt.buildIdentity,
      receiptSha256: sha256File(`${dmgPath}.receipt.json`),
      embeddedBuildIdentityVerified: true,
      codesignVerified: true,
      runtimeContinuityAssetsPresent: true,
    },
    isolation: {
      readyDatabaseCopied: true,
      codexHistoryCopied: true,
      copiedNativePathsRebased: true,
      provider: 'local_fixture_only',
      externalToolCalls: 0,
      realUserDataWrites: 0,
      // Stated exactly as performed: the copy's open leases are settled to
      // tree-zero by the isolation step itself. That is synthesized evidence,
      // not an observation of the real processes, and nothing is deleted.
      __breaksInvariants: isolatedExternalLeaseCount > 0
        ? ['open sidecar process leases in the isolated database copy are settled to a synthesized tree-zero by the isolation step; the digests are not real process-observation evidence']
        : [],
      isolatedExternalLeaseCount,
      isolatedExternalLeaseDisposition: isolatedExternalLeaseCount > 0
        ? 'settled_to_synthesized_tree_zero' : 'none_open',
    },
    population: {
      legacyActiveHeads: sourceTargets.length,
      startedHeads: startedTargets.length,
      sourceGroups: Object.fromEntries([...supportedSources.values()].map(
        (source) => [source, sourceTargets.filter((target) => target.source === source).length],
      )),
      startedSourceGroups: Object.fromEntries([...supportedSources.values()].map(
        (source) => [source, startedTargets.filter((target) => target.source === source).length],
      )),
    },
    productionPreflight: summarizeClassification(classification),
    installedPristineLegacyRoots: pristineResults,
    installedSameThread: {
      headsExercised: readyStartedTargets.length,
      readyStartedHeads: readyLabels.size,
      headsCompletingRoundsOneAndTwo: roundOneTwoLabels.size,
      headsCompletingRestartRound: restartRoundLabels.size,
      roundsPerHead: 3,
      formalRendererSends: firstTwoRounds.length + thirdRound.length,
      sameNativeThreadAfterEveryRound: continuityReadback.sameThreadMatches,
      previousNativeContextObservedOnFirstRound: fixture.captures.filter(
        (capture) => capture.kind === 'same_thread' && capture.round === 1 && capture.hasPriorContext,
      ).length,
      // Derived, not asserted: every first-round same-thread request must have
      // matched at least one witness digest taken from the real rollout file.
      previousNativeContextMatchedByExactMessageDigest: fixture.captures
        .filter((capture) => capture.kind === 'same_thread' && capture.round === 1)
        .every((capture) => capture.priorWitnessMatchCount > 0),
      nonBrowserModeHeadsExercised: readyStartedTargets.filter(
        (target) => target.workbenchMode !== 'browser',
      ).length,
      exactOnceCurrentInputs: fixture.captures.filter(
        (capture) => capture.kind === 'same_thread' && capture.currentMarkerCount === 1,
      ).length,
      restartRoundPassed: thirdRound.length === readyStartedTargets.length,
      // Positive controls: the hint is legal persisted state, and the recall
      // context is readable through the real production reader.
      boundaryNonInputStateAliasesPlanted: contaminationBeforeBoundary.size,
      boundaryRecallContextReadableBeforeBoundary: true,
      // Why the reference hint is proven on the meta surface only, and not by
      // looking for a hint-armed tool in a request: a typed skill action is
      // never `codexExecutionSafe`, so `resolveReadyToolTurnSnapshot` filters
      // it out of every Codex tool surface. A tool-name check would be a check
      // that cannot fail in either direction. The local restore path itself
      // (persist -> restart -> replay, and no replay across a boundary) is
      // proven by src/__tests__/local-scope-reference-hint-replay-native.test.ts.
      boundaryHintObservable: 'chat_conversations.meta_json.lastReferenceSkill',
      boundaryNonInputStateBeforeBoundary: Object.fromEntries(contaminationLiveBefore),
      boundaryNonInputStateAfterBoundary: Object.fromEntries(contaminationAfterBoundary),
      boundaryContaminationHits: fixture.captures.reduce(
        (total, capture) => total + (capture.contaminationHits?.length || 0), 0,
      ),
      terminalAndNextActionPassed: firstTwoRounds.length + thirdRound.length,
    },
    installedRecoveryDenominator: {
      headsProductionOffersBeginNewContext: recoverableRows.map((row) => row.label),
      historyOnlyHeads: ['B01'],
      exercised: recoveryTargets.map((target) => target.label),
    },
    installedRecovery: recoveryTargets.map((target, index) => ({
      label: target.label,
      reason: target.reason,
      sourceStateObserved: boundaryFirst[index].sourceState,

      visibleMessagesPreserved: boundaryFirst[index].visibleMessagesAfterBoundary
        === boundaryFirst[index].visibleMessagesBefore,
      draftPreserved: boundaryFirst[index].draftPreserved,
      boundaryOperationDigest: sha256(boundaryFirst[index].operationId),
      boundaryVisibleBeforeRestart: boundaryFirst[index].boundaryVisible,
      boundaryVisibleAfterRestart: boundarySecond[index].boundaryVisible,
      committedRecoveryReplayVerified: boundarySecond[index].committedReplayVerified,
      freshNativeContextOnFirstSend: fixture.captures.some(
        (capture) => capture.label === target.label && capture.round === 1
          && capture.userMessageCount === 1 && capture.assistantMessageCount === 0,
      ),
      postRestartContextContainsOnlyPostBoundaryInput: fixture.captures.some(
        (capture) => capture.label === target.label && capture.round === 2
          && capture.priorMarkerCounts[`${target.label}:R1`] === 1
          && capture.priorWitnessMatchCount === 0,
      ),
      sourceContextDigestAbsentBeforeAndAfterRestart: fixture.captures
        .filter((capture) => capture.label === target.label)
        .every((capture) => capture.priorWitnessMatchCount === 0),
    })),
    installedFreshRootWithTail: freshRootProof,
    screenshots: {
      sameThreadAfterRestart: {
        path: sameThreadScreenshotPath,
        scopeLabel: sameThreadScreenshotTarget.label,
        scopeId: sameThreadScreenshotTarget.aliasId,
        sha256: sha256File(sameThreadScreenshotPath),
        frame: sameThreadFrame,
      },
      contextBoundaryAfterRestart: {
        path: boundaryScreenshotPath,
        scopeLabel: recoveryTargets[0].label,
        scopeId: recoveryTargets[0].aliasId,
        sha256: sha256File(boundaryScreenshotPath),
        frame: boundaryFrame,
      },
    },
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ status: 'passed', reportPath, packageSha256 })}\n`)
} catch (error) {
  proofFailed = true
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  const applicationLog = runtime?.logs?.slice(-160).join('') || ''
  const directLogPath = join(tempPath, 'ready-directchat.log')
  const directLog = existsSync(directLogPath)
    ? readFileSync(directLogPath, 'utf8').split('\n').slice(-240).join('\n')
    : ''
  const metricsLogPath = join(tempPath, 'ready-agent-metrics.log')
  const metricsLog = existsSync(metricsLogPath)
    ? readFileSync(metricsLogPath, 'utf8').split('\n').slice(-240).join('\n')
    : ''
  writeFileSync(join(runRoot, 'failed-proof.log'), [
    String(error?.stack || error),
    applicationLog ? `\n[installed application]\n${applicationLog}` : '',
    directLog ? `\n[direct chat]\n${directLog}` : '',
    metricsLog ? `\n[agent metrics]\n${metricsLog}` : '',
  ].join(''), { mode: 0o600 })
  throw error
} finally {
  if (runtime) await stopInstalledApp(runtime).catch(() => {})
  await fixture?.close()
  if (mounted) detachDmg()
  rmSync(mountPoint, { recursive: true, force: true })
  if (!(proofFailed && process.env.READY_HISTORY_PROOF_KEEP_FAILED === '1')) {
    rmSync(profilePath, { recursive: true, force: true })
    rmSync(tempPath, { recursive: true, force: true })
    rmSync(installedRoot, { recursive: true, force: true })
  }
}

function argumentValue(prefix) {
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function countBySource(targets, source) {
  return targets.filter((target) => target.source === source).length
}

function copyReadyDatabase() {
  const openWorkQuery = `
    SELECT
      (SELECT COUNT(*) FROM run_meta WHERE status IN ('running', 'waiting_input', 'paused_budget')) AS open_runs,
      (SELECT COUNT(*) FROM codex_thread_dispatch_fences) AS dispatch_fences;
  `
  const openWork = sqliteJson(sourceDbPath, openWorkQuery)[0]
  if (Number(openWork?.open_runs) !== 0 || Number(openWork?.dispatch_fences) !== 0) {
    throw new Error('source Ready profile has open work; installed proof refused to copy a moving execution')
  }
  execFileSync('/usr/bin/sqlite3', [sourceDbPath, `VACUUM INTO ${sqlQuote(databasePath)};`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const copiedWork = sqliteJson(databasePath, openWorkQuery)[0]
  if (Number(copiedWork?.open_runs) !== 0 || Number(copiedWork?.dispatch_fences) !== 0) {
    throw new Error('Ready work started during profile copy; isolated snapshot is not quiescent')
  }
}

function freezeExternalProcessLeasesInCopy() {
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA foreign_keys=ON')
    const open = db.prepare(`
      SELECT process_lease_id FROM codex_sidecar_process_leases
       WHERE tree_zero_at IS NULL
    `).all()
    if (open.length === 0) return 0
    // An open lease may already be referenced by codex_thread_resume_evidence
    // (a normal restart that resumed an old thread produces exactly that). The
    // copy must therefore *terminate* the lease, not delete one end of a live
    // relationship: settling tree-zero is the same transition the product uses,
    // and the schema only freezes these columns once they are non-null.
    const settledAt = new Date().toISOString()
    const evidenceDigest = sha256(`installed-proof-isolated-lease-freeze:${proofId}:${settledAt}`)
    const settled = db.prepare(`
      UPDATE codex_sidecar_process_leases
         SET closed_at = COALESCE(closed_at, ?),
             tree_zero_at = ?,
             tree_zero_matcher_mode = 'post_cas',
             stable_zero_sample_transcript_digest = ?,
             tree_zero_evidence_digest = ?,
             revision = revision + 1
       WHERE tree_zero_at IS NULL
    `).run(settledAt, settledAt, evidenceDigest, evidenceDigest)
    if (Number(settled.changes) !== open.length) {
      throw new Error('isolated external lease freeze did not settle every open lease')
    }
    const stillOpen = db.prepare(`
      SELECT COUNT(*) AS n FROM codex_sidecar_process_leases WHERE tree_zero_at IS NULL
    `).get()
    if (Number(stillOpen?.n) !== 0) throw new Error('isolated external lease freeze left an open lease')
    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeyErrors.length > 0) {
      throw new Error('isolated external lease freeze broke historical references')
    }
    return open.length
  } finally {
    db.close()
  }
}

// The reference-skill hint and the attached recall context are the two pieces of
// non-input durable state a context boundary must clear. Planting them only has
// proof value when production readers accept the planted shape: a hint without
// the scope's current `messageVisibilityEpoch` is rejected by
// `restoreLastReferenceSkill`, and a recall context written as an object is
// dropped by `readSessionRecallContextRefs`, which requires an array of
// `{conversationId, attachedAt}`. Both forms would make the boundary check pass
// without the boundary doing anything.

function plantBoundaryContaminationState(aliasIds) {
  const planted = new Map()
  const db = new DatabaseSync(databasePath)
  try {
    for (const aliasId of aliasIds) {
      const scope = db.prepare(`
        SELECT meta_json, agent, closed_at, message_visibility_epoch
          FROM chat_conversations WHERE id = ? LIMIT 1
      `).get(aliasId)
      if (!scope) throw new Error(`contamination planting scope missing: ${aliasId}`)
      if (scope.closed_at !== null) throw new Error(`contamination planting scope closed: ${aliasId}`)
      const epoch = Number(scope.message_visibility_epoch ?? 0)
      // `canAttachSessionRecallContext` accepts a capsule only when its agent
      // matches the scope's, so the donor has to be a real recall row of the
      // same agent — a synthesized id would be dropped by the reader.
      const donor = db.prepare(`
        SELECT conversation_id FROM session_recall_metadata
         WHERE COALESCE(agent, '') = COALESCE(?, '') AND conversation_id <> ?
         LIMIT 1
      `).get(scope.agent ?? '', aliasId)
      if (!donor) throw new Error(`no attachable recall capsule for ${aliasId}; the boundary check would be vacuous`)
      let meta
      try { meta = JSON.parse(scope.meta_json || '{}') } catch { meta = {} }
      const attachedAt = new Date().toISOString()
      meta.lastReferenceSkill = {
        id: HINT_ARMED_SKILL_ID,
        name: HINT_ARMED_SKILL_ID,
        at: Date.now(),
        messageVisibilityEpoch: epoch,
      }
      meta.sessionRecallContext = [{ conversationId: donor.conversation_id, attachedAt }]
      db.prepare('UPDATE chat_conversations SET meta_json = ? WHERE id = ?')
        .run(JSON.stringify(meta), aliasId)
      const readback = readContaminationState(db, aliasId)
      if (!readback.hintLegal || !readback.recallLegal
        || readback.hintEpoch !== epoch
        || readback.recallConversationIds[0] !== donor.conversation_id) {
        throw new Error(`contamination state was not planted in a production-legal shape for ${aliasId}`)
      }
      planted.set(aliasId, {
        skillId: HINT_ARMED_SKILL_ID,
        donorConversationId: donor.conversation_id,
        messageVisibilityEpoch: epoch,
      })
    }
    return planted
  } finally {
    db.close()
  }
}

// Mirrors the two production readers exactly: a record only counts as present
// when the shape the runtime requires is present, so "cleared" can never be
// satisfied by a plant that was never readable in the first place.
function readContaminationState(db, aliasId) {
  const row = db.prepare(`
    SELECT meta_json, message_visibility_epoch FROM chat_conversations WHERE id = ? LIMIT 1
  `).get(aliasId)
  if (!row) throw new Error(`contamination readback scope missing: ${aliasId}`)
  let meta
  try { meta = JSON.parse(row.meta_json || '{}') } catch { meta = {} }
  const hint = meta.lastReferenceSkill
  const hintLegal = Boolean(hint) && typeof hint === 'object'
    && typeof hint.id === 'string' && hint.id.trim().length > 0
    && typeof hint.name === 'string' && typeof hint.at === 'number' && hint.at > 0
  const recall = Array.isArray(meta.sessionRecallContext) ? meta.sessionRecallContext : []
  const recallRefs = recall.filter((item) => item && typeof item === 'object'
    && typeof item.conversationId === 'string' && item.conversationId.trim().length > 0)
  return {
    hintPresent: 'lastReferenceSkill' in meta,
    hintLegal,
    hintSkillId: hintLegal ? hint.id : null,
    hintEpoch: hintLegal && typeof hint.messageVisibilityEpoch === 'number'
      ? hint.messageVisibilityEpoch : null,
    recallPresent: 'sessionRecallContext' in meta,
    recallLegal: recallRefs.length > 0,
    recallConversationIds: recallRefs.map((item) => item.conversationId),
    messageVisibilityEpoch: Number(row.message_visibility_epoch ?? 0),
  }
}

function readContaminationStateForAliases(aliasIds) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return new Map(aliasIds.map((aliasId) => [aliasId, readContaminationState(db, aliasId)]))
  } finally {
    db.close()
  }
}

// The boundary also drops the recall index rows for the scope. Reading them back
// keeps the clearance claim tied to the tables production actually deletes.
function countScopeRecallRows(aliasId) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    let total = 0
    for (const table of ['session_recall_metadata', 'session_recall_vectors',
      'session_recall_attachment_index']) {
      const present = db.prepare('SELECT 1 AS present FROM sqlite_master WHERE name = ? LIMIT 1').get(table)
      if (!present) continue
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE conversation_id = ?`).get(aliasId)
      total += Number(row?.count ?? 0)
    }
    return total
  } finally {
    db.close()
  }
}

function copyCodexHistory() {
  mkdirSync(copiedCodexHome, { recursive: true, mode: 0o700 })
  for (const directory of ['sessions', 'archived_sessions']) {
    const source = join(sourceCodexHome, directory)
    if (existsSync(source)) cpSync(source, join(copiedCodexHome, directory), { recursive: true })
  }
  for (const file of ['installation_id', '.sandbox_migration']) {
    const source = join(sourceCodexHome, file)
    if (existsSync(source)) cpSync(source, join(copiedCodexHome, file))
  }
  const copiedStatePath = join(copiedCodexHome, 'state_5.sqlite')
  execFileSync('/usr/bin/sqlite3', [join(sourceCodexHome, 'state_5.sqlite'),
    `VACUUM INTO ${sqlQuote(copiedStatePath)};`], { stdio: ['ignore', 'pipe', 'pipe'] })
  const state = new DatabaseSync(copiedStatePath)
  try {
    state.prepare('UPDATE threads SET rollout_path = replace(rollout_path, ?, ?)')
      .run(sourceCodexHome, copiedCodexHome)
    const leaked = state.prepare('SELECT COUNT(*) AS count FROM threads WHERE instr(rollout_path, ?) = 1')
      .get(sourceCodexHome)
    if (Number(leaked?.count) !== 0) throw new Error('copied Codex state still points to real history')
  } finally {
    state.close()
  }
}

function selectSourceTargets() {
  const quoted = [...supportedSources.keys()].map(sqlQuote).join(',')
  return sqliteJson(databasePath, `
    SELECT ready_conversation_alias AS alias_id, alias_generation,
           runtime_manifest_digest, codex_thread_id
      FROM codex_thread_bindings
     WHERE retired_at IS NULL AND runtime_manifest_digest IN (${quoted})
     ORDER BY runtime_manifest_digest, ready_conversation_alias;
  `).map((row, index) => ({
    label: `H${String(index + 1).padStart(2, '0')}`,
    aliasId: row.alias_id,
    originalGeneration: Number(row.alias_generation),
    source: supportedSources.get(row.runtime_manifest_digest),
    sourceDigest: row.runtime_manifest_digest,
    started: Boolean(row.codex_thread_id),
    originalThreadId: row.codex_thread_id || null,
  }))
}

function attachNativeHistoryWitnesses(targets) {
  const state = new DatabaseSync(join(copiedCodexHome, 'state_5.sqlite'), { readOnly: true })
  try {
    const readThread = state.prepare('SELECT rollout_path FROM threads WHERE id = ? LIMIT 1')
    return targets.map((target) => {
      // A never-started head has no native thread by definition, so it carries
      // no prior witnesses. Only a head the census counts as started must have
      // one — for those a missing thread is still a hard failure.
      if (!target.originalThreadId) {
        if (target.started === false) return { ...target, priorWitnessDigests: [] }
        throw new Error(`native history witness thread missing for ${target.label}`)
      }
      const row = readThread.get(target.originalThreadId)
      if (typeof row?.rollout_path !== 'string' || !existsSync(row.rollout_path)) {
        throw new Error(`native history witness rollout missing for ${target.label}`)
      }
      const witnessDigests = []
      for (const line of readFileSync(row.rollout_path, 'utf8').split('\n')) {
        if (!line) continue
        let item
        try { item = JSON.parse(line) } catch { continue }
        const message = item?.type === 'response_item' ? item.payload : null
        if (message?.type !== 'message' || message.role !== 'user'
          || !Array.isArray(message.content) || message.content.length === 0) continue
        witnessDigests.push(messageWitnessDigest(message))
      }
      const priorWitnessDigests = [...new Set(witnessDigests)].slice(-8)
      if (priorWitnessDigests.length === 0) {
        throw new Error(`native history witness content missing for ${target.label}`)
      }
      return { ...target, priorWitnessDigests }
    })
  } finally {
    state.close()
  }
}

function messageWitnessDigest(message) {
  return sha256(JSON.stringify({ role: message.role, content: message.content }))
}

function selectHistoryOnlyTarget() {
  const row = sqliteJson(databasePath, `
    SELECT c.id AS alias_id, MAX(b.alias_generation) AS source_generation,
           COUNT(m.id) AS visible_messages,
           (
             SELECT source.codex_thread_id FROM codex_thread_bindings source
              WHERE source.ready_conversation_alias = c.id
                AND source.codex_thread_id IS NOT NULL
              ORDER BY source.alias_generation DESC LIMIT 1
           ) AS source_thread_id
      FROM chat_conversations c
      JOIN codex_thread_bindings b ON b.ready_conversation_alias = c.id
      LEFT JOIN chat_messages m ON m.conversation_id = c.id
     WHERE c.closed_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM codex_thread_bindings active
          WHERE active.ready_conversation_alias = c.id AND active.retired_at IS NULL
       )
       AND EXISTS (
         SELECT 1 FROM codex_thread_bindings native_source
          WHERE native_source.ready_conversation_alias = c.id
            AND native_source.codex_thread_id IS NOT NULL
       )
     GROUP BY c.id
    HAVING COUNT(m.id) > 0
     ORDER BY MAX(c.updated_at) DESC
     LIMIT 1;
  `)[0]
  if (!row?.alias_id || !Number.isSafeInteger(Number(row.source_generation))) {
    throw new Error('history-only recovery target missing')
  }
  return {
    label: 'B01', aliasId: row.alias_id,
    originalGeneration: Number(row.source_generation),
    visibleMessages: Number(row.visible_messages),
    originalThreadId: row.source_thread_id,
  }
}

function seedIsolatedProvider(baseUrl) {
  const setting = sqliteJson(databasePath, `SELECT value FROM settings WHERE key = 'ai_provider_workspace'`)[0]
  const workspace = JSON.parse(setting?.value || 'null')
  const active = workspace?.profiles?.find((profile) => profile.id === workspace.activeProfileId)
  if (!active?.config || active.config.agentProtocol !== 'openai') {
    throw new Error('copied profile has no active OpenAI-protocol provider to isolate')
  }
  const config = {
    ...active.config,
    baseUrl,
    apiKey: `ready-history-proof-${proofId}`,
    authMode: 'api-key',
    wireApi: 'responses',
    reasoningEffort: undefined,
    toolUseMode: 'on',
  }
  const isolatedWorkspace = {
    ...workspace,
    profiles: workspace.profiles.map((profile) => profile.id === active.id
      ? { ...profile, config } : profile),
  }
  const now = new Date().toISOString()
  const values = [
    ['ai_provider_workspace', isolatedWorkspace],
    ['ai_model_config', config],
    ['ai_saved_configs', { [config.provider]: config, [active.id]: config }],
  ].map(([key, value]) => `(${sqlQuote(key)}, ${sqlQuote(JSON.stringify(value))}, ${sqlQuote(now)})`)
    .join(',')
  execFileSync('/usr/bin/sqlite3', [databasePath, `
    INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ${values};
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
}

function installFromDmg() {
  execFileSync('/usr/bin/hdiutil', ['verify', dmgPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('/usr/bin/hdiutil', [
    'attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  mounted = true
  const mountedAppPath = join(mountPoint, 'Ready.app')
  const resourcesPath = join(mountedAppPath, 'Contents', 'Resources')
  const asar = createRequire(import.meta.url)('@electron/asar')
  const embeddedBuild = JSON.parse(asar.extractFile(
    join(resourcesPath, 'app.asar'), releasePackageIdentity.BUILD_IDENTITY_REL,
  ).toString('utf8'))
  releasePackageIdentity.assertPackagedReleaseBuildIdentity(packageReceipt, embeddedBuild,
    sha256File(join(resourcesPath, 'codex-runtime', 'runtime-manifest.json')))
  const applicationsLink = join(mountPoint, 'Applications')
  if (!lstatSync(applicationsLink).isSymbolicLink() || readlinkSync(applicationsLink) !== '/Applications') {
    throw new Error('mounted Applications link mismatch')
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=1', mountedAppPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const continuityPath = join(mountedAppPath, 'Contents', 'Resources', 'runtime-continuity')
  for (const name of ['runtime-sources.json', 'runtime-continuity-transitions.json']) {
    if (!existsSync(join(continuityPath, name))) throw new Error(`packaged continuity asset missing: ${name}`)
  }
  const installedAppPath = join(installedRoot, 'Ready.app')
  execFileSync('/usr/bin/ditto', [mountedAppPath, installedAppPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=1', installedAppPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (sha256File(join(installedAppPath, 'Contents', 'Resources', 'app.asar'))
    !== sha256File(join(mountedAppPath, 'Contents', 'Resources', 'app.asar'))) {
    throw new Error('isolated installed app identity mismatch')
  }
  detachDmg()
  return installedAppPath
}

function detachDmg() {
  try {
    execFileSync('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    execFileSync('/usr/bin/hdiutil', ['detach', mountPoint, '-force', '-quiet'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  mounted = false
}

async function launchInstalledApp(executablePath) {
  const remotePort = await nextAvailablePort()
  const child = spawn(executablePath, [`--remote-debugging-port=${remotePort}`], {
    cwd: projectRoot,
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
    if (!handshake?.success || handshake.userDataPath !== profilePath
      || handshake.databasePath !== databasePath || handshake.execPath !== executablePath
      || handshake.execSha256 !== sha256File(executablePath)) {
      throw new Error(`installed handshake mismatch: ${JSON.stringify(handshake)}`)
    }
    cdp = await enableAgentPanelHarness(cdp, remotePort)
    return { child, cdp, logs }
  } catch (error) {
    cdp?.close()
    await closeChildProcess(child, { gracefulSignal: 'SIGTERM', timeoutMs: 30_000 })
    throw new Error(`${String(error)}\n${logs.slice(-80).join('')}`)
  }
}

async function nextAvailablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => rejectPort(new Error('proof port allocation failed')))
        return
      }
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port))
    })
  })
}

async function stopInstalledApp(active) {
  const records = Number.isSafeInteger(active.child.pid)
    ? captureProcessCensus({ rootPid: active.child.pid }) : []
  try {
    await evaluateCdp(active.cdp,
      `window.electronAPI.app.browserLiveProofQuit(${JSON.stringify(proofNonce)})`, 5_000)
  } catch {}
  active.cdp.close()
  await closeChildProcess(active.child, { gracefulSignal: 'SIGTERM', timeoutMs: 30_000 })
  await terminateExactRecordedProcesses(records)
}

async function terminateExactRecordedProcesses(records) {
  if (records.length === 0) return
  try {
    await assertRecordedProcessesExited(records, { timeoutMs: 3_000 })
    return
  } catch {}
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const currentByPid = new Map(captureProcessCensus().map((row) => [row.pid, row]))
    for (const record of records.filter((item) => {
      const current = currentByPid.get(item.pid)
      return current?.processStartIdentity === item.processStartIdentity
        && current.command === item.command
    }).sort((left, right) => right.pid - left.pid)) {
      if (record.pid <= 1 || record.pid === process.pid) throw new Error('unsafe proof cleanup identity')
      try { process.kill(record.pid, signal) } catch {}
    }
    try {
      await assertRecordedProcessesExited(records, { timeoutMs: 5_000 })
      return
    } catch {}
  }
  await assertRecordedProcessesExited(records, { timeoutMs: 5_000 })
}

async function showAgentPanel(cdp) {
  const ready = await evaluateCdp(cdp, `(async () => {
    document.querySelector('button[title="展开聊天面板"]')?.click();
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (window.__READY_AGENT_TEST__?.sessionSummary().sessions.length > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  })()`, 70_000)
  if (!ready) throw new Error('installed agent panel did not become ready')
}

async function currentTargetIdentities(targets) {
  const rows = sqliteJson(databasePath, `
    SELECT ready_conversation_alias AS alias_id, alias_generation, codex_thread_id
      FROM codex_thread_bindings WHERE retired_at IS NULL;
  `)
  const current = new Map(rows.map((row) => [row.alias_id, row]))
  return targets.map((target) => {
    const row = current.get(target.aliasId)
    if (!row) throw new Error(`active copied head missing for ${target.label}`)
    return { ...target, generation: Number(row.alias_generation), currentThreadId: row.codex_thread_id || null }
  })
}

async function classifyAllHeads(cdp, targets) {
  const identities = await currentTargetIdentities(targets)
  return evaluateCdp(cdp, `(async () => {
    const targets = ${JSON.stringify(identities.map(({
      label, aliasId, generation, started, source, workbenchMode,
    }) => (
      { label, aliasId, generation, started, source, workbenchMode }
    )))};
    return Promise.all(targets.map(async (target) => {
      let surface = null;
      let lastRead = null;
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const read = await window.electronAPI.agent.readCodexActionSurface({
          aliasId: target.aliasId, aliasGeneration: target.generation,
          workbenchMode: target.workbenchMode,
        });
        lastRead = read;
        if (read.success) { surface = read.data; break; }
        const scopes = await window.electronAPI.agent.listConversationScopes();
        const current = scopes.data?.find((scope) => scope.id === target.aliasId);
        if (Number.isSafeInteger(current?.aliasGeneration)) target.generation = current.aliasGeneration;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        label: target.label, started: target.started, source: target.source,
        state: surface?.state || 'read_failed',
        availability: surface?.head?.actions?.send_new_message?.availability || null,
        blockers: surface?.head?.actions?.send_new_message?.blockers || [],
        recoveryAvailable: Boolean(surface?.beginNewContext),
        generation: surface?.sourceAliasGeneration || surface?.head?.actionProjectionVersion?.headGeneration || null,
        readError: surface ? null : (lastRead?.error || lastRead?.errorKind || 'unknown'),
      };
    }));
  })()`, 90_000)
}

function assertClassification(results, targets) {
  if (!Array.isArray(results) || results.length !== targets.length) {
    throw new Error(`production preflight did not classify all heads: ${JSON.stringify(results)}`)
  }
  const primaryLabels = new Set(targets.filter((target) => target.started && target.source === '0.149')
    .map((target) => target.label))
  const failedPrimary = results.filter((result) => primaryLabels.has(result.label)
    && (result.state !== 'active_head' || result.availability !== 'ready'))
  if (primaryLabels.size !== 7 || failedPrimary.length > 0) {
    throw new Error(`primary production preflight not ready: ${JSON.stringify(failedPrimary)}`)
  }
  if (results.some((result) => result.state === 'read_failed')) {
    throw new Error(`production preflight read failed: ${JSON.stringify(results)}`)
  }
}

function summarizeClassification(results) {
  const byOutcome = {}
  for (const result of results) {
    const key = result.availability === 'ready'
      ? 'ready'
      : result.blockers.length > 0 ? result.blockers.join('+') : result.state
    byOutcome[key] = (byOutcome[key] || 0) + 1
  }
  return {
    classifiedHeads: results.length,
    readySameThreadStartedHeads: results.filter((result) => result.started
      && result.availability === 'ready').length,
    outcomes: byOutcome,
    rows: results.map(({ label, source, started, state, availability, blockers, recoveryAvailable }) => ({
      label, source, started, state, availability, blockers, recoveryAvailable,
    })),
  }
}

async function runSameThreadRounds(cdp, targets, rounds) {
  const identities = await currentTargetIdentities(targets)
  const requests = []
  for (const target of identities) {
    for (const round of rounds) requests.push({
      label: target.label,
      aliasId: target.aliasId,
      generation: target.generation,
      marker: `READY_HISTORY_${target.label}_R${round}_${proofId}`,
      round, workbenchMode: target.workbenchMode,
    })
  }
  return evaluateCdp(cdp, `(async () => {
    const requests = ${JSON.stringify(requests)};
    const harness = window.__READY_AGENT_TEST__;
    const results = [];
    for (const request of requests) {
      const summary = harness.sessionSummary();
      const session = summary.sessions.find((item) => item.conversationId === request.aliasId);
      if (!session) return [{ ok: false, stage: 'session_missing', label: request.label, round: request.round }];
      const activated = await harness.activateSession(session.id);
      if (!activated.ok) return [{ ok: false, stage: 'activate', label: request.label, round: request.round }];
      const mode = await harness.setWorkbenchMode(request.workbenchMode);
      if (!mode.ok) return [{ ok: false, stage: 'workbench_mode', label: request.label, round: request.round }];
      const before = await window.electronAPI.agent.readCodexActionSurface({
        aliasId: request.aliasId, aliasGeneration: request.generation,
        workbenchMode: request.workbenchMode,
      });
      if (!before.success || before.data?.head?.actions?.send_new_message?.availability !== 'ready') {
        return [{ ok: false, stage: 'surface_before', label: request.label, round: request.round,
          availability: before.data?.head?.actions?.send_new_message?.availability,
          blockers: before.data?.head?.actions?.send_new_message?.blockers || [] }];
      }
      let rendererReady = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const renderer = await harness.snapshot();
        const input = document.querySelector('textarea[data-ready-agent-input="true"]');
        const button = document.querySelector('[data-ready-agent-send="true"]');
        if (renderer.currentScopeId === request.aliasId && input && !input.disabled && button
          && !button.hasAttribute('data-ready-agent-send-blocked')) {
          rendererReady = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!rendererReady) {
        return [{ ok: false, stage: 'renderer_surface_before', label: request.label, round: request.round }];
      }
      const sent = await harness.submit(request.marker, {
        mode: 'store', awaitStoreSend: true, waitForIdle: true,
        timeoutMs: 180000, attachments: [], requireAssistantMessage: true,
      });
      if (sent.sendResult?.disposition !== 'terminal_success') {
        return [{
          ok: false, stage: 'send_rejected', label: request.label, round: request.round,
          disposition: sent.sendResult?.disposition || null,
          errorKind: sent.sendResult?.errorKind || null,
          error: sent.sendResult?.error || null,
          expectedAliasGeneration: request.generation,
          currentScopeId: sent.after.currentScopeId,
          diagnosticIds: sent.diagnostics.map((item) => item.id),
        }];
      }
      const after = await window.electronAPI.agent.readCodexActionSurface({
        aliasId: request.aliasId, aliasGeneration: request.generation,
        workbenchMode: request.workbenchMode,
      });
      const visibleUser = sent.after.messages.some((message) => (
        message.type === 'user' && message.content.trim() === request.marker
      ));
      const expectedAnswer = 'READY_HISTORY_OK_' + request.label + '_R' + request.round;
      const visibleAnswer = [...sent.after.messages].reverse().find((message) => (
        message.type === 'agent' && message.content.includes(expectedAnswer)
      ));
      results.push({
        ok: sent.inputMode === 'store'
          && sent.sendResult?.disposition === 'terminal_success'
          && visibleUser && visibleAnswer?.terminalReason === 'done'
          && after.success
          && after.data?.head?.actions?.send_new_message?.availability === 'ready',
        label: request.label, round: request.round, inputMode: sent.inputMode,
        terminalReason: visibleAnswer?.terminalReason || null,
        visibleUser, visibleAnswer: Boolean(visibleAnswer),
        diagnosticIds: sent.diagnostics.map((item) => item.id),
        nextAvailability: after.data?.head?.actions?.send_new_message?.availability || null,
        generation: after.data?.head?.actionProjectionVersion?.headGeneration || null,
      });
    }
    return results;
  })()`, Math.max(180_000, requests.length * 30_000))
}

function assertRoundResults(results, targets, rounds) {
  const expected = targets.length * rounds.length
  if (!Array.isArray(results) || results.length !== expected
    || results.some((result) => !result.ok || result.terminalReason !== 'done'
      || result.nextAvailability !== 'ready')) {
    throw new Error(`installed same-thread round failed: ${JSON.stringify(results)}`)
  }
}

async function beginBoundaryAndSend(cdp, target) {
  return evaluateCdp(cdp, `(async () => {
    const target = ${JSON.stringify(target)};
    const marker = 'READY_HISTORY_' + target.label + '_R1_' + ${JSON.stringify(proofId)};
    const harness = window.__READY_AGENT_TEST__;
    const session = harness.sessionSummary().sessions.find((item) => item.conversationId === target.aliasId);
    if (!session) return { ok: false, stage: 'session_missing' };
    const activated = await harness.activateSession(session.id);
    if (!activated.ok) return { ok: false, stage: 'activate' };
    const mode = await harness.setWorkbenchMode(target.workbenchMode);
    if (!mode.ok) return { ok: false, stage: 'workbench_mode' };
    let beforeSurface = null;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const read = await window.electronAPI.agent.readCodexActionSurface({
        aliasId: target.aliasId, aliasGeneration: target.originalGeneration,
        workbenchMode: target.workbenchMode,
      });
      if (read.success && read.data?.state === target.expectedState) { beforeSurface = read.data; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let input = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const renderer = await harness.snapshot();
      input = document.querySelector('textarea[data-ready-agent-input="true"]');
      if (renderer.currentScopeId === target.aliasId && input && !input.disabled) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!input || input.disabled) {
      return {
        ok: false, stage: 'history_only_surface', beforeSurface: beforeSurface?.state || null,
        beginNewContext: Boolean(beforeSurface?.beginNewContext), input: Boolean(input),
        inputDisabled: Boolean(input?.disabled),
        currentScopeId: (await harness.snapshot()).currentScopeId,
      };
    }
    const visibleMessagesBefore = (await harness.snapshot()).messages.length;
    let button = document.querySelector('[data-ready-begin-new-context="true"] button');
    if (!beforeSurface?.beginNewContext || !button) {
      return { ok: false, stage: 'history_only_recovery_missing' };
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, marker);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (!button) return { ok: false, stage: 'recovery_button_missing' };
    button.click();
    let afterSurface = null;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const scopes = await window.electronAPI.agent.listConversationScopes();
      const scope = scopes.data?.find((item) => item.id === target.aliasId);
      const generation = scope?.aliasGeneration;
      if (Number.isSafeInteger(generation) && generation > target.originalGeneration) {
        const read = await window.electronAPI.agent.readCodexActionSurface({
          aliasId: target.aliasId, aliasGeneration: generation,
          workbenchMode: target.workbenchMode,
        });
        if (read.success && read.data?.state === 'active_head') { afterSurface = read.data; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const operationId = afterSurface?.contextBoundaries?.at(-1)?.operationId || null;
    let boundaryVisible = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      boundaryVisible = operationId && Boolean(document.querySelector(
        '[data-ready-context-boundary="' + CSS.escape(operationId) + '"]',
      ));
      if (boundaryVisible) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!boundaryVisible) return { ok: false, stage: 'committed_boundary_not_rendered', label: target.label };
    const afterBoundarySnapshot = await harness.snapshot();
    const draftPreserved = afterBoundarySnapshot.composer.inputValue.startsWith(marker);
    const sent = await harness.submit(marker, {
      mode: 'store', awaitStoreSend: true, waitForIdle: true,
      timeoutMs: 180000, attachments: [], requireAssistantMessage: true,
    });
    const expectedAnswer = 'READY_HISTORY_OK_' + target.label + '_R1';
    const visibleAnswer = [...sent.after.messages].reverse().find((message) => (
      message.type === 'agent' && message.content.includes(expectedAnswer)
    ));
    return {
      ok: sent.inputMode === 'store' && sent.sendResult?.disposition === 'terminal_success'
        && visibleAnswer?.terminalReason === 'done',
      sourceState: beforeSurface?.state || null, operationId,
      actionRef: beforeSurface.beginNewContext,
      draftPreserved, boundaryVisible, visibleMessagesBefore,
      visibleMessagesAfterBoundary: afterBoundarySnapshot.messages.length,
    };
  })()`, 600_000)
}

async function verifyBoundaryAfterRestart(cdp, target, operationId, actionRef) {
  return evaluateCdp(cdp, `(async () => {
    const target = ${JSON.stringify(target)};
    const expectedOperationId = ${JSON.stringify(operationId)};
    const marker = 'READY_HISTORY_' + target.label + '_R2_' + ${JSON.stringify(proofId)};
    const harness = window.__READY_AGENT_TEST__;
    const session = harness.sessionSummary().sessions.find((item) => item.conversationId === target.aliasId);
    if (!session) return { ok: false, stage: 'session_missing' };
    const activated = await harness.activateSession(session.id);
    if (!activated.ok) return { ok: false, stage: 'activate' };
    const mode = await harness.setWorkbenchMode(target.workbenchMode);
    if (!mode.ok) return { ok: false, stage: 'workbench_mode' };
    let surface = null;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const scopes = await window.electronAPI.agent.listConversationScopes();
      const scope = scopes.data?.find((item) => item.id === target.aliasId);
      if (Number.isSafeInteger(scope?.aliasGeneration)) {
        const read = await window.electronAPI.agent.readCodexActionSurface({
          aliasId: target.aliasId, aliasGeneration: scope.aliasGeneration,
          workbenchMode: target.workbenchMode,
        });
        if (read.success) { surface = read.data; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const operation = surface?.contextBoundaries?.find((item) => item.operationId === expectedOperationId);
    const replay = await window.electronAPI.agent.beginNewContext({ actionRef: ${JSON.stringify(actionRef)} });
    if (!operation || replay.boundary.receiptDigest !== operation.receiptDigest
      || replay.aliasGeneration !== surface.sourceAliasGeneration
      || replay.actionSurfaceInvalidation.aliasGeneration !== replay.aliasGeneration) {
      return { ok: false, stage: 'committed_recovery_replay_changed_identity' };
    }
    let boundaryVisible = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      boundaryVisible = Boolean(document.querySelector(
        '[data-ready-context-boundary="' + CSS.escape(expectedOperationId) + '"]',
      ));
      if (boundaryVisible) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const sent = await harness.submit(marker, {
      mode: 'store', awaitStoreSend: true, waitForIdle: true,
      timeoutMs: 180000, attachments: [], requireAssistantMessage: true,
    });
    const expectedAnswer = 'READY_HISTORY_OK_' + target.label + '_R2';
    const visibleAnswer = [...sent.after.messages].reverse().find((message) => (
      message.type === 'agent' && message.content.includes(expectedAnswer)
    ));
    return {
      ok: Boolean(operation) && sent.inputMode === 'store'
        && sent.sendResult?.disposition === 'terminal_success'
        && visibleAnswer?.terminalReason === 'done',
      operationId: operation?.operationId || null, boundaryVisible, committedReplayVerified: true,
    };
  })()`, 240_000)
}


async function readAttachedRecallContexts(cdp, scopeId) {
  const result = await evaluateCdp(cdp, `(async () => {
    const api = window.electronAPI?.agent?.listAttachedSessionRecallContexts;
    if (!api) return { missing: true };
    return api(${JSON.stringify(scopeId)});
  })()`, 120_000)
  if (result && result.missing) throw new Error('listAttachedSessionRecallContexts IPC unavailable')
  if (Array.isArray(result)) return result
  return Array.isArray(result?.data) ? result.data : []
}

async function activateTarget(cdp, aliasId) {
  return evaluateCdp(cdp, `(async () => {
    const aliasId = ${JSON.stringify(aliasId)};
    const harness = window.__READY_AGENT_TEST__;
    const session = harness.sessionSummary().sessions.find((item) => item.conversationId === aliasId);
    if (!session) return { ok: false, currentScopeId: null };
    const activated = await harness.activateSession(session.id);
    // The renderer is what a screenshot records, so the identity has to be
    // read back from the renderer rather than assumed from the activate call.
    let currentScopeId = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      currentScopeId = (await harness.snapshot()).currentScopeId;
      if (currentScopeId === aliasId) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ok: Boolean(activated.ok), currentScopeId };
  })()`, 60_000)
}

function verifyDatabaseContinuity(sourceTargetsValue, started, boundaries) {
  const rows = sqliteJson(databasePath, `
    SELECT ready_conversation_alias AS alias_id, alias_generation, codex_thread_id
      FROM codex_thread_bindings WHERE retired_at IS NULL;
  `)
  const current = new Map(rows.map((row) => [row.alias_id, row]))
  let sameThreadMatches = 0
  for (const target of started) {
    const row = current.get(target.aliasId)
    if (row?.codex_thread_id === target.originalThreadId
      && Number(row.alias_generation) === target.originalGeneration) sameThreadMatches += 1
  }
  if (sameThreadMatches !== started.length) throw new Error('installed proof changed a continued native thread')
  for (const boundary of boundaries) {
    const boundaryRow = current.get(boundary.aliasId)
    if (!boundaryRow?.codex_thread_id
      || Number(boundaryRow.alias_generation) <= boundary.originalGeneration) {
      throw new Error(`installed recovery did not create a new native context for ${boundary.label}`)
    }
  }
  return { sameThreadMatches, classifiedHeads: sourceTargetsValue.length }
}

function assertProviderCaptures(captures, started, boundaries, pristine, freshRootProof) {
  // Provider attempts consume the frozen gateway retry budget of one failed turn.
  const freshAttempts = assertFreshRootProviderCaptures(captures, freshRootProof)
  const expected = started.length * 3 + boundaries.length * 2 + pristine.length * 2 + freshAttempts
  if (captures.length !== expected || captures.some((capture) => capture.currentMarkerCount !== 1)) {
    throw new Error(`fixture capture count or current input identity mismatch: ${JSON.stringify(captures)}`)
  }
  for (const target of started) {
    const rows = captures.filter((capture) => capture.label === target.label)
    if (rows.length !== 3 || !rows.find((row) => row.round === 1)?.hasPriorContext
      || rows.find((row) => row.round === 2)?.priorMarkerCounts[`${target.label}:R1`] !== 1
      || rows.find((row) => row.round === 3)?.priorMarkerCounts[`${target.label}:R1`] !== 1
      || rows.find((row) => row.round === 3)?.priorMarkerCounts[`${target.label}:R2`] !== 1) {
      throw new Error(`fixture did not observe exact continued context for ${target.label}`)
    }
  }
  for (const target of pristine) {
    const first = captures.find((item) => item.label === target.label && item.round === 1)
    const second = captures.find((item) => item.label === target.label && item.round === 2)
    if (first?.userMessageCount !== 1 || second?.priorMarkerCounts[`${target.label}:R1`] !== 1) {
      throw new Error(`pristine root provider continuity missing: ${target.label}`)
    }
  }
  for (const boundary of boundaries) {
    const boundaryOne = captures.find((capture) => capture.label === boundary.label && capture.round === 1)
    const boundaryTwo = captures.find((capture) => capture.label === boundary.label && capture.round === 2)
    if (boundaryOne?.userMessageCount !== 1 || boundaryOne.assistantMessageCount !== 0
      || boundaryOne.priorWitnessMatchCount !== 0
      || boundaryTwo?.priorMarkerCounts[`${boundary.label}:R1`] !== 1
      || boundaryTwo.priorWitnessMatchCount !== 0) {
      throw new Error(`fixture observed old context across explicit boundary ${boundary.label}`)
    }
    // The boundary must also hold on the non-input surfaces: no retired marker may
    // reappear through developer instructions or the registered tool surface.
    for (const capture of [boundaryOne, boundaryTwo]) {
      if (capture.nonInputMarkerHits?.length || capture.contaminationHits?.length) {
        throw new Error(
          `fixture observed old context outside input across boundary ${boundary.label}: `
          + JSON.stringify({
            nonInput: capture.nonInputMarkerHits,
            contamination: capture.contaminationHits,
          }),
        )
      }
    }
  }
}

async function captureScreenshot(cdp, targetPath, selector, expectedText) {
  const frame = await evaluateCdp(cdp, `(async () => {
    const targets = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .filter((node) => node.textContent?.trim() === ${JSON.stringify(expectedText)});
    if (targets.length !== 1) throw new Error('screenshot anchor missing or ambiguous');
    const target = targets[0];
    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = target.getBoundingClientRect();
    const scroll = target.closest('[data-liquid-scroll-root="chat-messages"]').getBoundingClientRect();
    const input = document.querySelector('textarea[data-ready-agent-input="true"]').getBoundingClientRect();
    if (!target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      || rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.right > innerWidth
      || rect.top < Math.max(0, scroll.top) || rect.bottom > Math.min(innerHeight, scroll.bottom, input.top)) {
      throw new Error('screenshot anchor is outside the unobscured viewport');
    }
    return { anchorText: ${JSON.stringify(expectedText)}, left: rect.left, top: rect.top,
      width: rect.width, height: rect.height, inUnobscuredViewport: true };
  })()`)
  await runCdpCommand(cdp, 'Page.enable')
  const capture = await runCdpCommand(cdp, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(targetPath, Buffer.from(capture.data, 'base64'), { mode: 0o600 })
  return frame
}

async function startFixtureProvider(markerMap, contaminationMarkers = []) {
  const captures = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const input = Array.isArray(body.input) ? body.input : []
    const inputText = JSON.stringify(input)
    const found = [...markerMap.entries()].filter(([marker]) => inputText.includes(marker))
      .sort((left, right) => left[1].round - right[1].round)
    const current = found.at(-1)
    if (!current) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'history proof marker missing' } }))
      return
    }
    const [currentMarker, identity] = current
    const priorMarkerCounts = {}
    for (const [marker, candidate] of found) {
      if (marker === currentMarker) continue
      priorMarkerCounts[`${candidate.label}:R${candidate.round}`] = occurrences(inputText, marker)
    }
    const roles = input.flatMap((item) => item && typeof item === 'object' ? [item.role] : [])
    const providerWitnessDigests = new Set(input
      .filter((item) => item?.type === 'message' && item.role === 'user'
        && Array.isArray(item.content))
      .map(messageWitnessDigest))
    const priorWitnessMatchCount = identity.priorWitnessDigests.filter(
      (digest) => providerWitnessDigests.has(digest),
    ).length
    // Boundary contamination is not only about old message bodies: an old
    // reference skill, an auto-recall payload or a retired tool definition would
    // reach the model through `instructions` / `tools`, never through `input`.
    const instructionsText = typeof body.instructions === 'string' ? body.instructions : ''
    const toolNames = (Array.isArray(body.tools) ? body.tools : [])
      .map((tool) => (tool && typeof tool === 'object' ? String(tool.name || '') : ''))
      .filter((name) => name.length > 0)
      .sort()
    const nonInputMarkerHits = [...markerMap.keys()]
      .filter((marker) => marker !== currentMarker
        && (instructionsText.includes(marker) || toolNames.some((name) => name.includes(marker))))
    // Planted reference-skill / recall markers must not reappear anywhere in the
    // request: not in instructions, tool names, or any other part of the body.
    const wholeBody = JSON.stringify(body)
    const contaminationHits = contaminationMarkers.filter((marker) => wholeBody.includes(marker))
    captures.push({
      label: identity.label,
      round: identity.round,
      kind: identity.kind,
      inputDigest: sha256(inputText),
      instructionsDigest: sha256(instructionsText),
      instructionsLength: instructionsText.length,
      toolNames,
      nonInputMarkerHits,
      contaminationHits,
      inputItemCount: input.length,
      currentMarkerCount: occurrences(inputText, currentMarker),
      priorMarkerCounts,
      userMessageCount: roles.filter((role) => role === 'user').length,
      assistantMessageCount: roles.filter((role) => role === 'assistant').length,
      priorWitnessMatchCount,
      hasPriorContext: identity.kind === 'same_thread' && priorWitnessMatchCount > 0,
    })
    // The fresh-root scenario needs a REAL failed turn: the engine records a
    // native terminal for a turn Ready never publishes, which is what forces
    // publication divergence in the closeout. A provider failure mid-turn is
    // that shape, and it is an ordinary production failure rather than a
    // synthesized one. Only the first turn of that conversation fails; the
    // recovery turn that carries its tail is answered normally.
    if (identity.kind === 'fresh_root_failure') {
      captures[captures.length - 1].stage = 'provider_failure_injected'
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'fresh-root divergence: injected provider failure' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(messageEvents(
      `READY_HISTORY_OK_${identity.label}_R${identity.round}`,
      String(body.model || ''),
    ))
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    captures,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

function occurrences(value, needle) {
  return value.split(needle).length - 1
}

function messageEvents(text, model) {
  const identity = randomBytes(8).toString('hex')
  const item = {
    type: 'message', id: `message-${identity}`, role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text }],
  }
  const responseId = `response-${identity}`
  const usage = {
    input_tokens: 20, output_tokens: 10, total_tokens: 30,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
  const events = [
    { type: 'response.created', response: { id: responseId, model, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: text },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: responseId, model, status: 'completed', output: [item], usage } },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}
