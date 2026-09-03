#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import {
  closeChildProcess,
  enableAgentPanelHarness,
  evaluateCdp,
  normalizeHandshake,
  openCdp,
  runCdpCommand,
  sha256File,
  sqlQuote,
  sqliteJson,
  waitForCondition,
} from './codex-runtime/live-proof-runtime.mjs'

const require = createRequire(import.meta.url)
const { loadVerifiedStructuralReceipt } = require('./release-package-identity.cjs')
const root = resolve(process.cwd())
const packageIdentity = loadVerifiedStructuralReceipt(root)
if (!packageIdentity.ok || !packageIdentity.receipt) {
  throw new Error(`structural package receipt unavailable: ${(packageIdentity.errors || []).join('; ')}`)
}
const receipt = packageIdentity.receipt
const dmgPath = resolve(root, receipt.artifact.path)
const proofId = randomBytes(16).toString('hex')
const runRoot = resolve(root, 'outputs/codex-artifact-delivery-installed', receipt.artifact.sha256, proofId)
const profilePath = resolve(runRoot, 'profile')
const tempPath = resolve(runRoot, 'tmp')
const databasePath = resolve(profilePath, 'ready.db')
const targetRoot = resolve(runRoot, 'target')
const ambientTargetRoot = resolve(runRoot, 'ambient-target')
const secondTargetRoot = resolve(runRoot, 'target-two')
const reportPath = resolve(runRoot, 'installed-proof.json')
const mountPoint = mkdtempSync(join(tmpdir(), 'ready-artifact-proof-dmg-'))
const proofNonce = randomBytes(24).toString('hex')
const fixtureCredential = `ready-local-fixture-${proofId}`
const fixtureModel = 'ready-artifact-proof-model'
const expectedContent = `READY_INSTALLED_ARTIFACT_${proofId}\n${'长参数已完整通过。'.repeat(900)}\n`
const expectedSha256 = sha256(expectedContent)
const expectedAmbientContent = `READY_AMBIENT_DOCUMENT_EXCLUDED_${proofId}\n只使用公开网络资料，未读取当前本地文档。\n`
const expectedAmbientSha256 = sha256(expectedAmbientContent)

mkdirSync(profilePath, { recursive: true })
mkdirSync(tempPath, { recursive: true })
mkdirSync(targetRoot, { recursive: true })
mkdirSync(ambientTargetRoot, { recursive: true })
mkdirSync(secondTargetRoot, { recursive: true })

const fixture = await startFixtureProvider()
seedIsolatedProvider(fixture.baseUrl)

