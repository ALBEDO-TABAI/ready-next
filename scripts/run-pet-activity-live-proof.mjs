#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

import {
  closeChildProcess,
  evaluateCdp,
  openCdp,
  sqlQuote,
  sqliteJson,
  waitForCondition,
} from './codex-runtime/live-proof-runtime.mjs'

const root = resolve(process.cwd())
const electronPath = resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const builtMainPath = resolve(root, 'out/main/index.js')
if (!existsSync(electronPath) || !existsSync(builtMainPath)) {
  throw new Error('run npm run build before pet live proof')
}

const proofId = randomBytes(10).toString('hex')
const proofNonce = randomBytes(24).toString('hex')
const proofRoot = resolve(root, 'outputs/ui-acceptance', `pet-activity-${proofId}`)
const profilePath = resolve(proofRoot, '.profile')
const tempPath = resolve(proofRoot, '.tmp')
const databasePath = resolve(profilePath, 'ready.db')
const reportPath = resolve(proofRoot, 'report.json')
mkdirSync(proofRoot, { recursive: true, mode: 0o700 })
mkdirSync(profilePath, { recursive: true, mode: 0o700 })
mkdirSync(tempPath, { recursive: true, mode: 0o700 })

let active = null
let launchOrdinal = 0
try {
  active = await launch()
  await waitForDatabase()
  await waitForAgentRuntime()
  const cutoverAt = scalar(`SELECT value FROM settings WHERE key = 'desktop_pet_activity_cutover_at'`)
  if (!cutoverAt) throw new Error('pet activity cutover missing after first boot')
  const oldAt = new Date(Date.parse(cutoverAt) - 86_400_000).toISOString()
  const runningAt = new Date(Math.max(Date.now(), Date.parse(cutoverAt) + 1_000)).toISOString()
  const idleAt = new Date(Date.parse(runningAt) + 3_600_000).toISOString()
  seedFixture({ oldAt, runningAt, idleAt })
  await evaluateCdp(active.cdp, `(async () => {
    await window.electronAPI.pet.updateSettings({ enabled: true });
    window.electronAPI.pet.scopeViewed('pet-proof-refresh');
    return true;
  })()`)
  await waitForCondition(
    () => Boolean(scalar(`SELECT pet_last_seen_at FROM chat_conversations WHERE id = 'pet-proof-refresh'`)),
    { timeoutMs: 5_000, pollMs: 100, message: 'scopeViewed did not persist the refresh marker' },
  )
  const running = await waitForActivity((activity) => activity.taskId === 'pet-proof-running')
  assertActivity(running, 'running', 'pet-proof-running')
  if (running.taskId === 'pet-proof-old-failure') {
    throw new Error('legacy failure crossed the durable activity cutover')
  }
  const failedAt = new Date(Date.now() + 1_000).toISOString()
  updateFixtureToFailed(failedAt)
  await refreshProjection(new Date(Date.parse(failedAt) + 1_000).toISOString())
  const blocked = await waitForActivity((activity) => activity.taskId === 'pet-proof-running')
  assertActivity(blocked, 'blocked', 'pet-proof-running')
  const blockedOpened = await openCurrentActivity()
  if (!blockedOpened?.success) throw new Error(`blocked activity did not open: ${JSON.stringify(blockedOpened)}`)
  const afterBlockedOpen = await waitForActivity((activity) => activity.taskId !== 'pet-proof-running')
  const failedMarker = scalar(`
    SELECT pet_last_seen_at FROM chat_conversations WHERE id = 'pet-proof-work'
  `)
  if (failedMarker !== failedAt) throw new Error('failed activity durable read marker mismatch')
  const completedAt = new Date(Date.parse(failedAt) + 2_000).toISOString()
  updateFixtureToCompleted(completedAt)
  await refreshProjection(new Date(Date.parse(completedAt) + 1_000).toISOString())
  const ready = await waitForActivity((activity) => activity.taskId === 'pet-proof-running')
  assertActivity(ready, 'ready', 'pet-proof-running')
  const readyOpened = await openCurrentActivity()
  if (!readyOpened?.success) throw new Error(`ready activity did not open: ${JSON.stringify(readyOpened)}`)
  const afterReadyOpen = await waitForActivity((activity) => activity.taskId !== 'pet-proof-running')
  const completedMarker = scalar(`
    SELECT pet_last_seen_at FROM chat_conversations WHERE id = 'pet-proof-work'
  `)
  if (completedMarker !== completedAt) throw new Error('completed activity durable read marker mismatch')

  const report = {
    schemaVersion: 1,
    status: 'PET_ACTIVITY_LIVE_PASS',
    observedAt: new Date().toISOString(),
    proofId,
    runtime: {
      kind: 'built-electron-isolated-profile',
      launches: launchOrdinal,
      databaseIsolated: true,
      networkRequests: 0,
    },
    cutoverAt,
    scenarios: {
      oldFailureWithNewRunning: running,
      newFailureBeforeOpen: blocked,
      newFailureAfterOpen: afterBlockedOpen,
      newCompletionBeforeOpen: ready,
      newCompletionAfterOpen: afterReadyOpen,
    },
    readback: { failedMarker, completedMarker },
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ ok: true, reportPath, report }, null, 2)}\n`)
} finally {
  if (active) await stop(active).catch(() => undefined)
  rmSync(profilePath, { recursive: true, force: true })
  rmSync(tempPath, { recursive: true, force: true })
}

async function launch() {
  launchOrdinal += 1
  const remotePort = 12_200 + Number.parseInt(proofId.slice(0, 3), 16) % 400 + launchOrdinal
  const child = spawn(electronPath, ['.', `--remote-debugging-port=${remotePort}`], {
    cwd: root,
    env: {
      ...process.env,
      TMPDIR: tempPath,
      READY_DB_PATH: databasePath,
      READY_BROWSER_LIVE_PROOF_NONCE: proofNonce,
      READY_REMOTE_DEBUGGING_PORT: String(remotePort),
      READY_USER_DATA_DIR: profilePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  try {
    const cdp = await openCdp(remotePort, { timeoutMs: 60_000 })
    await waitForRenderer(cdp)
    return { child, cdp, logs }
  } catch (error) {
    await closeChildProcess(child, { gracefulSignal: 'SIGTERM', timeoutMs: 10_000 })
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.slice(-50).join('')}`)
  }
}

