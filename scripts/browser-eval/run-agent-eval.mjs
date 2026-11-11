#!/usr/bin/env node
// Task-layer eval runner (W7-T2): 24 tasks on the local benchmark sites, judged by machine.
//
//   --dry-run     check task definitions, sites and judges with oracles; no model, no Electron
//   --plumbing    boot the built app hidden with an empty profile and drive one attempt up to
//                 sending the message; no model is configured, so nothing is spent
//   --live        the real baseline: uses the model of the eval profile given by --profile and
//                 spends money within the caps below. Only run it on purpose.
//
// See scripts/browser-eval/README.md for the options, the caps and the result format.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startEvalSites } from './server.mjs'
import { writeAttachmentFixtures } from './fixtures.mjs'
import { collectOutcome } from './outcome.mjs'
import { runDryRun } from './dry-run.mjs'
import { TASKS, renderPrompt, validateTasks } from './tasks/index.mjs'
import { createBudget, DEFAULT_BUDGET, parsePrices, planEstimate } from './agent-eval/budget.mjs'
import { aggregate, needsAnotherAttempt, renderMarkdown, summarizeTask } from './agent-eval/report.mjs'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

const USAGE = `用法：
  npm run verify:browser-agent-eval -- --dry-run [--tasks A1,B2]
  npm run verify:browser-agent-eval -- --plumbing [--tasks C3]
  npm run verify:browser-agent-eval -- --live --profile <评测资料目录> [选项]

--live 会用该资料目录里配置的模型、花真实费用。选项：
  --tasks A1,B2            只跑这些任务（默认全部 24 个）
  --repeats 3              每个任务计划次数，取多数（默认 3）
  --no-early-stop          即使多数已定也跑满
  --window hidden|visible  默认 hidden（不弹窗；后台指针按现状不可用）
  --authorization-mode ask|auto|full   默认 auto
  --max-tokens ${DEFAULT_BUDGET.maxTokens}   --max-tokens-per-attempt ${DEFAULT_BUDGET.maxTokensPerAttempt}
  --max-cost-usd ${DEFAULT_BUDGET.maxCostUsd}   --max-attempts ${DEFAULT_BUDGET.maxAttempts}
  --price-input <美元/百万令牌> --price-output <美元/百万令牌> [--price-cached-input <美元/百万令牌>]
  --out <目录>             默认 docs/superpowers/audits/<日期>-browser-agent-eval
  --keep-artifacts         保留每次尝试的临时资料（outputs/browser-eval/agent-runs/）
  --copy-oauth             同时复制 openai-oauth/auth.json（ChatGPT 登录；可能轮换源令牌）`

function parseArgs(argv) {
  const options = { flags: new Set(), values: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
    const [name, inline] = arg.slice(2).split('=')
    const next = argv[index + 1]
    const takesValue = ![
      'dry-run',
      'plumbing',
      'live',
      'no-early-stop',
      'keep-artifacts',
      'copy-oauth',
      'help'
    ].includes(
      name
    )
    if (!takesValue) options.flags.add(name)
    else if (inline !== undefined) options.values[name] = inline
    else if (next !== undefined && !next.startsWith('--')) { options.values[name] = next; index += 1 }
    else throw new Error(`--${name} 需要一个值`)
  }
  return options
}

function selectTasks(value) {
  if (!value) return TASKS
  const ids = value.split(',').map((item) => item.trim()).filter(Boolean)
  const unknown = ids.filter((id) => !TASKS.some((task) => task.id === id))
  if (unknown.length) throw new Error(`未知任务：${unknown.join(', ')}`)
  return TASKS.filter((task) => ids.includes(task.id))
}

function today() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function git(args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim() } catch { return '' }
}

function assertEvalProfile(profile) {
  const resolved = realpathSync(resolve(profile))
  const daily = resolve(homedir(), 'Library/Application Support/Ready')
  // macOS folders are case-insensitive: "…/ready" is the daily folder too.
  const fold = (path) => (process.platform === 'darwin' ? path.toLowerCase() : path)
  if (fold(resolved) === fold(daily) || fold(resolved).startsWith(`${fold(daily)}${sep}`))
    throw new Error('不能用日常 Ready 的资料目录做评测，请准备单独的评测资料目录')
  const database = join(resolved, 'ready.db')
  if (!existsSync(database)) throw new Error(`评测资料目录里没有 ready.db：${resolved}`)
  return { dir: resolved, database }
}

function electronEnv(spec, window) {
  const env = { ...process.env }
  for (const name of [
    'ELECTRON_RUN_AS_NODE',
    'READY_DB_PATH',
    'READY_REMOTE_DEBUGGING_PORT',
    'READY_ALLOW_MULTI_INSTANCE',
    'READY_START_HIDDEN'
  ])
    delete env[name]
  if (window === 'hidden') env.READY_START_HIDDEN = '1'
  env.READY_USER_DATA_DIR = spec.profileDir
  env.TMPDIR = join(spec.attemptDir, 'tmp')
  env.READY_BROWSER_EVAL_TASK = join(spec.attemptDir, 'spec.json')
  return env
}

