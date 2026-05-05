import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_PET_SETTINGS, DEFAULT_SELECTED_PET_ID } from '../../../shared/pet'
import type { PetCustomMeta, PetDefinition, PetSettings, PetSize, PetWindowBounds } from '../../../shared/pet'

export { DEFAULT_PET_SETTINGS, DEFAULT_SELECTED_PET_ID }

interface RawPetJson {
  id?: unknown
  displayName?: unknown
  description?: unknown
  spritesheetPath?: unknown
}

export const PET_SETTINGS_KEY = 'desktop_pet_settings'
export const DEFAULT_PETS_ROOT = join(homedir(), '.codex', 'pets')

const READY_DEFAULT_PET_NAMES: Record<string, string> = {
  'white-chinchilla-cat': '奶油',
  'cream-gold-cat': '奶茶',
  'tortoiseshell-cat': '多多',
  'orange-close-cat': '弟弟',
  'silver-tabby-cat': '香香',
  'bowl-orange-cat': '鸡腿',
  'white-gold-cat': '雪糕',
}

function isPetSize(value: unknown): value is PetSize {
  return value === 'small' || value === 'medium' || value === 'large'
}

function normalizeBounds(value: unknown): PetWindowBounds | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const x = Number(record.x)
  const y = Number(record.y)
  const width = Number(record.width)
  const height = Number(record.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  return { x, y, width, height }
}

function normalizeCustomMeta(value: unknown): Record<string, PetCustomMeta> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, PetCustomMeta> = {}
  for (const [id, meta] of Object.entries(value as Record<string, unknown>)) {
    if (!meta || typeof meta !== 'object') continue
    const record = meta as Record<string, unknown>
    const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : ''
    const description = typeof record.description === 'string' ? record.description.trim() : ''
    result[id] = {
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
    }
  }
  return result
}

export function normalizePetSettings(raw: unknown): PetSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PET_SETTINGS }
  const record = raw as Record<string, unknown>
  const selectedPetId = typeof record.selectedPetId === 'string' && record.selectedPetId.trim()
    ? record.selectedPetId.trim()
    : DEFAULT_SELECTED_PET_ID

  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_PET_SETTINGS.enabled,
    selectedPetId,
    bubbleEnabled: typeof record.bubbleEnabled === 'boolean' ? record.bubbleEnabled : DEFAULT_PET_SETTINGS.bubbleEnabled,
    alwaysOnTop: typeof record.alwaysOnTop === 'boolean' ? record.alwaysOnTop : DEFAULT_PET_SETTINGS.alwaysOnTop,
    size: isPetSize(record.size) ? record.size : DEFAULT_PET_SETTINGS.size,
    windowBounds: normalizeBounds(record.windowBounds),
    customPetMeta: normalizeCustomMeta(record.customPetMeta),
  }
}

function pathToLocalFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href.replace(/^file:/, 'local-file:')
}

function fallbackNameFromId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function readPetDefinition(dir: string, customPetMeta: Record<string, PetCustomMeta>, source: PetDefinition['source']): PetDefinition | null {
  const jsonPath = join(dir, 'pet.json')
  if (!existsSync(jsonPath)) return null

  let raw: RawPetJson
  try {
    raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as RawPetJson
  } catch {
    const id = basename(dir)
    return {
      id,
      displayName: customPetMeta[id]?.displayName || READY_DEFAULT_PET_NAMES[id] || fallbackNameFromId(id),
      description: customPetMeta[id]?.description || '宠物资源无法读取。',
      spritesheetPath: join(dir, 'spritesheet.webp'),
      spritesheetUrl: '',
      source,
      available: false,
    }
  }

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : basename(dir)
  const spritesheetRel = typeof raw.spritesheetPath === 'string' && raw.spritesheetPath.trim()
    ? raw.spritesheetPath.trim()
    : 'spritesheet.webp'
  const spritesheetPath = resolve(dir, spritesheetRel)
  const available = existsSync(spritesheetPath)
  const custom = customPetMeta[id] || {}
  const defaultName = READY_DEFAULT_PET_NAMES[id] || (typeof raw.displayName === 'string' && raw.displayName.trim())
    || fallbackNameFromId(id)
  const defaultDescription = typeof raw.description === 'string' && raw.description.trim()
    ? raw.description.trim()
    : 'Ready 桌面宠物。'

  return {
    id,
    displayName: custom.displayName || defaultName,
    description: custom.description || defaultDescription,
    spritesheetPath,
    spritesheetUrl: available ? pathToLocalFileUrl(spritesheetPath) : '',
    source,
    available,
  }
}

export function resolvePetDefinitions({
  petsRoot = DEFAULT_PETS_ROOT,
  customPetMeta = {},
  source = 'codex',
}: {
  petsRoot?: string
  customPetMeta?: Record<string, PetCustomMeta>
  source?: PetDefinition['source']
} = {}): PetDefinition[] {
  if (!existsSync(petsRoot)) return []
  const dirs = readdirSync(petsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(petsRoot, entry.name))
    .sort((a, b) => basename(a).localeCompare(basename(b)))

  return dirs
    .map((dir) => readPetDefinition(dir, customPetMeta, source))
    .filter((pet): pet is PetDefinition => Boolean(pet))
}

export function serializePetSettings(settings: PetSettings): string {
  return JSON.stringify(normalizePetSettings(settings))
}

export function parseStoredPetSettings(raw: string | null | undefined): PetSettings {
  if (!raw) return { ...DEFAULT_PET_SETTINGS }
  try {
    return normalizePetSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_PET_SETTINGS }
  }
}