async function waitForRenderer(cdp) {
  await waitForCondition(async () => {
    try {
      return await evaluateCdp(cdp, 'document.readyState === "complete" && Boolean(window.electronAPI?.pet)')
    } catch {
      return false
    }
  }, { timeoutMs: 30_000, pollMs: 200, message: 'Ready renderer did not bootstrap' })
}

async function stop(runtime) {
  try {
    await evaluateCdp(
      runtime.cdp,
      `window.electronAPI.app.browserLiveProofQuit(${JSON.stringify(proofNonce)})`,
      5_000,
    )
  } catch {
    // The bounded process close below remains the cleanup fallback.
  }
  runtime.cdp.close()
  await closeChildProcess(runtime.child, { timeoutMs: 15_000 })
}

async function waitForDatabase() {
  await waitForCondition(
    () => existsSync(databasePath)
      && scalar(`SELECT name FROM migrations WHERE name = '117_pet_activity_attention_cutover'`) === '117_pet_activity_attention_cutover',
    { timeoutMs: 30_000, pollMs: 250, message: 'pet activity migration did not apply' },
  )
}

async function waitForAgentRuntime() {
  let observation = null
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      observation = await evaluateCdp(
        active.cdp,
        'window.electronAPI.agent.readRuntimeReady()',
      )
      if (observation?.ready === true) return
    } catch (error) {
      observation = { error: error instanceof Error ? error.message : String(error) }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  throw new Error(`Ready agent runtime did not finish registration: ${JSON.stringify({
    observation,
    logs: active.logs.slice(-80),
  })}`)
}

async function waitForActivity(predicate) {
  let latest = null
  let observation = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      observation = await evaluateCdp(active.cdp, `(async () => ({
        href: location.href,
        result: await window.electronAPI.pet.getSnapshot(),
      }))()`)
      latest = observation?.result?.data?.activity || null
      if (latest && predicate(latest)) return latest
    } catch (error) {
      observation = { error: error instanceof Error ? error.message : String(error) }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  throw new Error(`pet activity mismatch: ${JSON.stringify({ latest, observation })}`)
}

async function openCurrentActivity() {
  return evaluateCdp(active.cdp, `(async () => {
    const snapshot = await window.electronAPI.pet.getSnapshot();
    return window.electronAPI.pet.openActivity(snapshot.data.activity);
  })()`)
}