/** Every descendant of the attempt process (Codex sidecar, helpers): only what this run started. */
function descendants(pid) {
  const found = []
  const queue = [pid]
  while (queue.length) {
    const parent = queue.shift()
    let children = []
    try {
      children = execFileSync('pgrep', ['-P', String(parent)], { encoding: 'utf8' }).split('\n').map(
        (line) => Number(line.trim())
      ).filter(
        Boolean
      )
    } catch { /* pgrep exits 1 when there are none */ }
    found.push(...children)
    queue.push(...children)
  }
  return found
}

function killTree(pid, signal = 'SIGTERM') {
  for (const child of descendants(pid).reverse()) {
    try { process.kill(child, signal) } catch { /* already gone */ }
  }
  try { process.kill(pid, signal) } catch { /* already gone */ }
}

async function launchAttempt(spec, window, hardTimeoutMs) {
  mkdirSync(join(spec.attemptDir, 'tmp'), { recursive: true })
  writeFileSync(join(spec.attemptDir, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`)
  const electron = require('electron')
  const logPath = join(spec.attemptDir, 'app.log')
  const child = spawn(
    electron,
    [join(here, 'agent-eval', 'attempt-app.mjs')],
    { cwd: root, env: electronEnv(spec, window), stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const log = []
  const keep = (chunk) => { log.push(String(chunk)); if (log.length > 4000) log.splice(0, log.length - 4000) }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  // Remember every process the attempt starts, so none outlives it (Ready normally stops them).
  const started = new Set()
  const watch = setInterval(() => { for (const pid of descendants(child.pid)) started.add(pid) }, 5_000)
  const exit = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      keep('\n[runner] hard timeout, stopping the attempt process tree\n')
      for (const pid of descendants(child.pid)) started.add(pid)
      killTree(child.pid, 'SIGTERM')
      setTimeout(() => killTree(child.pid, 'SIGKILL'), 10_000).unref()
    }, hardTimeoutMs)
    child.on('exit', (code, signal) => { clearTimeout(timer); clearInterval(watch); resolveExit({ code, signal }) })
  })
  writeFileSync(logPath, log.join(''))
  let leftovers = 0
  for (const pid of started) {
    try { process.kill(pid, 0) } catch { continue }
    try { process.kill(pid, 'SIGTERM'); leftovers += 1 } catch { /* already gone */ }
  }
  const resultPath = join(spec.attemptDir, 'result.json')
  const result = existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, 'utf8'))
    : { status: 'error', error: `attempt process ended without a result (code=${exit.code} signal=${exit.signal})` }
  const seedPath = join(spec.attemptDir, 'seed.json')
  if (existsSync(seedPath)) result.seed = JSON.parse(readFileSync(seedPath, 'utf8'))
  if (leftovers) result.notes = [...(result.notes || []), `stopped ${leftovers} leftover process(es) of this attempt`]
  return result
}

async function runAttempt({ task, attempt, server, runDir, options }) {
  server.reset()
  const attemptDir = join(runDir, `${task.id}-${attempt}`)
  const spec = {
    taskId: task.id,
    attempt,
    attemptDir,
    profileDir: join(attemptDir, 'profile'),
    workspaceDir: join(attemptDir, 'workspace'),
    startUrl: server.url(task.start.path, task.start.origin),
    prompt: renderPrompt(task, server.origins),
    attachments: [],
    cookie: task.session === 'logged_in' ? server.login() : null,
    limits: task.limits,
    maxTokensPerAttempt: options.maxTokensPerAttempt,
    authorizationMode: options.authorizationMode,
    providerSourceDb: options.providerSourceDb,
    plumbing: options.plumbing,
  }
  mkdirSync(spec.workspaceDir, { recursive: true })
  spec.attachments = await writeAttachmentFixtures(join(attemptDir, 'attachments'), task.attachments)
  if (options.copyOauth && options.profileDir) {
    const source = join(options.profileDir, 'openai-oauth', 'auth.json')
    if (existsSync(source)) {
      mkdirSync(join(spec.profileDir, 'openai-oauth'), { recursive: true })
      writeFileSync(join(spec.profileDir, 'openai-oauth', 'auth.json'), readFileSync(source))
    }
  }
  const hardTimeoutMs = (task.limits.maxMinutes + 5) * 60_000
  const result = await launchAttempt(spec, options.window, hardTimeoutMs)
  const outcome = await collectOutcome({
    server,
    roots: { workspace: spec.workspaceDir },
    finalText: result.finalText || '',
    metrics: {
      interventions: result.interventions?.total ?? null,
      steps: result.steps ?? null,
      tokens: result.tokens?.total ?? null,
      durationMs: result.durationMs ?? null,
    },
  })
  const judged = task.judge(outcome)
  // An attempt that never reached the model spent nothing; anything else without a meter is unknown.
  const tokens = result.tokens
    || (result.modelRequests === 0
      ? { input: 0, cachedInput: 0, output: 0, total: 0, method: 'no_model_request' }
      : null)
  return {
    taskId: task.id,
    category: task.category,
    attempt,
    status: result.status,
    pass: result.status === 'completed' && judged.pass,
    checks: judged.checks,
    steps: result.steps ?? null,
    toolsByName: result.toolsByName || null,
    tokens,
    modelRequests: result.modelRequests ?? null,
    durationMs: result.durationMs ?? null,
    interventions: result.interventions || null,
    blocking: result.blocking || null,
    disposition: result.disposition || null,
    terminal: result.terminal || null,
    failureKind: result.failureKind || null,
    finalTextHead: String(result.finalText || '').slice(0, 400),
    seed: result.seed || null,
    error: result.error || null,
    notes: result.notes || [],
    attemptDir,
  }
}

async function dryRun(options) {
  const tasks = selectTasks(options.values.tasks)
  const result = await runDryRun({ taskIds: tasks.map((task) => task.id), log: () => {} })
  for (const task of result.tasks) {
    const failed = task.steps.filter((step) => !step.ok).map(
      (step) => `${step.id}: ${String(step.detail).slice(0, 200)}`
    )
    console.log(`${task.ok ? 'PASS' : 'FAIL'} ${task.id}${failed.length ? ` — ${failed.join(' | ')}` : ''}`)
  }
  for (const error of result.validationErrors) console.log(`INVALID ${error}`)
  const outDir = join(root, 'outputs', 'browser-eval')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'agent-eval-dry-run.json'), `${JSON.stringify(result, null, 2)}\n`)
  const passed = result.tasks.filter((task) => task.ok).length
  console.log(
    `\n任务层 dry-run：${passed
    }/${result.tasks.length
    } 通过（判定在终点前为失败、oracle 达成终点后为通过）；模型调用 0 次`
  )
  return result.ok ? 0 : 1
}

async function plumbing(options) {
  if (!existsSync(join(root, 'out', 'main', 'index.js')))
    throw new Error('缺少 out/main/index.js：先构建（npx electron-vite build）')
  const [task] = selectTasks(options.values.tasks || 'C3')
  const server = await startEvalSites({ quiet: true })
  const runDir = join(root, 'outputs', 'browser-eval', 'plumbing', new Date().toISOString().replace(/[:.]/g, '-'))
  try {
    const attempt = await runAttempt({
      task,
      attempt: 1,
      server,
      runDir,
      options: {
        window: 'hidden',
        authorizationMode: 'auto',
        maxTokensPerAttempt: 1,
        providerSourceDb: null,
        plumbing: true
      },
    })
    writeFileSync(join(runDir, 'plumbing.json'), `${JSON.stringify(attempt, null, 2)}\n`)
    console.log(
      JSON.stringify(
        {
          status: attempt.status,
          disposition: attempt.disposition,
          failureKind: attempt.failureKind,
          steps: attempt.steps,
          error: attempt.error,
          notes: attempt.notes
        },
        null,
        2
      )
    )
    const ok = attempt.status === 'rejected' && attempt.disposition === 'rejected_before_persistence'
    console.log(ok
      ? '\n接线检查通过：隐藏启动、资料库与项目目录、浏览器模式'
        + '、起始页、会话、发送请求都走通；没有配置模型，'
        + `请求在准入前被拒绝（${attempt.failureKind
      }），未花费。`
      : '\n接线检查未通过，详见上面的结果与尝试目录里的 app.log。')
    return ok ? 0 : 1
  } finally {
    await server.close()
  }
}

async function live(options) {
  if (!options.values.profile) throw new Error('--live 需要 --profile <评测资料目录>')
  if (!existsSync(join(root, 'out', 'main', 'index.js')))
    throw new Error('缺少 out/main/index.js：先构建（npm run build 或 npx electron-vite build）')
  const errors = validateTasks()
  if (errors.length) throw new Error(`任务定义有误：${errors.join('; ')}`)
  const profile = assertEvalProfile(options.values.profile)
  const tasks = selectTasks(options.values.tasks)
  const repeats = Number(options.values.repeats || 3)
  const earlyStop = !options.flags.has('no-early-stop')
  const window = options.values.window || 'hidden'
  if (!['hidden', 'visible'].includes(window)) throw new Error('--window 只能是 hidden 或 visible')
  const authorizationMode = options.values['authorization-mode'] || 'auto'
  if (!['ask', 'auto', 'full'].includes(authorizationMode))
    throw new Error('--authorization-mode 只能是 ask、auto 或 full')
  const prices = parsePrices(
    {
      input: options.values['price-input'],
      output: options.values['price-output'],
      cachedInput: options.values['price-cached-input']
    }
  )
  const budget = createBudget({
    maxTokens: options.values['max-tokens'],
    maxTokensPerAttempt: options.values['max-tokens-per-attempt'],
    maxCostUsd: options.values['max-cost-usd'],
    maxAttempts: options.values['max-attempts'],
    prices,
  })
  const plan = planEstimate(tasks.length * repeats, prices)
  console.log(
    `计划：${tasks.length
    } 个任务 × 至多 ${repeats
    } 次；粗估 ${plan.tokens
    } 令牌${plan.costUsd === null ? '' : `、约 $${plan.costUsd.toFixed(2)}`
    }`
  )
  console.log(
    `上限：总令牌 ${budget.limits.maxTokens
    }、单次 ${budget.limits.maxTokensPerAttempt
    }${prices ? `、费用 $${budget.limits.maxCostUsd}` : '（未给单价，只按令牌限）'
    }、尝试 ${budget.limits.maxAttempts
    } 次；到上限即停`
  )
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = options.flags.has('keep-artifacts')
    ? join(root, 'outputs', 'browser-eval', 'agent-runs', stamp)
    : join(tmpdir(), `ready-browser-agent-eval-${stamp}`)
  const outDir = resolve(
    root,
    options.values.out || join('docs', 'superpowers', 'audits', `${today()}-browser-agent-eval`)
  )
  const server = await startEvalSites({ quiet: true })
  const attempts = []
  const summaries = []
  let stoppedReason = null
  try {
    for (const task of tasks) {
      const taskAttempts = []
      while (needsAnotherAttempt(taskAttempts, repeats, earlyStop)) {
        stoppedReason = budget.blockReason()
        if (stoppedReason) break
        const record = await runAttempt({
          task,
          attempt: taskAttempts.length + 1,
          server,
          runDir,
          options: {
            window,
            authorizationMode,
            maxTokensPerAttempt: budget.limits.maxTokensPerAttempt,
            providerSourceDb: profile.database,
            profileDir: profile.dir,
            copyOauth: options.flags.has('copy-oauth'),
            plumbing: false
          },
        })
        budget.record(record.tokens)
        taskAttempts.push(record)
        attempts.push(record)
        console.log(
          `${record.taskId
          }#${record.attempt
          } ${record.pass ? 'PASS' : 'FAIL'
          } status=${record.status
          } steps=${record.steps ?? '—'
          } tokens=${record.tokens?.total ?? '—'
          }${record.tokens?.method === 'estimated' ? '(估)' : ''
          } ${record.durationMs ? `${Math.round(record.durationMs / 1000)}s` : ''
          } interventions=${record.interventions?.total ?? '—'
          }`
        )
        if (!options.flags.has('keep-artifacts')) rmSync(record.attemptDir, { recursive: true, force: true })
      }
      summaries.push(summarizeTask(task, taskAttempts, repeats))
      if (stoppedReason) {
        for (const rest of tasks.slice(tasks.indexOf(task) + 1)) summaries.push(summarizeTask(rest, [], repeats))
        break
      }
    }
  } finally {
    await server.close()
    if (!options.flags.has('keep-artifacts')) rmSync(runDir, { recursive: true, force: true })
  }
  const model = attempts.find((attempt) => attempt.seed)?.seed
  const result = {
    date: today(),
    config: {
      argv: process.argv.slice(2).map((arg) => (arg === options.values.profile ? '<profile>' : arg)),
      gitHead: git(['rev-parse', '--short', 'HEAD']),
      gitDirty: git(['status', '--porcelain']).length > 0,
      model: model ? [model.provider, model.model].filter(Boolean).join(' / ') : null,
      window,
      authorizationMode,
      repeats,
      earlyStop,
      tasks: tasks.map((task) => task.id),
    },
    budget: { limits: budget.limits, prices: budget.prices, spent: budget.spent },
    stoppedReason,
    aggregate: aggregate(summaries),
    tasks: summaries,
    attempts: attempts.map(({ attemptDir: _attemptDir, seed: _seed, ...rest }) => rest),
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(join(outDir, 'README.md'), renderMarkdown(result))
  console.log(`\n结果：${outDir}`)
  return 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const modes = ['dry-run', 'plumbing', 'live'].filter((mode) => options.flags.has(mode))
  if (options.flags.has('help') || modes.length !== 1) {
    console.log(USAGE)
    return options.flags.has('help') ? 0 : 2
  }
  if (modes[0] === 'dry-run') return dryRun(options)
  if (modes[0] === 'plumbing') return plumbing(options)
  return live(options)
}

main().then((code) => { process.exitCode = code }, (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