let mounted = false
let active = null
const launches = []
const scenarios = []
try {
  execFileSync('/usr/bin/hdiutil', [
    'attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  mounted = true
  const appPath = resolve(mountPoint, 'Ready.app')
  const executablePath = realpathSync(resolve(appPath, 'Contents/MacOS/Ready'))
  if (!existsSync(executablePath)) throw new Error('mounted Ready executable missing')

  active = await launchInstalledApp(executablePath, 9510 + Number.parseInt(proofId.slice(0, 3), 16) % 300)
  launches.push(active.capture)

  scenarios.push(await runScenario(active.cdp, {
    id: 'A-E',
    prompt: `READY_PROOF_LONG_WRITE_${proofId}：请把长文写成 report.md 并保存到所附文件夹。`,
    attachments: [{ path: targetRoot, name: basename(targetRoot), isDirectory: true }],
    timeoutMs: 240_000,
  }))
  assertScenario(scenarios.at(-1), 'A-E')
  const targetPath = resolve(targetRoot, 'report.md')
  if (!existsSync(targetPath) || sha256File(targetPath) !== expectedSha256) {
    throw new Error('A-E target readback mismatch')
  }

  scenarios.push(await runScenario(active.cdp, {
    id: 'Z',
    prompt: `READY_PROOF_AMBIENT_DOC_EXCLUDED_${proofId}：不使用任何 skill，不查看任何本地文档，只使用公开网络资料，生成 ambient-report.md 并输出到所附文件夹。`,
    attachments: [{ path: ambientTargetRoot, name: basename(ambientTargetRoot), isDirectory: true }],
    documentFixture: {
      title: '与本轮无关的当前文档',
      content: `AMBIENT_LOCAL_DOCUMENT_SENTINEL_${proofId}\n这份文档不得被本轮读取。`,
    },
    timeoutMs: 240_000,
  }))
  assertScenario(scenarios.at(-1), 'Z')
  const ambientTargetPath = resolve(ambientTargetRoot, 'ambient-report.md')
  if (!existsSync(ambientTargetPath) || sha256File(ambientTargetPath) !== expectedAmbientSha256) {
    throw new Error('Z ambient-document exclusion target readback mismatch')
  }
  const ambientRequests = fixture.requests.filter((request) => request.scenario === 'ambient-document-exclusion')
  if (ambientRequests.length === 0) throw new Error('Z fixture request capture missing')
  const ambientScopeId = scenarios.at(-1)?.session?.currentScopeId
  if (!ambientScopeId) throw new Error('Z durable conversation identity missing')

  scenarios.push(await runScenario(active.cdp, {
    id: 'F',
    prompt: `READY_PROOF_NO_WRITE_${proofId}：只盘点所附文件夹，不要写入或导出任何文件。`,
    attachments: [{ path: targetRoot, name: basename(targetRoot), isDirectory: true }],
    timeoutMs: 120_000,
  }))
  assertScenario(scenarios.at(-1), 'F')

  scenarios.push(await runScenario(active.cdp, {
    id: 'H',
    prompt: `READY_PROOF_FAIL_BEFORE_WRITE_${proofId}：先调查，再生成 failure.md。`,
    attachments: [{ path: targetRoot, name: basename(targetRoot), isDirectory: true }],
    timeoutMs: 120_000,
  }))
  assertScenario(scenarios.at(-1), 'H', { expectFailure: true })
  if (existsSync(resolve(targetRoot, 'failure.md'))) throw new Error('H unexpectedly wrote failure.md')
  const failureScopeId = scenarios.at(-1)?.session?.currentScopeId
  if (!failureScopeId) throw new Error('H durable conversation identity missing')

  await captureScreenshot(active.cdp, resolve(runRoot, 'before-restart.png'))
  await stopInstalledApp(active)
  active = null

  active = await launchInstalledApp(executablePath, 9810 + Number.parseInt(proofId.slice(3, 6), 16) % 150)
  launches.push(active.capture)
  const restartEvidence = await readRestartEvidence(active.cdp, failureScopeId)
  const restartSnapshot = restartEvidence.snapshot
  const sessionSummary = restartEvidence.sessionSummary
  await captureScreenshot(active.cdp, resolve(runRoot, 'after-restart.png'))
  if (!existsSync(targetPath) || sha256File(targetPath) !== expectedSha256) {
    throw new Error('P target changed across restart')
  }
  if (existsSync(resolve(targetRoot, 'failure.md'))) throw new Error('P restored a file that H never wrote')

  scenarios.push(await runScenario(active.cdp, {
    id: 'Y',
    prompt: `READY_PROOF_MULTI_TARGET_${proofId}：请生成 choice.md，但我同时附了两个目标文件夹。`,
    attachments: [
      { path: targetRoot, name: basename(targetRoot), isDirectory: true },
      { path: secondTargetRoot, name: basename(secondTargetRoot), isDirectory: true },
    ],
    waitForIdle: false,
    awaitStoreSend: false,
    timeoutMs: 90_000,
  }))
  await waitForCondition(async () => {
    const snapshot = await evaluateCdp(active.cdp, 'window.__READY_AGENT_TEST__?.snapshot?.()')
    const pending = snapshot?.messages?.some((message) => (
      message.type === 'ask_user_questions' && message.askUserQuestionsStatus === 'pending'
    ))
    if (!pending) return false
    scenarios[scenarios.length - 1].after = snapshot
    return true
  }, { timeoutMs: 60_000, message: 'Y selection question did not appear' })
  await captureScreenshot(active.cdp, resolve(runRoot, 'scenario-Y.png'))
  if (existsSync(resolve(targetRoot, 'choice.md')) || existsSync(resolve(secondTargetRoot, 'choice.md'))) {
    throw new Error('Y wrote before destination selection')
  }
  const selectionCleanup = await evaluateCdp(active.cdp, `(async () => {
    const harness = window.__READY_AGENT_TEST__;
    const answer = await harness.answerPendingAskUserQuestions({ strategy: 'first' });
    if (!answer.success) return { answer };
    const after = await harness.waitForIdle({ timeoutMs: 60000, pollMs: 100 });
    return { answer, after };
  })()`, 70_000)
  if (!selectionCleanup?.answer?.success || selectionCleanup.after?.runtime?.isStreaming) {
    throw new Error(`Y selection cleanup failed: ${JSON.stringify(selectionCleanup)}`)
  }
  scenarios[scenarios.length - 1].selectionCleanup = selectionCleanup
  if (existsSync(resolve(targetRoot, 'choice.md')) || existsSync(resolve(secondTargetRoot, 'choice.md'))) {
    throw new Error('Y cleanup unexpectedly wrote choice.md')
  }

  await stopInstalledApp(active)
  active = null
  const databaseEvidence = collectDatabaseEvidence()
  assertDatabaseEvidence(databaseEvidence, ambientScopeId)
  const logEvidence = collectLogEvidence()
  const observedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    status: 'INSTALLED_ARTIFACT_DELIVERY_PASS',
    proofId,
    observedAt,
    receiptIdentity: {
      receiptId: receipt.receiptId,
      appVersion: receipt.appVersion,
      sourceTreeDigest: receipt.source.digest,
      runtimeManifestSha256: receipt.runtimeManifestSha256,
      packagePath: receipt.artifact.path,
      packageBytes: statSync(dmgPath).size,
      packageSha256: sha256File(dmgPath),
    },
    fixture: {
      kind: 'local-no-cost-openai-compatible',
      requestCount: fixture.requests.length,
      longArgumentDeltaCount: fixture.longArgumentDeltaCount,
      requestToolNames: fixture.requests.map((request) => request.toolNames),
    },
    launches,
    scenarios,
    restart: { snapshot: restartSnapshot, sessionSummary },
    target: {
      path: targetPath,
      bytes: statSync(targetPath).size,
      sha256: sha256File(targetPath),
      expectedSha256,
    },
    ambientDocumentExclusionTarget: {
      path: ambientTargetPath,
      bytes: statSync(ambientTargetPath).size,
      sha256: sha256File(ambientTargetPath),
      expectedSha256: expectedAmbientSha256,
      scopeId: ambientScopeId,
    },
    databaseEvidence,
    logEvidence,
    screenshots: [
      'scenario-A-E.png', 'scenario-Z.png', 'scenario-F.png', 'scenario-H.png',
      'before-restart.png', 'after-restart.png', 'scenario-Y.png',
    ],
    installedScenarioCoverage: ['A', 'E-without-skill', 'F', 'H', 'P', 'S', 'Y', 'ambient-current-document-exclusion'],
    sourceGateCoverageOnly: ['B', 'C', 'D', 'E-with-skill', 'G', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'Q', 'R', 'T', 'U', 'V', 'W', 'X'],
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ ok: true, reportPath, packageSha256: report.receiptIdentity.packageSha256 }, null, 2)}\n`)
} finally {
  if (active) await stopInstalledApp(active).catch(() => {})
  await fixture.close()
  if (mounted) {
    detachMountedImage(mountPoint)
  }
  rmSync(mountPoint, { recursive: true, force: true })
}

function detachMountedImage(path) {
  try {
    execFileSync('/usr/bin/hdiutil', ['detach', path, '-quiet'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    execFileSync('/usr/bin/hdiutil', ['detach', path, '-force', '-quiet'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
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
    activeProfileId: 'artifact-proof',
    profiles: [{
      id: 'artifact-proof', category: 'custom', name: 'Artifact proof', builtIn: false,
      showInChatSwitcher: true, config,
    }],
  }
  const now = new Date().toISOString()
  const rows = {
    ai_provider_workspace: workspace,
    ai_model_config: config,
    ai_saved_configs: { 'openai-compatible': config, 'artifact-proof': config },
  }
  const values = Object.entries(rows).map(([key, value]) => (
    `(${sqlQuote(key)}, ${sqlQuote(JSON.stringify(value))}, ${sqlQuote(now)})`
  )).join(',')
  execFileSync('/usr/bin/sqlite3', [databasePath, `
    PRAGMA journal_mode=DELETE;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO settings (key, value, updated_at) VALUES ${values};
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
}

