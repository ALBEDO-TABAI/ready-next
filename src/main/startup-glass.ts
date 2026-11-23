import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The startup splash's native layers under its page (plan
 * docs/superpowers/plans/2026-11-19-ready-next-startup-splash-implementation.md §6): the system's clear Liquid Glass
 * over water — the desktop behind the window pushed into ripples and magnified at the rim. macOS 26 and later only;
 * anywhere else, or when the module was not built or fails to load, there is none and the page draws its own glass.
 * The module is native/startup-glass, built by scripts/build-startup-glass.cjs.
 */
export interface StartupGlass {
  /** Adds the glass and the water under every other view of the window; returns what it added ("glass ripples"). */
  attach(handle: Buffer, x: number, y: number, width: number, height: number, radius: number, ripple: number, rim: number): string
  /** From left to right, the water goes still over `seconds`. */
  calm(seconds: number): string
  clear(): string
}

/** How strongly the ripples and the rim lens push, as the user set them in the demo window (2026-11-23). */
export const STARTUP_GLASS_RIPPLE = 18
export const STARTUP_GLASS_RIM = 200
/** The water calms before the dots come (W4). */
export const STARTUP_GLASS_CALM_MS = 1200

function modulePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'ready_glass.node')
    : join(app.getAppPath(), 'native', 'startup-glass', 'build', 'Release', 'ready_glass.node')
}

export function loadStartupGlass(): StartupGlass | null {
  if (process.platform !== 'darwin' || Number(process.getSystemVersion().split('.')[0]) < 26) return null
  const file = modulePath()
  if (!existsSync(file)) return null
  try {
    const loaded = { exports: {} as StartupGlass }
    process.dlopen(loaded, file)
    return loaded.exports
  } catch (error) {
    console.warn('[startup-glass] load failed; the splash draws its own glass:', error instanceof Error ? error.message : String(error))
    return null
  }
}
