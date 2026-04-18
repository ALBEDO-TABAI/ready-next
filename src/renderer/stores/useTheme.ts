import { create } from 'zustand'
import { readStorage, writeStorage } from '../utils/storage'
import { withRitual } from '../modules/overlay/useRitualOverlay'

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

const applyColorTheme = (
    resolved: ResolvedTheme,
    option: ThemeOption,
    currentResolved: ResolvedTheme,
    { animate = true }: { animate?: boolean } = {},
) => {
    if (typeof document === 'undefined') return

    if (!animate || typeof window === 'undefined' || resolved === currentResolved) {
        applyThemeImmediate(resolved, option)
        return
    }

    const direction = resolved === 'dark' ? 'to-dark' : 'to-light'
    void withRitual('theme-transition', ({ signalReady }) => {
        applyThemeImmediate(resolved, option)
        signalReady()
    }, { meta: { direction } }).catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        applyThemeImmediate(resolved, option)
    })
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
            // Cycle: light -> dark -> system -> light
            const next: ThemeOption =
                state.theme === 'light' ? 'dark' :
                state.theme === 'dark' ? 'system' : 'light'
            const newResolved = resolveTheme(next)
            applyColorTheme(newResolved, next, state.resolvedTheme)
            writeStorage('ready-theme', next)
            set({ theme: next, resolvedTheme: newResolved })
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