async function launchInstalledApp(executablePath, remotePort) {
  const logs = []
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
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  let cdp = await openCdp(remotePort, { timeoutMs: 90_000 })
  const rawHandshake = await evaluateCdp(
    cdp,
    `window.electronAPI.app.browserLiveProofHandshake(${JSON.stringify(proofNonce)})`,
  )
  if (!rawHandshake?.success
    || rawHandshake.proofNonce !== proofNonce
    || rawHandshake.execSha256 !== receipt.verification.appExecutableSha256
    || rawHandshake.asarSha256 !== receipt.verification.appAsarSha256
    || rawHandshake.sourceManifestDigest !== receipt.verification.browserSourceManifestDigest
    || rawHandshake.userDataPath !== profilePath
    || rawHandshake.databasePath !== databasePath) {
    throw new Error(`installed package handshake mismatch: ${JSON.stringify(normalizeHandshake(rawHandshake))}`)
  }
  cdp = await enableAgentPanelHarness(cdp, remotePort)
  return {
    child,
    cdp,
    logs,
    capture: {
      kind: 'ready-packaged-live-proof-v1',
      success: true,
      proofNonce,
      pid: child.pid,
      bootIncarnationId: rawHandshake.bootIncarnationId,
      execSha256: rawHandshake.execSha256,
      asarSha256: rawHandshake.asarSha256,
      sourceManifestDigest: rawHandshake.sourceManifestDigest,
      appVersion: receipt.appVersion,
      packageSha256: receipt.artifact.sha256,
      receiptId: receipt.receiptId,
      userDataPath: rawHandshake.userDataPath,
      databasePath: rawHandshake.databasePath,
    },
  }
}

