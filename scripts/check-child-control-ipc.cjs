#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const REQUIRED = [
  {
    file: 'src/main/modules/claude-bridge/ipc-handler.ts',
    checks: [
      ['list IPC handler', /agent:listActiveChildRuns/],
      ['cancel IPC handler', /agent:cancelChildRun/],
      ['list IPC helper', /listActiveChildRunsForIpc/],
      ['cancel IPC helper', /cancelChildRunForIpc/],
    ],
  },
  {
    file: 'src/main/modules/claude-bridge/active-child-run-ipc.ts',
    checks: [
      ['list helper export', /export function listActiveChildRunsForIpc/],
      ['cancel helper export', /export async function cancelChildRunForIpc/],
      ['cancel IPC validates childRunId', /childRunId is required/],
      ['UI cancel source', /source:\s*['"]ui_button['"]/],
    ],
  },
  {
    file: 'src/preload/index.ts',
    checks: [
      ['preload list method', /listActiveChildRuns:\s*\(/],
      ['preload list channel', /agent:listActiveChildRuns/],
      ['preload cancel method', /cancelChildRun:\s*\(/],
      ['preload cancel channel', /agent:cancelChildRun/],
    ],
  },
  {
    file: 'src/renderer/types/electron.d.ts',
    checks: [
      ['summary data type', /interface ActiveChildRunSummaryData/],
      ['summary childRunId', /childRunId:\s*string/],
      ['summary startedAt', /startedAt:\s*string/],
      ['agent list type', /listActiveChildRuns:\s*\(\)\s*=>\s*Promise<IPCResponse<ActiveChildRunSummaryData\[\]>>/],
      ['agent cancel type', /cancelChildRun:\s*\(\s*childRunId:\s*string\s*\)\s*=>\s*Promise<IPCResponse/],
    ],
  },
  {
    file: 'src/main/modules/agent-control/skills/skill-child-runner.ts',
    checks: [
      ['active summary method', /listActiveRuns\(/],
      ['active startedAt field', /startedAt:\s*string/],
      ['cancel source type', /CancelSkillChildRunSource\s*=\s*['"]nlp['"]\s*\|\s*['"]ui_button['"]/],
      ['cancel source metric', /skill_child_run_cancel_requested/],
    ],
  },
]

main()

function main() {
  if (require.main !== module) return
  try {
    const options = parseArgs(process.argv.slice(2))
    const failures = checkChildControlIpc(options)
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`${failure.file}: missing ${failure.label}`)
      }
      process.exit(1)
    }
    console.log('child control ipc: ok')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function parseArgs(argv) {
  const options = { root: resolve(__dirname, '..') }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --root.')
      options.root = resolve(value)
      i += 1
    } else {
      throw new Error(`Unknown argument "${arg}".`)
    }
  }
  return options
}

function checkChildControlIpc({ root }) {
  const failures = []
  for (const entry of REQUIRED) {
    const path = resolve(root, entry.file)
    if (!existsSync(path)) {
      failures.push({ file: entry.file, label: 'file' })
      continue
    }
    const text = readFileSync(path, 'utf8')
    for (const [label, pattern] of entry.checks) {
      if (!pattern.test(text)) failures.push({ file: entry.file, label })
    }
  }
  return failures
}

module.exports = {
  checkChildControlIpc,
}
