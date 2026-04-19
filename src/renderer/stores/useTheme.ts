import { create } from 'zustand'
import { readStorage, writeStorage } from '../utils/storage'
import {
    THEME_HOLD_DURATION_MS,
    isRitualBypassActive,
    withRitual,
} from '../modules/overlay/useRitualOverlay'

// After-ritual hard timeout to force DOM↔store alignment even if the ritual exits unexpectedly
// (aborted by a rapid second click, engine throws, etc.). Chosen as roughly 1.5× the longest
// possible theme ritual timeline (160 + 440 + 720 = 1320ms).
const THEME_DOM_RECONCILE_FALLBACK_MS = 2000

export type ThemeOption = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export type ThemeSkin = 'liquid-glass'

interface ThemeState {
    theme: ThemeOption
    resolvedTheme: ResolvedTheme
    skin: ThemeSkin
    setTheme: (theme: ThemeOption) => void
    toggleTheme: () => void
    setSkin: (skin: ThemeSkin) => void
    toggleSkin: () => void
}

// Read initial theme from localStorage
const getStoredTheme = (): ThemeOption => {
    const stored = readStorage('ready-theme')
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
    return 'light'
}

const getStoredSkin = (): ThemeSkin => {
    const stored = readStorage('ready-theme-skin')
    if (stored === 'liquid-glass') return stored
    return 'liquid-glass'
}

// Resolve the effective theme (system -> actual light/dark)
const resolveTheme = (theme: ThemeOption): ResolvedTheme => {
    if (typeof window === 'undefined') return theme === 'dark' ? 'dark' : 'light'
    if (theme === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return theme
}

const syncNativeTheme = (option: ThemeOption) => {
    if (typeof window !== 'undefined' && window.electronAPI?.theme) {
        window.electronAPI.theme.set(option).catch(() => { /* ignore in browser-only dev */ })
    }
}

const applyThemeImmediate = (resolved: ResolvedTheme, option: ThemeOption) => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.setAttribute('data-theme', resolved)
    syncNativeTheme(option)
}

// Force DOM data-theme to match store-resolved theme. Called from ritual cleanup / error paths
// so that store and DOM cannot drift when the animation exits abnormally (abort, throw, etc.).
const ensureDomThemeMatches = (resolved: ResolvedTheme, option: ThemeOption) => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    if (root.getAttribute('data-theme') !== resolved) {
        root.setAttribute('data-theme', resolved)
    }
    syncNativeTheme(option)
}

// waitFor with AbortSignal — resolves on timer or abort, whichever comes first.
// Kept local to the theme store because it participates in deferred data-theme writing
// and should not be confused with the ritual engine's internal waitFor.
const waitForHoldingEnd = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal.aborted) { resolve(); return }
        const timer = window.setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            window.clearTimeout(timer)
            resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
    })

const applyColorTheme = (
    resolved: ResolvedTheme,
    option: ThemeOption,
    currentResolved: ResolvedTheme,
    { animate = true }: { animate?: boolean } = {},
) => {
    if (typeof document === 'undefined') return

    // Early bypass — no ritual animation for these cases; mutate DOM synchronously.
    // Includes: first-load hydration (animate:false), system-theme no-op (resolved===current),
    // panel-resize in progress, user-prefers-reduced-motion.
    if (
        !animate
        || typeof window === 'undefined'
        || resolved === currentResolved
        || isRitualBypassActive()
    ) {
        applyThemeImmediate(resolved, option)
        return
    }

    const direction = resolved === 'dark' ? 'to-dark' : 'to-light'
    const holdMs = THEME_HOLD_DURATION_MS

    void withRitual('theme-transition', async ({ signalReady, abortSignal }) => {
        // signalReady kicks the engine into holding; by this point the engine has already
        // set phase='holding' and awaited one rAF — the overlay has painted the holding
        // styles (full opacity, 94% tint, heavy blur) and is visually covering the screen.
        signalReady()
        // Flip <html data-theme> NOW, at the start of holding. The overlay's translucent
        // frosted glass (high alpha + heavy blur) absorbs the underlying content swap,
        // while its own bg cross-fade from outgoing→incoming canvas color drives the
        // visible light↔dark transition over the next holdMs. Flipping at the *end* of
        // holding would race the bg cross-fade and produce a visible jolt on the
        // holding→leaving boundary.
        if (!abortSignal.aborted) {
            document.documentElement.setAttribute('data-theme', resolved)
        }
        // Keep the workFn alive until the holding phase ends so the engine's
        // `await workPromise` lines up with the renderer-owned ritual base completing its
        // single light↔dark color cross-fade before native window materials update.
        await waitForHoldingEnd(holdMs, abortSignal)
        if (!abortSignal.aborted) {
            syncNativeTheme(option)
        }
    }, { meta: { direction } }).catch(() => {
        // Any failure path (abort from rapid second click, engine throw) falls through to
        // this reconcile — cheap and idempotent.
        ensureDomThemeMatches(resolved, option)
    })

    // Hard-timeout safety net: if the ritual never reaches leaving (e.g., unmount mid-transition)
    // this guarantees the DOM eventually matches the store so the next click starts from a
    // consistent state.
    window.setTimeout(() => ensureDomThemeMatches(resolved, option), THEME_DOM_RECONCILE_FALLBACK_MS)
}

const applySkin = (skin: ThemeSkin) => {
    document.documentElement.setAttribute('data-skin', skin)
}

export const useTheme = create<ThemeState>((set, get) => {
    // Apply initial theme on load
    const initial = getStoredTheme()
    const initialSkin = getStoredSkin()
    const resolved = resolveTheme(initial)
    applyColorTheme(resolved, initial, resolved, { animate: false })
    applySkin(initialSkin)

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleSystemChange = () => {
        const state = get()
        if (state.theme === 'system') {
            const newResolved = resolveTheme('system')
            applyColorTheme(newResolved, 'system', state.resolvedTheme, { animate: false })
            set({ resolvedTheme: newResolved })
        }
    }
    mediaQuery.addEventListener('change', handleSystemChange)

    return {
        theme: initial,
        resolvedTheme: resolved,
        skin: initialSkin,
        setTheme: (theme) => {
            const prevResolved = get().resolvedTheme
            const newResolved = resolveTheme(theme)
            applyColorTheme(newResolved, theme, prevResolved)
            writeStorage('ready-theme', theme)
            set({ theme, resolvedTheme: newResolved })
        },
        toggleTheme: () => {
            const state = get()
            // Strict 2-way: always flip against the currently-rendered theme so every click
            // produces a visible change. Choosing an explicit 'light'/'dark' (not 'system')
            // matches the topbar button's 2-state title; users who want "follow system" can
            // re-enable it from Settings.
            const next: ThemeOption = state.resolvedTheme === 'dark' ? 'light' : 'dark'
            applyColorTheme(next, next, state.resolvedTheme)
            writeStorage('ready-theme', next)
            set({ theme: next, resolvedTheme: next })
        },
        setSkin: (_skin) => {
            applySkin('liquid-glass')
            writeStorage('ready-theme-skin', 'liquid-glass')
            set({ skin: 'liquid-glass' })
        },
        toggleSkin: () => {
            applySkin('liquid-glass')
            writeStorage('ready-theme-skin', 'liquid-glass')
            set({ skin: 'liquid-glass' })
        },
    }
})
