import { create } from 'zustand'

export type ThemeOption = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export type ThemeSkin = 'classic' | 'liquid-glass'

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
    try {
        const stored = localStorage.getItem('ready-theme')
        if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
    } catch {
        // ignore storage access errors
    }
    return 'light'
}

const getStoredSkin = (): ThemeSkin => {
    try {
        const stored = localStorage.getItem('ready-theme-skin')
        if (stored === 'classic' || stored === 'liquid-glass') return stored
    } catch {
        // ignore storage access errors
    }
    return 'classic'
}

// Resolve the effective theme (system -> actual light/dark)
const resolveTheme = (theme: ThemeOption): ResolvedTheme => {
    if (theme === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return theme
}

// Apply theme to the DOM + sync to Electron main process (nativeTheme)
const applyColorTheme = (resolved: ResolvedTheme, option: ThemeOption) => {
    document.documentElement.setAttribute('data-theme', resolved)
    // Sync to Electron's nativeTheme so BrowserView web content respects prefers-color-scheme
    if (typeof window !== 'undefined' && window.electronAPI?.theme) {
        window.electronAPI.theme.set(option).catch(() => { /* ignore in browser-only dev */ })
    }
}

const applySkin = (skin: ThemeSkin) => {
    document.documentElement.setAttribute('data-skin', skin)
}

export const useTheme = create<ThemeState>((set, get) => {
    // Apply initial theme on load
    const initial = getStoredTheme()
    const initialSkin = getStoredSkin()
    const resolved = resolveTheme(initial)
    applyColorTheme(resolved, initial)
    applySkin(initialSkin)

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleSystemChange = () => {
        const state = get()
        if (state.theme === 'system') {
            const newResolved = resolveTheme('system')
            applyColorTheme(newResolved, 'system')
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
            localStorage.setItem('ready-theme', theme)
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
            localStorage.setItem('ready-theme', next)
            set({ theme: next, resolvedTheme: newResolved })
        },
        setSkin: (skin) => {
            applySkin(skin)
            localStorage.setItem('ready-theme-skin', skin)
            set({ skin })
        },
        toggleSkin: () => {
            const next: ThemeSkin = get().skin === 'classic' ? 'liquid-glass' : 'classic'
            applySkin(next)
            localStorage.setItem('ready-theme-skin', next)
            set({ skin: next })
        },
    }
})
