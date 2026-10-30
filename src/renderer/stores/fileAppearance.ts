export const FILE_APPEARANCE_COLORS = [
  { key: 'red', label: '红色', value: '#ff453a' },
  { key: 'orange', label: '橙色', value: '#ff9f0a' },
  { key: 'yellow', label: '黄色', value: '#ffd60a' },
  { key: 'green', label: '绿色', value: '#30d158' },
  { key: 'blue', label: '蓝色', value: '#0a84ff' },
  { key: 'purple', label: '紫色', value: '#bf5af2' },
  { key: 'gray', label: '灰色', value: '#8e8e93' },
] as const

export type FileAppearanceColor = typeof FILE_APPEARANCE_COLORS[number]['key']

export interface FileAppearance {
  color?: FileAppearanceColor
  icon?: string
}

export type FileAppearanceMap = Record<string, FileAppearance>

const FILE_APPEARANCE_COLOR_KEYS = new Set<string>(
  FILE_APPEARANCE_COLORS.map((color) => color.key),
)

export function isFileAppearanceColor(value: unknown): value is FileAppearanceColor {
  return typeof value === 'string' && FILE_APPEARANCE_COLOR_KEYS.has(value)
}

export function getFileAppearanceColorValue(color?: FileAppearanceColor | null): string | null {
  return FILE_APPEARANCE_COLORS.find((entry) => entry.key === color)?.value ?? null
}

export function normalizeFileAppearanceIcon(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return Array.from(trimmed).slice(0, 4).join('')
}

function normalizeFileAppearanceEntry(value: unknown): FileAppearance | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const color = isFileAppearanceColor(source.color) ? source.color : undefined
  const icon = normalizeFileAppearanceIcon(source.icon) ?? undefined
  if (!color && !icon) return null
  return {
    ...(color ? { color } : {}),
    ...(icon ? { icon } : {}),
  }
}

export function normalizeFileAppearanceMap(value: unknown): FileAppearanceMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const next: FileAppearanceMap = {}
  for (const [path, appearance] of Object.entries(value as Record<string, unknown>)) {
    if (!path) continue
    const normalized = normalizeFileAppearanceEntry(appearance)
    if (normalized) next[path] = normalized
  }
  return next
}

function withoutEmptyEntry(map: FileAppearanceMap, path: string, entry: FileAppearance): FileAppearanceMap {
  const next = { ...map }
  const normalizedEntry = normalizeFileAppearanceEntry(entry)
  if (normalizedEntry) {
    next[path] = normalizedEntry
  } else {
    delete next[path]
  }
  return next
}

export function withFileAppearanceColor(
  map: FileAppearanceMap,
  path: string,
  color: FileAppearanceColor | null,
): FileAppearanceMap {
  if (!path) return map
  const current = map[path] ?? {}
  return withoutEmptyEntry(map, path, {
    ...current,
    color: color ?? undefined,
  })
}

export function withFileAppearanceIcon(
  map: FileAppearanceMap,
  path: string,
  icon: string | null,
): FileAppearanceMap {
  if (!path) return map
  const current = map[path] ?? {}
  return withoutEmptyEntry(map, path, {
    ...current,
    icon: normalizeFileAppearanceIcon(icon) ?? undefined,
  })
}

export function clearFileAppearanceForPath(map: FileAppearanceMap, path: string): FileAppearanceMap {
  if (!path || !map[path]) return map
  const next = { ...map }
  delete next[path]
  return next
}

function isSameOrDescendantPath(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`) || path.startsWith(`${ancestor}\\`)
}

export function removeFileAppearancePath(map: FileAppearanceMap, path: string): FileAppearanceMap {
  if (!path) return map
  let changed = false
  const next: FileAppearanceMap = {}
  for (const [entryPath, appearance] of Object.entries(map)) {
    if (isSameOrDescendantPath(entryPath, path)) {
      changed = true
      continue
    }
    next[entryPath] = appearance
  }
  return changed ? next : map
}
