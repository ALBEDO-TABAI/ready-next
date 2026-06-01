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
export type ThemeAccent = 'blue' | 'green' | 'purple' | 'orange'
/**
 * 玻璃风格。
 * - `liquid-glass`（默认）：真半透明，macOS 用 `under-window` vibrancy 让桌面壁纸做底。
 * - `ready-glass`（可选）：Ready 自己持有稳定底色（`.ready-app-bg` 渐变），不使用 macOS vibrancy。
 *
 * 注意：DOM 层始终设 `data-skin='liquid-glass'`（与现有玻璃面板 selector 兼容），
 * 两种风格的差异通过 `data-glass-backdrop` ∈ `{native, ready}` 区分。
 */
export type ThemeSkin = 'liquid-glass' | 'ready-glass'

interface ThemeState {
    theme: ThemeOption
    resolvedTheme: ResolvedTheme
    skin: ThemeSkin
    accent: ThemeAccent
    setTheme: (theme: ThemeOption) => void
    toggleTheme: () => void
    setSkin: (skin: ThemeSkin) => void
    toggleSkin: () => void
    setAccent: (accent: ThemeAccent) => void
}

// Read initial theme from localStorage
const getStoredTheme = (): ThemeOption => {
    const stored = readStorage('ready-theme')
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
    return 'light'
}

const getStoredSkin = (): ThemeSkin => {
    const stored = readStorage('ready-theme-skin')
    if (stored === 'liquid-glass' || stored === 'ready-glass') return stored
    return 'liquid-glass'
}

const getStoredAccent = (): ThemeAccent => {
    const stored = readStorage('ready-theme-accent')
    if (stored === 'blue' || stored === 'green' || stored === 'purple' || stored === 'orange') return stored
    return 'blue'
}

const accentPalettes: Record<ThemeAccent, Record<ResolvedTheme, { color: string; light: string }>> = {
    blue: {
        light: { color: '#5B8DEF', light: 'rgba(91, 141, 239, 0.1)' },
        dark: { color: '#6B9BFF', light: 'rgba(107, 155, 255, 0.15)' },
    },
    green: {
        light: { color: '#34D399', light: 'rgba(52, 211, 153, 0.1)' },
        dark: { color: '#3EE8A8', light: 'rgba(62, 232, 168, 0.15)' },
    },
    purple: {
        light: { color: '#8B5CF6', light: 'rgba(139, 92, 246, 0.1)' },
        dark: { color: '#9B6CFF', light: 'rgba(155, 108, 255, 0.15)' },
    },
    orange: {
        light: { color: '#E97A2B', light: 'rgba(233, 122, 43, 0.1)' },
        dark: { color: '#F08A3B', light: 'rgba(240, 138, 59, 0.15)' },
    },
}

const applyAccent = (accent: ThemeAccent, resolved: ResolvedTheme) => {
    if (typeof document === 'undefined') return
    const palette = accentPalettes[accent][resolved]
    const root = document.documentElement
    root.setAttribute('data-accent', accent)
    root.style.setProperty('--color-blue', palette.color)
    root.style.setProperty('--color-blue-light', palette.light)
    root.style.setProperty('--accent-primary', palette.color)
    root.style.setProperty('--accent-primary-light', palette.light)
}

const syncNativeSkin = (skin: ThemeSkin) => {
    if (typeof window !== 'undefined' && window.electronAPI?.theme?.setSkin) {
        // fire-and-forget: native vibrancy update; renderer-side CSS already applied the skin, so a missed native sync only affects window-chrome material until the next setSkin call.
        window.electronAPI.theme.setSkin(skin).catch(() => { /* ignore in browser-only dev */ })
    }
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

/**
 * 把 skin 状态应用到 DOM。
 *
 * - `data-skin` 永远是 `'liquid-glass'`：兼容现有 CSS selector（`html[data-skin='liquid-glass']
 *   .glass-surface-*` 等数百条规则），避免大规模重写。
 * - `data-glass-backdrop` 才是真正区分两种风格的开关：
 *   - `'native'`（默认）：使用 macOS vibrancy + 透明窗口（真半透明）
 *   - `'ready'`：Ready 自持稳定底（`.ready-app-bg` 渐变层可见）
 *
 * CSS 用 `[data-glass-backdrop='native']` / `[data-glass-backdrop='ready']` 修饰符选区分。
 */
const applySkin = (skin: ThemeSkin) => {
    const root = document.documentElement
    root.setAttribute('data-skin', 'liquid-glass')
    root.setAttribute('data-glass-backdrop', skin === 'ready-glass' ? 'ready' : 'native')
}

export const useTheme = create<ThemeState>((set, get) => {
    // Apply initial theme on load
    const initial = getStoredTheme()
    const initialSkin = getStoredSkin()
    const initialAccent = getStoredAccent()
    const resolved = resolveTheme(initial)
    applyColorTheme(resolved, initial, resolved, { animate: false })
    applySkin(initialSkin)
    applyAccent(initialAccent, resolved)

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleSystemChange = () => {
        const state = get()
        if (state.theme === 'system') {
            const newResolved = resolveTheme('system')
            applyColorTheme(newResolved, 'system', state.resolvedTheme, { animate: false })
            applyAccent(state.accent, newResolved)
            set({ resolvedTheme: newResolved })
        }
    }
    mediaQuery.addEventListener('change', handleSystemChange)

    return {
        theme: initial,
        resolvedTheme: resolved,
        skin: initialSkin,
        accent: initialAccent,
        setTheme: (theme) => {
            const prevResolved = get().resolvedTheme
            const newResolved = resolveTheme(theme)
            applyColorTheme(newResolved, theme, prevResolved)
            applyAccent(get().accent, newResolved)
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
            applyAccent(state.accent, next)
            writeStorage('ready-theme', next)
            set({ theme: next, resolvedTheme: next })
        },
        setSkin: (skin) => {
            applySkin(skin)
            syncNativeSkin(skin)
            writeStorage('ready-theme-skin', skin)
            set({ skin })
        },
        toggleSkin: () => {
            const next: ThemeSkin = get().skin === 'liquid-glass' ? 'ready-glass' : 'liquid-glass'
            applySkin(next)
            syncNativeSkin(next)
            writeStorage('ready-theme-skin', next)
            set({ skin: next })
        },
        setAccent: (accent) => {
            applyAccent(accent, get().resolvedTheme)
            writeStorage('ready-theme-accent', accent)
            set({ accent })
        },
    }
})
