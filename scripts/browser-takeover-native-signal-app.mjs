import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import 'tsx/esm'

const profile = mkdtempSync(join(tmpdir(), 'ready-browser-takeover-native-'))
app.setPath('userData', profile)
process.env.READY_DB_PATH = join(profile, 'ready.db')

app.whenReady().then(async () => {
  try {
    const { runBrowserControllerTakeoverNativeSignalTest } = await import('../src/__tests__/browser-controller-takeover-native-signal.ts')
    await runBrowserControllerTakeoverNativeSignalTest()
    process.stdout.write('browser-controller-takeover-native-signal: pass\n')
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`)
    app.exit(1)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})
