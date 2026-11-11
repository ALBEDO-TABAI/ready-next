import { create } from 'zustand'
import { readStorage, writeStorage } from '../utils/storage'
import {
    isRitualBypassActive,
    withRitual,
} from '../modules/overlay/useRitualOverlay'

// After-ritual hard timeout to force DOM↔store alignment even if the ritual exits unexpectedly
// (aborted by a rapid second click, engine throws, etc.). Chosen as roughly 1.5× the longest
// possible theme ritual timeline (180 + 320 + 900 = 1400ms).
const THEME_DOM_RECONCILE_FALLBACK_MS = 3000
let themeTransitionRequestToken = 0
let themeDomReconcileTimer: number | null = null

export type ThemeOption = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
/** 生效的透明度（W1 DL12）：用户的“减少透明”或系统的“减少透明度”任一打开即为 reduced。 */
export type Transparency = 'normal' | 'reduced'

interface ThemeState {
    theme: ThemeOption
    resolvedTheme: ResolvedTheme
    transparency: Transparency
    /** 用户自己的“减少透明”开关（真值在 Main；这里是它的回显）。 */
    reduceTransparency: boolean
    setTheme: (theme: ThemeOption) => void
    toggleTheme: () => void
    setReduceTransparency: (enabled: boolean) => void
}

// Read initial theme from localStorage
const getStoredTheme = (): ThemeOption => {
    const stored = readStorage('ready-theme')
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
    return 'light'
}

// Startup cache written by main.tsx from Main's snapshot (Main owns the setting).
const getStoredTransparency = (): Transparency => (readStorage('ready-transparency') === 'reduced' ? 'reduced' : 'normal')
const getStoredReduceTransparency = (): boolean => readStorage('ready-reduce-transparency') === 'true'

const applyTransparency = (transparency: Transparency) => {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute('data-transparency', transparency)
    writeStorage('ready-transparency', transparency)
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
        // fire-and-forget: native theme propagation; renderer-side data-theme attribute already applied (applyThemeImmediate), and a missed sync only affects future window-chrome native colors.
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

const clearThemeDomReconcileTimer = () => {
    if (themeDomReconcileTimer) {
        window.clearTimeout(themeDomReconcileTimer)
        themeDomReconcileTimer = null
    }
}

const waitForThemeSettleFrames = (frameCount: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal.aborted || frameCount <= 0) {
            resolve()
            return
        }
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            resolve()
            return
        }

        let remainingFrames = frameCount
        const onAbort = () => {
            resolve()
        }

        const step = () => {
            if (signal.aborted) {
                signal.removeEventListener('abort', onAbort)
                resolve()
                return
            }
            window.requestAnimationFrame(() => {
                if (signal.aborted) {
                    signal.removeEventListener('abort', onAbort)
                    resolve()
                    return
                }
                remainingFrames -= 1
                if (remainingFrames <= 0) {
                    signal.removeEventListener('abort', onAbort)
                    resolve()
                    return
                }
                step()
            })
        }

        signal.addEventListener('abort', onAbort, { once: true })
        step()
    })

const applyColorTheme = (
    resolved: ResolvedTheme,
    option: ThemeOption,
    currentResolved: ResolvedTheme,
    { animate = true }: { animate?: boolean } = {},
) => {
    if (typeof document === 'undefined') return
    const requestToken = ++themeTransitionRequestToken
    clearThemeDomReconcileTimer()

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

    void withRitual('theme-transition', async ({ signalReady, abortSignal }) => {
        if (abortSignal.aborted || requestToken !== themeTransitionRequestToken) return

        document.documentElement.setAttribute('data-theme', resolved)
        if (abortSignal.aborted || requestToken !== themeTransitionRequestToken) return

        syncNativeTheme(option)
        await waitForThemeSettleFrames(2, abortSignal)

        if (!abortSignal.aborted && requestToken === themeTransitionRequestToken) {
            signalReady()
        }
    }, { meta: { direction } }).catch(() => {
        if (requestToken === themeTransitionRequestToken) {
            ensureDomThemeMatches(resolved, option)
        }
    })

    // Hard-timeout safety net: if the ritual never reaches leaving (e.g., unmount mid-transition)
    // this guarantees the DOM eventually matches the store so the next click starts from a
    // consistent state.
    themeDomReconcileTimer = window.setTimeout(() => {
        if (requestToken === themeTransitionRequestToken) {
            ensureDomThemeMatches(resolved, option)
        }
        if (themeDomReconcileTimer) {
            themeDomReconcileTimer = null
        }
    }, THEME_DOM_RECONCILE_FALLBACK_MS)
}

export const useTheme = create<ThemeState>((set, get) => {
    // Apply initial theme on load
    const initial = getStoredTheme()
    const initialTransparency = getStoredTransparency()
    const resolved = resolveTheme(initial)
    applyColorTheme(resolved, initial, resolved, { animate: false })
    applyTransparency(initialTransparency)

    // Main broadcasts a snapshot when the switch or the system's "reduce transparency" changes.
    // Only the transparency fields are taken from it; light/dark keeps its ritual-driven path.
    const followSnapshot = (snapshot: { transparency?: Transparency; reduceTransparency?: boolean } | null | undefined) => {
        if (!snapshot) return
        const transparency: Transparency = snapshot.transparency === 'reduced' ? 'reduced' : 'normal'
        const reduceTransparency = snapshot.reduceTransparency === true
        writeStorage('ready-reduce-transparency', String(reduceTransparency))
        const state = get()
        if (state.transparency !== transparency) applyTransparency(transparency)
        if (state.transparency !== transparency || state.reduceTransparency !== reduceTransparency) {
            set({ transparency, reduceTransparency })
        }
    }
    window.electronAPI?.theme?.onChanged?.(followSnapshot)

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
        transparency: initialTransparency,
        reduceTransparency: getStoredReduceTransparency(),
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
        setReduceTransparency: (enabled) => {
            // Turning it on is immediate; turning it off waits for Main, because the system's own
            // "reduce transparency" may still hold the window opaque.
            if (enabled) applyTransparency('reduced')
            set(enabled ? { reduceTransparency: true, transparency: 'reduced' } : { reduceTransparency: false })
            const api = window.electronAPI?.theme
            if (!api?.setReduceTransparency) {
                // No Main (browser-only preview): nothing else can hold the window opaque.
                followSnapshot({ transparency: enabled ? 'reduced' : 'normal', reduceTransparency: enabled })
                return
            }
            api.setReduceTransparency(enabled).then(followSnapshot).catch((error: unknown) => {
                console.warn('[theme] reduce-transparency switch failed:', error instanceof Error ? error.message : String(error))
            })
        },
    }
})
