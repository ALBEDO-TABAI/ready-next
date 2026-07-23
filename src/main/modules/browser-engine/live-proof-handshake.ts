import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, ipcMain } from 'electron'

import { resolveReadyDatabasePath } from '../database-path'
import { getBrowserBootIncarnationId } from './automation-service'

const CHANNEL = 'app:browserLiveProofHandshake'
const originalFs = createRequire(import.meta.url)('original-fs') as typeof import('node:fs')

async function sha256File(path: string, physicalArchive = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = physicalArchive ? originalFs.createReadStream(path) : createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export function setupBrowserLiveProofHandshake(): void {
  const expectedNonce = process.env.READY_BROWSER_LIVE_PROOF_NONCE?.trim()
  if (!expectedNonce) return
  ipcMain.removeHandler(CHANNEL)
  ipcMain.handle(CHANNEL, async (_event, suppliedNonce: unknown) => {
    if (String(suppliedNonce || '') !== expectedNonce) {
      return { success: false, error: 'proof_nonce_mismatch' }
    }
    const appPath = app.getAppPath()
    const manifestPath = join(appPath, 'build', 'browser-live-proof', 'source-manifest.json')
    if (!existsSync(manifestPath)) return { success: false, error: 'embedded_source_manifest_missing' }
    const sourceManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { digest?: unknown }
    const asarPath = appPath.endsWith('.asar') && existsSync(appPath) ? appPath : null
    const execPath = process.execPath
    const userDataPath = app.getPath('userData')
    const databasePath = resolveReadyDatabasePath(userDataPath, process.env.READY_DB_PATH)
    return {
      success: true,
      proofNonce: expectedNonce,
      pid: process.pid,
      execPath,
      execSha256: await sha256File(execPath),
      asarPath,
      asarSha256: asarPath ? await sha256File(asarPath, true) : null,
      sourceManifestDigest: String(sourceManifest.digest || ''),
      bootIncarnationId: getBrowserBootIncarnationId(),
      userDataPath,
      databasePath,
      tempDir: tmpdir(),
      metricsPath: join(tmpdir(), 'ready-agent-metrics.log'),
      appVersion: app.getVersion(),
    }
  })
}