async function refreshProjection(updatedAt) {
  executeSql(`
    UPDATE task_projections
       SET updated_at = ${sqlQuote(updatedAt)}
     WHERE task_id = 'pet-proof-refresh';
  `)
  await evaluateCdp(
    active.cdp,
    `window.electronAPI.pet.scopeViewed('pet-proof-refresh'); true`,
  )
}

function assertActivity(activity, kind, taskId) {
  if (activity?.kind !== kind || activity?.taskId !== taskId) {
    throw new Error(`unexpected pet activity: ${JSON.stringify(activity)}`)
  }
}

function scalar(sql) {
  const rows = sqliteJson(databasePath, sql)
  const row = rows[0]
  return row ? String(Object.values(row)[0] ?? '') : ''
}

function executeSql(sql) {
  execFileSync('/usr/bin/sqlite3', [databasePath, sql], { stdio: ['ignore', 'pipe', 'pipe'] })
}

function seedFixture({ oldAt, runningAt, idleAt }) {
  const settings = JSON.stringify({
    enabled: true,
    selectedPetId: 'white-chinchilla-cat',
    bubbleEnabled: true,
    alwaysOnTop: true,
    size: 'medium',
    windowBounds: null,
    customPetMeta: {},
  })
  executeSql(`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('desktop_pet_settings', ${sqlQuote(settings)}, ${sqlQuote(runningAt)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    INSERT INTO chat_conversations
      (id, agent, title, created_at, updated_at, source_kind, source_id, thread_key, user_id)
    VALUES
      ('pet-proof-old', 'butler', 'old', ${sqlQuote(oldAt)}, ${sqlQuote(oldAt)}, 'local', 'pet-proof', 'old', 'default-user'),
      ('pet-proof-work', 'butler', 'work', ${sqlQuote(runningAt)}, ${sqlQuote(runningAt)}, 'local', 'pet-proof', 'work', 'default-user'),
      ('pet-proof-idle', 'butler', 'idle', ${sqlQuote(idleAt)}, ${sqlQuote(idleAt)}, 'local', 'pet-proof', 'idle', 'default-user'),
      ('pet-proof-refresh', 'butler', 'refresh', ${sqlQuote(runningAt)}, ${sqlQuote(runningAt)}, 'local', 'pet-proof', 'refresh', 'default-user');
    INSERT INTO chat_messages
      (id, conversation_id, role, content, timestamp, message_visibility_epoch)
    VALUES ('pet-proof-refresh-message', 'pet-proof-refresh', 'assistant', 'refresh', ${sqlQuote(runningAt)}, 0);
    INSERT INTO task_projections
      (task_id, scope_id, run_id, task_type, module, task_title, task_summary, status,
       interaction_state, waiting_for, steps_json, task_origin, created_at, updated_at)
    VALUES
      ('pet-proof-old-failure', 'pet-proof-old', 'pet-proof-old-run', 'short_task', 'codex_host',
       'old failure', '旧失败不应出现', 'failed', 'suspended', 'none', '[]', 'legacy',
       ${sqlQuote(oldAt)}, ${sqlQuote(oldAt)}),
      ('pet-proof-running', 'pet-proof-work', 'pet-proof-run', 'short_task', 'codex_host',
       'running', '新任务正在运行', 'running', 'running', 'none', '[]', 'legacy',
       ${sqlQuote(runningAt)}, ${sqlQuote(runningAt)}),
      ('pet-proof-refresh', 'pet-proof-refresh', 'pet-proof-refresh-run', 'short_task', 'codex_host',
       'refresh', 'refresh', 'completed', 'suspended', 'none', '[]', 'legacy',
       ${sqlQuote(runningAt)}, ${sqlQuote(runningAt)});
  `)
}

function updateFixtureToFailed(failedAt) {
  executeSql(`
    UPDATE task_projections
       SET status = 'failed', interaction_state = 'suspended',
           task_summary = '新任务真实失败', updated_at = ${sqlQuote(failedAt)}
     WHERE task_id = 'pet-proof-running';
  `)
}

function updateFixtureToCompleted(completedAt) {
  executeSql(`
    INSERT INTO chat_messages
      (id, conversation_id, role, content, timestamp, message_visibility_epoch)
    VALUES ('pet-proof-result-message', 'pet-proof-work', 'assistant', '任务已经顺利完成',
            ${sqlQuote(completedAt)}, 0);
    UPDATE task_projections
       SET status = 'completed', interaction_state = 'suspended',
           task_summary = '新任务已经完成', updated_at = ${sqlQuote(completedAt)}
     WHERE task_id = 'pet-proof-running';
  `)
}
