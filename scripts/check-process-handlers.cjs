#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const REQUIRED_PROCESS_EVENTS = [
  'unhandledRejection',
  'uncaughtException',
]

const REQUIRED_APP_EVENTS = [
  'render-process-gone',
  'child-process-gone',
]

const PROCESS_METRICS = [
  'process_unhandled_rejection',
  'process_uncaught_exception',
  'render_process_gone',
  'child_process_gone',
  'log_rotation_failed',
]

function checkProcessHandlers(options = {}) {
  const root = resolve(options.root || resolve(__dirname, '..'))
  const errors = []
  const read = (file) => {
    const path = resolve(root, file)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  const index = read('src/main/index.ts')
  const handlers = read('src/main/process-handlers.ts')
  const metrics = read('src/main/utils/process-metrics.ts')
  const toolErrorMetrics = read('src/main/modules/agent-control/tools-runtime/tool-error-metrics.ts')

  if (!handlers) errors.push('src/main/process-handlers.ts is missing')
  if (!metrics) errors.push('src/main/utils/process-metrics.ts is missing')

  for (const event of REQUIRED_PROCESS_EVENTS) {
    if (!handlers.includes(`processTarget.on('${event}'`) && !handlers.includes(`processTarget.on("${event}"`)) {
      errors.push(`process handler "${event}" is not registered through processTarget.on`)
    }
  }

  for (const event of REQUIRED_APP_EVENTS) {
    if (!handlers.includes(`deps.app.on('${event}'`) && !handlers.includes(`deps.app.on("${event}"`)) {
      errors.push(`app handler "${event}" is not registered through deps.app.on`)
    }
  }

  if (!/registerMainProcessHandlers\(\{\s*app,/s.test(index)) {
    errors.push('registerMainProcessHandlers({ app, ... }) is missing from src/main/index.ts')
  }
  const registerIndex = index.indexOf('registerMainProcessHandlers')
  const readyIndex = index.indexOf('app.whenReady()')
  if (registerIndex < 0 || readyIndex < 0 || registerIndex > readyIndex) {
    errors.push('registerMainProcessHandlers must run before app.whenReady()')
  }

  if (!/timeoutMs:\s*5_000|DEFAULT_FATAL_CLEANUP_TIMEOUT_MS\s*=\s*5_000/.test(`${index}\n${handlers}`)) {
    errors.push('fatal cleanup timeout must stay bounded at 5 seconds')
  }
  if (!/app\.exit\(1\)/.test(handlers)) {
    errors.push('fatal handlers must exit the app with code 1 after cleanup')
  }

  for (const metric of PROCESS_METRICS) {
    if (!metrics.includes(metric)) {
      errors.push(`process/log metric "${metric}" is missing from local metric constants`)
    }
    if (toolErrorMetrics.includes(metric)) {
      errors.push(`process/log metric "${metric}" must not be registered in TOOL_ERROR_METRICS`)
    }
  }

  return { ok: errors.length === 0, errors }
}

function main() {
  const result = checkProcessHandlers({ root: parseRoot(process.argv.slice(2)) })
  if (!result.ok) {
    console.error('process handler check failed:')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log('process handlers: ok')
}

function parseRoot(argv) {
  let root = resolve(__dirname, '..')
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== '--root') throw new Error(`Unknown argument "${arg}".`)
    const value = argv[index + 1]
    if (!value) throw new Error('Missing value for --root.')
    root = resolve(value)
    index += 1
  }
  return root
}

if (require.main === module) main()

module.exports = { checkProcessHandlers }