async function stopInstalledApp(runtime) {
  try {
    await evaluateCdp(
      runtime.cdp,
      `window.electronAPI.app.browserLiveProofQuit(${JSON.stringify(proofNonce)})`,
      5_000,
    )
  } catch {}
  runtime.cdp.close()
  await closeChildProcess(runtime.child, { gracefulSignal: 'SIGTERM', timeoutMs: 30_000 })
}

async function readRestartEvidence(cdp, scopeId) {
  return waitForCondition(async () => {
    const evidence = await evaluateCdp(cdp, `(async () => {
      const harness = window.__READY_AGENT_TEST__;
      if (!harness?.snapshot || !harness?.sessionSummary || !harness?.activateSession) return null;
      const summary = harness.sessionSummary();
      const session = summary.sessions.find((candidate) =>
        candidate.conversationId === ${JSON.stringify(scopeId)});
      if (!session) return null;
      const activation = await harness.activateSession(session.id);
      if (!activation.ok) return null;
      const snapshot = activation.snapshot;
      const restoredUser = snapshot.messages.some((message) =>
        message.type === 'user' && message.content.includes('READY_PROOF_FAIL_BEFORE_WRITE_${proofId}'));
      const restoredFailure = snapshot.messages.some((message) =>
        message.type === 'agent' && /\u672a\u80fd\u5b8c\u6210|\u5931\u8d25|\u672a\u5199\u5165|\u4e2d\u65ad|\u9519\u8bef/.test(message.content || ''));
      const restoredMessageTrace = snapshot.toolTrace.filter((event) => event.source === 'messageMeta');
      if (snapshot.currentScopeId !== ${JSON.stringify(scopeId)}
        || !restoredUser
        || !restoredFailure
        || restoredMessageTrace.length !== 4) return null;
      return { snapshot, sessionSummary: harness.sessionSummary() };
    })()`, 5_000)
    return evidence || false
  }, {
    timeoutMs: 60_000,
    pollMs: 250,
    message: 'P closed failure history did not recover in the installed UI',
  })
}

async function runScenario(cdp, input) {
  const expression = `(async () => {
    const harness = window.__READY_AGENT_TEST__;
    document.querySelector('button[title="展开聊天面板"]')?.click();
    ${input.documentFixture ? `
    const documentFixture = await harness.setDocumentFixture(${JSON.stringify(input.documentFixture)});
    if (!documentFixture.ok) return { ok: false, error: documentFixture.error, stage: 'set-document-fixture' };
    ` : ''}
    const created = await harness.createVisibleSession();
    if (!created.ok) return { ok: false, error: created.error, stage: 'create-session' };
    harness.clearEvents();
    const result = await harness.submit(${JSON.stringify(input.prompt)}, {
      mode: 'store',
      waitForIdle: ${input.waitForIdle !== false},
      awaitStoreSend: ${input.awaitStoreSend !== false},
      timeoutMs: ${input.timeoutMs},
      attachments: ${JSON.stringify(input.attachments || [])},
      requireAssistantMessage: true,
    });
    return { ...result, harnessEvents: harness.events(), session: harness.sessionSummary() };
  })()`
  const result = await evaluateCdp(cdp, expression, input.timeoutMs + 30_000)
  await captureScreenshot(cdp, resolve(runRoot, `scenario-${input.id}.png`))
  return { id: input.id, ...result }
}

