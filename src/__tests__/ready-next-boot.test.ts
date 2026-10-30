import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { parse } from 'yaml'
import * as isolation from '../main/ready-next-data-isolation'
import * as databasePath from '../main/modules/database-path'

// Execute the actual boot entry with only its Electron/process boundary replaced.
// No database or user profile is loaded; heavy imports are forbidden by the loader.
// allow-source-grep: boot-entry runs Electron side effects at import time, so the test executes the transpiled real entry in a VM behind a fake Electron boundary and asserts call order, not source text.
const boot = ts.transpileModule(readFileSync(path.resolve('src/main/boot-entry.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

test('C15 boot rejects overrides before directory creation, locking or database-capable startup', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'ready-next-boot-'))
  const daily = path.join(home, 'Library/Application Support/Ready')
  try {
    const hiddenRefusal = { READY_USER_DATA_DIR: path.join(daily, 'nested'), READY_START_HIDDEN: '1' }
    for (const env of [{ READY_USER_DATA_DIR: daily }, { READY_DB_PATH: path.join(daily, 'ready.db') }, hiddenRefusal, {}]) {
      const calls: string[] = []
      let name = ''
      const exited = new Error('process exited')
      const app = {
        setName(value: string) { name = value }, on() {},
        getPath(key: string) { return key === 'home' ? home : path.join(home, 'Library/Application Support', name) },
        setPath() { calls.push('setPath') },
        requestSingleInstanceLock() { calls.push('lock'); return true },
        // Electron's app.exit returns and lets the module keep running, so the
        // isolation guard must not rely on it.
        exit(code: number) { calls.push(`app.exit:${code}`) },
        commandLine: { appendSwitch() {} }, userAgentFallback: '',
        whenReady() { calls.push('startup'); return { then() { return { catch() {} } } } },
      }
      const modules: Record<string, unknown> = {
        electron: { app, dialog: { showErrorBox(_title: string, message: string) {
          assert.match(message, /cannot use daily Ready data/); calls.push('error')
        } }, protocol: { registerSchemesAsPrivileged() {} } },
        dotenv: { config() {} }, path,
        fs: { mkdirSync() { calls.push('mkdir') } },
        './ready-next-data-isolation': isolation,
        './modules/database-path': databasePath,
        './calendar-open-intents': { captureCalendarOpen() { return false } },
        './modules/browser-engine/popup-policy': { toOAuthCompatibleUserAgent: (value: string) => value },
        './startup-splash-window': {}, './boot-timing': {},
      }
      const execute = () => runInNewContext(boot, {
        require(id: string) { assert.ok(id in modules, `unexpected startup dependency: ${id}`); return modules[id] },
        exports: {}, __dirname: path.resolve('src/main'),
        process: {
          env, argv: [], platform: 'linux',
          exit(code: number) { calls.push(`process.exit:${code}`); throw exited },
        },
        console: { error() {} },
      })
      if (Object.keys(env).length) {
        assert.throws(execute, error => error === exited)
        // Hidden (automation) starts must not block on a modal box before exiting.
        assert.deepEqual(calls, env === hiddenRefusal ? ['process.exit:1'] : ['error', 'process.exit:1'])
      } else {
        execute()
        assert.deepEqual(calls, ['lock', 'startup'])
      }
      assert.equal(name, 'Ready Next')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('packaging gives Ready Next a distinct identity, protocol and product-based artifact name', () => {
  const config = parse(readFileSync(path.resolve('electron-builder.yml'), 'utf8'))
  assert.equal(config.productName, 'Ready Next')
  assert.equal(config.appId, 'com.ready.app.next')
  assert.deepEqual(config.protocols.flatMap((entry: { schemes: string[] }) => entry.schemes), ['ready-next'])
  assert.equal(config.mac.artifactName, '${productName}-${version}-${arch}.${ext}')
})
