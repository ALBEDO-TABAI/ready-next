// Electron Main entry for one live task-layer attempt. Started only by run-agent-eval.mjs.
// It runs the built Ready Next Main (out/main/index.js) unchanged, with the eval driver loaded
// beside it in the same process; the app path is the repository root, as with `electron .`.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Errors before Ready installs its own handlers must not open Electron's error dialog.
const fatal = (error) => {
  process.stderr.write(`browser-agent-eval attempt: ${error && error.stack ? error.stack : error}\n`)
  app.exit(2)
}
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const main = join(root, 'out', 'main', 'index.js')
const specPath = process.env.READY_BROWSER_EVAL_TASK
if (!existsSync(main)) fatal(new Error(`built main missing: ${main} (run the build first)`))
if (!specPath) fatal(new Error('READY_BROWSER_EVAL_TASK is required'))
const spec = JSON.parse(readFileSync(specPath, 'utf8'))

mkdirSync(spec.profileDir, { recursive: true })
if (spec.providerSourceDb) {
  // Seed before Ready opens its database, exactly once per throwaway profile.
  const { seedProviderSettings } = await import('./seed.mjs')
  const summary = seedProviderSettings(spec.providerSourceDb, join(spec.profileDir, 'ready.db'))
  writeFileSync(join(spec.attemptDir, 'seed.json'), `${JSON.stringify(summary, null, 2)}\n`)
}

app.setAppPath(root)
const { startDriver } = await import('./driver.mjs')
startDriver(spec)
await import(pathToFileURL(main).href)