function assertScenario(scenario, id, options = {}) {
  if (!scenario?.after?.messages?.some((message) => message.type === 'agent')) {
    throw new Error(`${id} missing visible assistant history: ${JSON.stringify(scenario)}`)
  }
  const failureVisible = scenario.after.messages.some((message) => (
    message.type === 'agent' && /未能完成|失败|未写入|中断|错误/.test(message.content || '')
  ))
  if (options.expectFailure ? !failureVisible : scenario.ok !== true) {
    throw new Error(`${id} visible outcome mismatch: ${JSON.stringify(scenario)}`)
  }
}

async function captureScreenshot(cdp, targetPath) {
  await runCdpCommand(cdp, 'Page.enable')
  const capture = await runCdpCommand(cdp, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(targetPath, Buffer.from(capture.data, 'base64'), { mode: 0o600 })
}

function collectDatabaseEvidence() {
  if (existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-journal`)) {
    throw new Error('installed proof database was not cleanly closed')
  }
  const evidenceDatabasePath = `${pathToFileURL(databasePath).href}?immutable=1`
  return {
    integrity: sqliteJson(evidenceDatabasePath, 'PRAGMA integrity_check;'),
    runs: sqliteJson(evidenceDatabasePath, `
      SELECT run_id, scope_id, status, terminal_reason
        FROM run_meta ORDER BY created_at ASC;
    `),
    messages: sqliteJson(evidenceDatabasePath, `
      SELECT conversation_id, role, COUNT(*) AS count
        FROM chat_messages GROUP BY conversation_id, role ORDER BY conversation_id, role;
    `),
    toolActions: sqliteJson(evidenceDatabasePath, `
      SELECT binding.tool_name, action.state, COUNT(*) AS count
        FROM codex_tool_call_bindings binding
        JOIN ready_tool_action_receipts action ON action.ready_action_id = binding.ready_action_id
       GROUP BY binding.tool_name, action.state ORDER BY binding.tool_name, action.state;
    `),
    toolActionsByRun: sqliteJson(evidenceDatabasePath, `
      SELECT binding.ready_run_id, binding.tool_name, action.state
        FROM codex_tool_call_bindings binding
        JOIN ready_tool_action_receipts action ON action.ready_action_id = binding.ready_action_id
       ORDER BY binding.ready_run_id, binding.created_at;
    `),
    missingCanonical: sqliteJson(evidenceDatabasePath, `
      SELECT run.run_id
        FROM run_meta run
       WHERE run.status IN ('done', 'error', 'cancelled', 'interrupted')
         AND NOT EXISTS (
           SELECT 1 FROM chat_messages message
            WHERE message.conversation_id = run.scope_id AND message.role = 'assistant'
              AND json_extract(message.meta_json, '$.runId') = run.run_id
         );
    `),
  }
}

function assertDatabaseEvidence(evidence, ambientScopeId) {
  if (evidence.integrity?.[0]?.integrity_check !== 'ok') throw new Error('installed database integrity failed')
  if (evidence.missingCanonical.length > 0) {
    throw new Error(`terminal runs missing canonical messages: ${JSON.stringify(evidence.missingCanonical)}`)
  }
  const confirmed = new Map(evidence.toolActions.map((row) => [`${row.tool_name}:${row.state}`, Number(row.count)]))
  for (const toolName of ['skill_write_artifact', 'skill_export_artifact']) {
    if (confirmed.get(`${toolName}:confirmed`) !== 2) {
      throw new Error(`${toolName} confirmed count must be exactly two`)
    }
  }
  const ambientRuns = evidence.runs.filter((run) => run.scope_id === ambientScopeId)
  if (ambientRuns.length !== 1
    || ambientRuns[0].status !== 'done'
    || ambientRuns[0].terminal_reason !== 'done') {
    throw new Error(`ambient-document exclusion run did not close as done: ${JSON.stringify(ambientRuns)}`)
  }
  const ambientActions = evidence.toolActionsByRun.filter((action) => (
    action.ready_run_id === ambientRuns[0].run_id
  ))
  if (ambientActions.some((action) => action.tool_name === 'document_read_section')) {
    throw new Error(`ambient document was read: ${JSON.stringify(ambientActions)}`)
  }
}

function collectLogEvidence() {
  const names = ['ready-directchat.log', 'ready-tools.log']
  return names.map((name) => {
    const path = resolve(tempPath, name)
    if (!existsSync(path)) return { name, missing: true }
    const bytes = readFileSync(path)
    return {
      name,
      bytes: bytes.length,
      sha256: sha256(bytes),
      tail: bytes.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-80),
    }
  })
}

async function startFixtureProvider() {
  const requests = []
  const stages = new Map()
  let longArgumentDeltaCount = 0
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request)
    const bodyText = JSON.stringify(body)
    const metadataText = body?.client_metadata?.['x-codex-turn-metadata']
    const metadata = typeof metadataText === 'string' ? JSON.parse(metadataText) : {}
    const readyRunId = String(metadata.readyRunId || '')
    const toolNames = Array.isArray(body.tools)
      ? body.tools.map((tool) => String(tool?.name || tool?.function?.name || '')).filter(Boolean)
      : []
    const scenario = bodyText.includes(`READY_PROOF_AMBIENT_DOC_EXCLUDED_${proofId}`)
      ? 'ambient-document-exclusion'
      : null
    requests.push({ readyRunId, path: request.url, toolNames, scenario })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const stage = stages.get(readyRunId) || 0
    if (bodyText.includes(`READY_PROOF_LONG_WRITE_${proofId}`)) {
      if (stage === 0) {
        stages.set(readyRunId, 1)
        return response.end(functionCallEvents('declare_completion_criteria', {
          criteria: ['report.md 已在目标文件夹完成哈希回读'],
          expected_outputs: ['report.md'],
          folder_output_intent: 'create',
        }, `declare-${readyRunId}`))
      }
      if (stage === 1) {
        stages.set(readyRunId, 2)
        const args = JSON.stringify({
          relativePath: 'report.md', content: expectedContent,
          mode: 'overwrite', expectedVersion: 'empty',
        })
        const chunks = [...args.slice(0, 5_000), args.slice(5_000)].filter(Boolean)
        longArgumentDeltaCount = chunks.length
        return response.end(functionCallEvents(
          'skill_write_artifact', JSON.parse(args), `write-${readyRunId}`, chunks,
        ))
      }
      if (stage === 2) {
        stages.set(readyRunId, 3)
        const versions = bodyText.match(/sha256:[a-f0-9]{64}/g) || []
        const destination = bodyText.match(/local-directory:[a-f0-9]{32}/)?.[0]
        if (!versions.length || !destination) throw new Error('write receipt not returned to fixture')
        return response.end(functionCallEvents('skill_export_artifact', {
          relativePath: 'report.md', targetRelativePath: 'report.md',
          destinationResourceId: destination,
          expectedVersion: versions.at(-1), expectedSha256,
        }, `export-${readyRunId}`))
      }
      return response.end(messageEvents('已完成 report.md 的暂存、导出和目标回读。', readyRunId))
    }
    if (bodyText.includes(`READY_PROOF_AMBIENT_DOC_EXCLUDED_${proofId}`)) {
      if (stage === 0) {
        stages.set(readyRunId, 1)
        return response.end(functionCallEvents('declare_completion_criteria', {
          criteria: ['ambient-report.md 已在目标文件夹完成哈希回读'],
          expected_outputs: ['ambient-report.md'],
          folder_output_intent: 'create',
        }, `ambient-declare-${readyRunId}`))
      }
      if (stage === 1) {
        stages.set(readyRunId, 2)
        return response.end(functionCallEvents('skill_write_artifact', {
          relativePath: 'ambient-report.md', content: expectedAmbientContent,
          mode: 'overwrite', expectedVersion: 'empty',
        }, `ambient-write-${readyRunId}`))
      }
      if (stage === 2) {
        stages.set(readyRunId, 3)
        const versions = bodyText.match(/sha256:[a-f0-9]{64}/g) || []
        const destination = bodyText.match(/local-directory:[a-f0-9]{32}/)?.[0]
        if (!versions.length || !destination) throw new Error('ambient write receipt not returned to fixture')
        return response.end(functionCallEvents('skill_export_artifact', {
          relativePath: 'ambient-report.md', targetRelativePath: 'ambient-report.md',
          destinationResourceId: destination,
          expectedVersion: versions.at(-1), expectedSha256: expectedAmbientSha256,
        }, `ambient-export-${readyRunId}`))
      }
      return response.end(messageEvents('已完成 ambient-report.md，未读取当前本地文档。', readyRunId))
    }
    if (bodyText.includes(`READY_PROOF_NO_WRITE_${proofId}`)) {
      if (stage === 0) {
        stages.set(readyRunId, 1)
        return response.end(functionCallEvents('declare_completion_criteria', {
          criteria: ['只盘点目录，不产生文件副作用'],
          expected_outputs: [], folder_output_intent: 'no_write',
        }, `no-write-${readyRunId}`))
      }
      return response.end(messageEvents('已完成只读盘点，没有写入或导出文件。', readyRunId))
    }
    if (bodyText.includes(`READY_PROOF_FAIL_BEFORE_WRITE_${proofId}`)) {
      if (stage === 0) {
        stages.set(readyRunId, 1)
        return response.end(functionCallEvents('declare_completion_criteria', {
          criteria: ['先完成调查，再将 failure.md 交付到目标文件夹'],
          expected_outputs: ['failure.md'],
          folder_output_intent: 'create',
        }, `failure-investigation-${readyRunId}`))
      }
      if (stage === 1) {
        stages.set(readyRunId, 2)
        return response.end(functionCallEvents('file_inventory', {
          rootPath: targetRoot,
          limit: 10,
          recursive: false,
          includeSummaries: false,
        }, `failure-inventory-${readyRunId}`))
      }
      return response.end(failureEvents('fixture_failure_before_writer', readyRunId))
    }
    if (bodyText.includes(`READY_PROOF_MULTI_TARGET_${proofId}`)) {
      if (stage > 0) return response.end(failureEvents('fixture_stop_after_destination_selection', readyRunId))
      stages.set(readyRunId, 1)
      return response.end(functionCallEvents('ask_user_questions', {
        questions: [{
          id: 'destination', question: '要写入哪一个目标文件夹？', kind: 'single_choice',
          options: ['第一个文件夹', '第二个文件夹'], required: true,
        }],
      }, `ask-${readyRunId}`))
    }
    response.end(messageEvents('本地验收服务未识别当前场景。', readyRunId || proofId))
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    get longArgumentDeltaCount() { return longArgumentDeltaCount },
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function usage() {
  return {
    input_tokens: 20, output_tokens: 10, total_tokens: 30,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

function functionCallEvents(name, args, identity, argumentChunks) {
  const argumentsValue = JSON.stringify(args)
  const item = {
    type: 'function_call', id: `item-${identity}`, call_id: `call-${identity}`,
    name, arguments: argumentsValue,
  }
  const chunks = argumentChunks || [argumentsValue]
  const responseId = `response-${identity}`
  const events = [
    { type: 'response.created', response: { id: responseId, model: fixtureModel, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
    ...chunks.map((delta) => ({
      type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta,
    })),
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: argumentsValue },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: responseId, model: fixtureModel, status: 'completed', output: [item], usage: usage() } },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function messageEvents(text, identity) {
  const item = {
    type: 'message', id: `message-${identity}-${randomBytes(4).toString('hex')}`,
    role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }],
  }
  const responseId = `response-${identity}-${randomBytes(4).toString('hex')}`
  return [
    { type: 'response.created', response: { id: responseId, model: fixtureModel, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: text },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: responseId, model: fixtureModel, status: 'completed', output: [item], usage: usage() } },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function failureEvents(code, identity) {
  const responseId = `response-${identity}`
  return [
    { type: 'response.created', response: { id: responseId, model: fixtureModel, status: 'in_progress', output: [] } },
    {
      type: 'response.failed',
      response: {
        id: responseId, model: fixtureModel, status: 'failed', output: [],
        error: { code, message: code, type: 'fixture_error', param: null }, usage: usage(),
      },
    },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}
