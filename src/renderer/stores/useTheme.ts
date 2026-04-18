import { create } from 'zustand'
import { readStorage, writeStorage } from '../utils/storage'

export type ThemeOption = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export type ThemeSkin = 'liquid-glass'

const THEME_TRANSITION_ATTRIBUTE = 'data-theme-transitioning'
const THEME_TRANSITION_DURATION_MS = 220

let themeDomFrameId: number | null = null
let themeNativeFrameId: number | null = null
let themeTransitionTimerId: number | null = null
let themeTransitionToken = 0

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

const clearThemeTransitionWork = () => {
    if (typeof window === 'undefined') return
    if (themeDomFrameId !== null) {
        window.cancelAnimationFrame(themeDomFrameId)
        themeDomFrameId = null
    }
    if (themeNativeFrameId !== null) {
        window.cancelAnimationFrame(themeNativeFrameId)
        themeNativeFrameId = null
    }
    if (themeTransitionTimerId !== null) {
        window.clearTimeout(themeTransitionTimerId)
        themeTransitionTimerId = null
    }
}

const syncNativeTheme = (option: ThemeOption) => {
    if (typeof window !== 'undefined' && window.electronAPI?.theme) {
        window.electronAPI.theme.set(option).catch(() => { /* ignore in browser-only dev */ })
    }
}

const applyColorTheme = (
    resolved: ResolvedTheme,
    option: ThemeOption,
    { animate = true }: { animate?: boolean } = {},
) => {
    if (typeof document === 'undefined') return

    const root = document.documentElement
    clearThemeTransitionWork()

    if (!animate || typeof window === 'undefined') {
        root.removeAttribute(THEME_TRANSITION_ATTRIBUTE)
        root.setAttribute('data-theme', resolved)
        syncNativeTheme(option)
        return
    }

    const transitionToken = ++themeTransitionToken
    root.setAttribute(THEME_TRANSITION_ATTRIBUTE, 'true')

    themeDomFrameId = requestAnimationFrame(() => {
        if (transitionToken !== themeTransitionToken) return
        themeDomFrameId = null
        document.documentElement.setAttribute('data-theme', resolved)

        themeNativeFrameId = requestAnimationFrame(() => {
            if (transitionToken !== themeTransitionToken) return
            themeNativeFrameId = null
            if (window.electronAPI?.theme) {
                window.electronAPI.theme.set(option).catch(() => { /* ignore in browser-only dev */ })
            }

            themeTransitionTimerId = window.setTimeout(() => {
                if (transitionToken !== themeTransitionToken) return
                themeTransitionTimerId = null
                document.documentElement.removeAttribute(THEME_TRANSITION_ATTRIBUTE)
            }, THEME_TRANSITION_DURATION_MS)
        })
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
    applyColorTheme(resolved, initial, { animate: false })
    applySkin(initialSkin)

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleSystemChange = () => {
        const state = get()
        if (state.theme === 'system') {
            const newResolved = resolveTheme('system')
            applyColorTheme(newResolved, 'system', { animate: false })
            set({ resolvedTheme: newResolved })
        }
    }
    mediaQuery.addEventListener('change', handleSystemChange)

    return {
        theme: initial,
        resolvedTheme: resolved,
        skin: initialSkin,
        setTheme: (theme) => {
            const newResolved = resolveTheme(theme)
            applyColorTheme(newResolved, theme)
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
            applyColorTheme(newResolved, next)
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
