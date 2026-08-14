export function persistableCalendarEventId(id: string | null | undefined): string | null {
  const raw = String(id || '').trim()
  if (!raw) return null
  const hash = raw.indexOf('#')
  const persistable = hash === -1 ? raw : raw.slice(0, hash)
  return persistable.trim() || null
}
