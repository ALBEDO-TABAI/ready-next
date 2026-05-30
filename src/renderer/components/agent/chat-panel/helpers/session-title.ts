// Placeholder titles a freshly-created scope carries before its first message
// is sent (see useAgent: scopes seed with '新对话', and the auto-title pass only
// rewrites '新对话'/'未命名会话'). Treat them as "no title yet" so the header
// stays blank until the user actually starts a conversation.
const PLACEHOLDER_SESSION_TITLES = new Set(['新对话', '未命名会话'])

// Title to show in the chat header for the current scope. Returns '' (render
// nothing) for an absent, blank, or still-placeholder title; otherwise the
// trimmed title.
export function resolveChatSessionTitle(title?: string | null): string {
  const trimmed = String(title ?? '').trim()
  if (!trimmed) return ''
  if (PLACEHOLDER_SESSION_TITLES.has(trimmed)) return ''
  return trimmed
}
