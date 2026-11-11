#!/usr/bin/env node
// Launches the tool-layer eval in a hidden Electron Main process and prints the result table.
// Usage: node scripts/browser-eval/tool-layer/run.mjs [--only form,spa] [--report <path>]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}
const only = option('--only') || ''
const reportPath = resolve(root, option('--report') || 'outputs/browser-eval/tool-layer-report.json')
const timeoutMs = Number(option('--timeout-ms') || 8 * 60_000)
mkdirSync(dirname(reportPath), { recursive: true })
rmSync(reportPath, { force: true })

// Everything the eval process writes stays under one throwaway root: profile, database, logs
// (os.tmpdir()) and home-relative files.
const evalRoot = mkdtempSync(join(tmpdir(), 'ready-browser-eval-tools-'))
for (const dir of ['tmp', 'home', 'profile']) mkdirSync(join(evalRoot, dir), { recursive: true })
const env = {
  ...process.env,
  READY_START_HIDDEN: '1',
  READY_BROWSER_EVAL_REPORT: reportPath,
  READY_BROWSER_EVAL_ONLY: only,
  READY_BROWSER_EVAL_ROOT: evalRoot,
  TMPDIR: join(evalRoot, 'tmp'),
  HOME: join(evalRoot, 'home'),
}
for (const name of ['ELECTRON_RUN_AS_NODE', 'READY_REMOTE_DEBUGGING_PORT', 'READY_DB_PATH', 'READY_USER_DATA_DIR'])
  delete env[name]

const electron = require('electron')
const started = Date.now()
const child = spawn(electron, [join(here, 'app.mjs')], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] })
const timer = setTimeout(() => {
  process.stderr.write(`browser-eval-tools: timed out after ${timeoutMs}ms, stopping the eval process\n`)
  child.kill('SIGTERM')
  setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
}, timeoutMs)

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  rmSync(evalRoot, { recursive: true, force: true })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (!existsSync(reportPath)) {
    process.stderr.write(`browser-eval-tools: no report (exit code=${code} signal=${signal}, ${seconds}s)\n`)
    process.exit(code || 1)
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  process.stdout.write(`\n工具层评测（隐藏 Electron ${report.electron}，${seconds}s）\n`)
  process.stdout.write(`${'站点'.padEnd(10)} 通过 失败 未开放 已知差距\n`)
  for (const [site, counts] of Object.entries(report.bySite || {})) {
    process.stdout.write(
      `${site.padEnd(12)
      } ${String(counts.pass).padStart(3)
      } ${String(counts.fail).padStart(4)
      } ${String(counts.unavailable).padStart(5)
      } ${String(counts.gap ?? 0).padStart(6)
      }\n`
    )
  }
  const totals = report.totals || {}
  process.stdout.write(
    `合计          ${String(totals.pass).padStart(3)
    } ${String(totals.fail).padStart(4)
    } ${String(totals.unavailable).padStart(5)
    } ${String(totals.gap ?? 0).padStart(6)
    }\n`
  )
  for (const item of (report.cases || []).filter((entry) => entry.status === 'fail')) {
    process.stdout.write(`FAIL ${item.id}: ${item.detail}\n`)
  }
  process.stdout.write(`报告：${reportPath}\n`)
  process.exit(report.ok && code === 0 ? 0 : 1)
})
