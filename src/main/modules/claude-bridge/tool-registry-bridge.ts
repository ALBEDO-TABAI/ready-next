import { createRequire } from 'module'

/**
 * B Phase 4 cleanup helper: lazily resolves the registered tool names without
 * dragging the full agent-control/tools-runtime/tool-registry module graph into the
 * claude-bridge layer at module-load time.
 *
 * The static `import { getRegisteredToolNames } from '../agent-control/tools-runtime/tool-registry'`
 * approach pulls in `tools/memory-tools → tools/tool-executor → browser-engine/ipc-handler`
 * which transitively requires Electron's `BrowserWindow`, breaking tsx
 * unit tests that exercise sanitize-only call paths (e.g. KimiCodingClient
 * with a fake fetch).
 *
 * In production the runtime is already up by the time these clients run, so
 * the lazy `createRequire` resolves a fully-constructed registry. In test
 * environments we silently fall back to `null` and the sanitizer's pass-2
 * tool-name filter becomes a no-op (structural pass still runs).
 */

let cachedResolver: (() => Set<string>) | null | undefined
const requireFromHere = createRequire(import.meta.url)

function resolveRegistryGetter(): (() => Set<string>) | null {
  if (cachedResolver !== undefined) return cachedResolver
  try {
    const mod = requireFromHere('../agent-control/tool-registry') as {
      getRegisteredToolNames?: () => Set<string>
    }
    cachedResolver = typeof mod.getRegisteredToolNames === 'function' ? mod.getRegisteredToolNames : null
  } catch {
    cachedResolver = null
  }
  return cachedResolver
}

export function resolveRegisteredToolNamesLazily(): Set<string> | null {
  const getter = resolveRegistryGetter()
  if (!getter) return null
  try {
    return getter()
  } catch {
    return null
  }
}

/**
 * Test-only — clears the cached resolver so a subsequent call re-evaluates the
 * lazy require. Useful when a test needs to verify both the success and
 * failure paths of registry resolution.
 */
export function _resetCachedResolverForTests(): void {
  cachedResolver = undefined
}
