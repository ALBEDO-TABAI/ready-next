/**
 * Electron-coupled wrapper around `reapOrphansCore`. The pure logic lives in
 * `./boot-reaper-core` so it can be unit-tested without spinning up Electron.
 */
import { join } from 'node:path'
import { app } from 'electron'

import { reapOrphansCore, type ReapOrphansResult } from './boot-reaper-core'

export type { ReapedProcess, ReapOrphansResult } from './boot-reaper-core'

export function reapOrphans(): ReapOrphansResult {
  const puppeteerCachePath = join(app.getPath('userData'), 'puppeteer-cache')
  return reapOrphansCore({ puppeteerCachePath })
}
