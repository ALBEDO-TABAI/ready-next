// Ready Next shell geometry (W2 §2, W1 DL11/DL11a): icon rail, one sidebar slot, content, assistant,
// with equal top and bottom bands. Shared so Main can size the window and Renderer can lay it out.

export const SHELL_RAIL_WIDTH = 52
/** Top and bottom bands are equally tall (DL11a) and as tall as the rail is wide. */
export const SHELL_BAND_HEIGHT = 52
export const SHELL_SIDEBAR_WIDTH = { default: 248, min: 200, max: 420 } as const
export const SHELL_ASSISTANT_WIDTH = { default: 380, min: 320, max: 560 } as const
/** The content column never gets narrower than this (G1, W2 §2.5). */
export const SHELL_CONTENT_MIN_WIDTH = 560
/** The window stops shrinking here: rail plus the minimum content column. */
export const SHELL_WINDOW_MIN_WIDTH = SHELL_RAIL_WIDTH + SHELL_CONTENT_MIN_WIDTH

/**
 * docked   — takes its own column beside the content;
 * floating — the assistant becomes a drawer over the content, the sidebar slides out on hover;
 * hidden   — collapsed by the user.
 */
export type ShellDock = 'docked' | 'floating' | 'hidden'

export interface ShellLayoutInput {
  windowWidth: number
  sidebarOpen: boolean
  sidebarWidth: number
  assistantOpen: boolean
  assistantWidth: number
}

export interface ShellLayout {
  sidebar: ShellDock
  assistant: ShellDock
  sidebarWidth: number
  assistantWidth: number
  /** Width left for the content column (rail and docked columns removed). */
  contentWidth: number
}

const clamp = (value: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, value))

/**
 * When the window is too narrow, space is given up in a fixed order (W2 §2.5): first the assistant
 * turns into a drawer over the content, then the sidebar turns into a slide-out; the content column
 * itself never shrinks below SHELL_CONTENT_MIN_WIDTH while either can still give way.
 */
export function resolveShellLayout(input: ShellLayoutInput): ShellLayout {
  const sidebarWidth = clamp(input.sidebarWidth, SHELL_SIDEBAR_WIDTH)
  const assistantWidth = clamp(input.assistantWidth, SHELL_ASSISTANT_WIDTH)
  let sidebar: ShellDock = input.sidebarOpen ? 'docked' : 'hidden'
  let assistant: ShellDock = input.assistantOpen ? 'docked' : 'hidden'
  const contentWidth = () => input.windowWidth
    - SHELL_RAIL_WIDTH
    - (sidebar === 'docked' ? sidebarWidth : 0)
    - (assistant === 'docked' ? assistantWidth : 0)
  if (contentWidth() < SHELL_CONTENT_MIN_WIDTH && assistant === 'docked') assistant = 'floating'
  if (contentWidth() < SHELL_CONTENT_MIN_WIDTH && sidebar === 'docked') sidebar = 'floating'
  return { sidebar, assistant, sidebarWidth, assistantWidth, contentWidth: contentWidth() }
}

/** Rounds a stored or dragged width into the sidebar range; non-numbers fall back to the minimum. */
export function clampSidebarWidth(width: number): number {
  return Number.isFinite(width) ? clamp(Math.round(width), SHELL_SIDEBAR_WIDTH) : SHELL_SIDEBAR_WIDTH.min
}

/** Rounds a stored or dragged width into the assistant range; non-numbers fall back to the default. */
export function clampAssistantWidth(width: number): number {
  return Number.isFinite(width) ? clamp(Math.round(width), SHELL_ASSISTANT_WIDTH) : SHELL_ASSISTANT_WIDTH.default
}
