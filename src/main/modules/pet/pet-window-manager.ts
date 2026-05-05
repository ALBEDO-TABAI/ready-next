import { BrowserWindow, screen, type Rectangle } from 'electron'
import { join, resolve } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type {
  PetActivitySnapshot,
  PetDefinition,
  PetSettings,
  PetStickyNote,
  PetStickyNoteInput,
  PetStickyNoteTone,
  PetWindowBounds,
  PetWindowSnapshot,
} from '../../../shared/pet'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import {
  DEFAULT_PET_SETTINGS,
  DEFAULT_PETS_ROOT,
  PET_SETTINGS_KEY,
  normalizePetSettings,
  parseStoredPetSettings,
  resolvePetDefinitions,
  serializePetSettings,
} from './pet-registry'

interface PetWindowManagerOptions {
  preloadPath: string
  rendererFile: string
  packaged: boolean
  resourcesPath: string
  ensureDockApp?: () => void
}

const PET_WINDOW_SIZE: Record<PetSettings['size'], { width: number; height: number }> = {
  small: { width: 300, height: 230 },
  medium: { width: 380, height: 292 },
  large: { width: 460, height: 360 },
}

const IDLE_ACTIVITY: PetActivitySnapshot = {
  busy: false,
  state: 'idle',
  title: '空闲',
  summary: '',
  events: [],
  updatedAt: null,
}

const MAX_STICKY_NOTES = 6
const STICKY_BODY_MAX_LENGTH = 1200
const STICKY_TITLE_MAX_LENGTH = 36
const STICKY_TONES: PetStickyNoteTone[] = ['default', 'info', 'success', 'warning', 'danger']

function normalizeStickyText(value: unknown, maxLength: number, preserveLines = false): string {
  const raw = String(value || '').replace(/\r\n/g, '\n')
  const normalized = preserveLines
    ? raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    : raw.replace(/\s+/g, ' ')
  return normalized.trim().slice(0, maxLength)
}

function makeStickyNote(input: PetStickyNoteInput): PetStickyNote {
  const body = normalizeStickyText(input.body, STICKY_BODY_MAX_LENGTH, true)
  if (!body) throw new Error('sticky note body is required')
  const title = normalizeStickyText(input.title, STICKY_TITLE_MAX_LENGTH)
  const tone = input.tone && STICKY_TONES.includes(input.tone) ? input.tone : 'default'
  return {
    id: normalizeStickyText(input.id, 64) || `sticky-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...(title ? { title } : {}),
    body,
    tone,
    createdAt: new Date().toISOString(),
  }
}

function getDefaultBounds(size: PetSettings['size']): PetWindowBounds {
  const { width, height } = PET_WINDOW_SIZE[size]
  const workArea = screen.getPrimaryDisplay().workArea
  return {
    width,
    height,
    x: Math.round(workArea.x + workArea.width - width - 32),
    y: Math.round(workArea.y + workArea.height - height - 44),
  }
}

function clampBounds(bounds: PetWindowBounds, workArea: Rectangle): PetWindowBounds {
  const width = Math.max(240, bounds.width)
  const height = Math.max(200, bounds.height)
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, workArea.x - width + 80), workArea.x + workArea.width - 80),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - 80),
  }
}

export class PetWindowManager {
  private readonly repository = new AppSettingsRepository()
  private readonly options: PetWindowManagerOptions
  private window: BrowserWindow | null = null
  private activity: PetActivitySnapshot = IDLE_ACTIVITY
  private stickyNotes: PetStickyNote[] = []

  constructor(options: PetWindowManagerOptions) {
    this.options = options
  }

  getSettings(): PetSettings {
    return parseStoredPetSettings(this.repository.getSetting(PET_SETTINGS_KEY))
  }

  saveSettings(settings: PetSettings): PetSettings {
    const normalized = normalizePetSettings(settings)
    this.repository.setSetting(PET_SETTINGS_KEY, serializePetSettings(normalized))
    return normalized
  }

  updateSettings(patch: Partial<PetSettings>): PetSettings {
    const current = this.getSettings()
    const next = this.saveSettings({
      ...current,
      ...patch,
      customPetMeta: patch.customPetMeta || current.customPetMeta,
    })
    this.window?.setAlwaysOnTop(next.alwaysOnTop, 'floating')
    if (next.enabled) {
      void this.show()
    } else {
      this.hide()
    }
    this.sendSnapshot()
    return next
  }

  listPets(): PetDefinition[] {
    const settings = this.getSettings()
    const customPetMeta = settings.customPetMeta
    const builtInRoot = this.options.packaged
      ? join(this.options.resourcesPath, 'pets')
      : resolve(__dirname, '../../assets/pets')
    const builtInPets = resolvePetDefinitions({ petsRoot: builtInRoot, customPetMeta, source: 'builtin' })
    const codexPets = resolvePetDefinitions({ petsRoot: DEFAULT_PETS_ROOT, customPetMeta, source: 'codex' })
    const merged = new Map<string, PetDefinition>()
    for (const pet of builtInPets) merged.set(pet.id, pet)
    for (const pet of codexPets) merged.set(pet.id, pet)
    return Array.from(merged.values())
  }

  getSnapshot(): PetWindowSnapshot {
    return {
      settings: this.getSettings(),
      pets: this.listPets(),
      activity: this.activity,
      stickyNotes: [...this.stickyNotes],
    }
  }

  async restoreIfEnabled(): Promise<void> {
    if (this.getSettings().enabled) await this.show()
  }

  async show(): Promise<void> {
    this.options.ensureDockApp?.()
    const settings = this.getSettings()
    const bounds = clampBounds(settings.windowBounds || getDefaultBounds(settings.size), screen.getPrimaryDisplay().workArea)
    const size = PET_WINDOW_SIZE[settings.size]
    const nextBounds = { ...bounds, width: size.width, height: size.height }

    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({
        ...nextBounds,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: true,
        hasShadow: false,
        skipTaskbar: process.platform !== 'darwin',
        alwaysOnTop: settings.alwaysOnTop,
        backgroundColor: '#00000000',
        fullscreenable: false,
        trafficLightPosition: { x: -1000, y: -1000 },
        webPreferences: {
          preload: this.options.preloadPath,
          sandbox: false,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })

      if (process.platform === 'darwin') {
        this.window.setWindowButtonVisibility(false)
      }
      this.window.setAlwaysOnTop(settings.alwaysOnTop, 'floating')
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      this.window.on('closed', () => {
        this.window = null
      })
      this.window.on('moved', () => this.persistWindowBounds())

      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        await this.window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/pet-window`)
      } else {
        await this.window.loadFile(this.options.rendererFile, { hash: '/pet-window' })
      }

      this.window.webContents.once('did-finish-load', () => {
        this.sendSnapshot()
      })
    } else {
      this.window.setBounds(nextBounds)
      this.window.setAlwaysOnTop(settings.alwaysOnTop, 'floating')
    }

    this.options.ensureDockApp?.()
    this.window.showInactive()
    this.sendSnapshot()
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.hide()
    }
  }

  resetPosition(): PetSettings {
    const settings = this.getSettings()
    const next = this.saveSettings({
      ...settings,
      windowBounds: getDefaultBounds(settings.size),
    })
    if (this.window && !this.window.isDestroyed()) {
      this.window.setBounds(next.windowBounds || getDefaultBounds(next.size))
    }
    this.sendSnapshot()
    return next
  }

  setPet(petId: string): PetSettings {
    return this.updateSettings({ selectedPetId: petId })
  }

  moveBy(delta: { dx: number; dy: number }): void {
    if (!this.window || this.window.isDestroyed()) return
    const [x, y] = this.window.getPosition()
    this.window.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy), false)
    this.persistWindowBounds()
  }

  updateActivity(snapshot: PetActivitySnapshot): void {
    this.activity = snapshot
    this.sendSnapshot()
  }

  pushStickyNote(input: PetStickyNoteInput): PetStickyNote {
    const note = makeStickyNote(input)
    this.stickyNotes = [note, ...this.stickyNotes.filter((item) => item.id !== note.id)].slice(0, MAX_STICKY_NOTES)
    this.sendSnapshot()
    return note
  }

  dismissStickyNote(id: string): boolean {
    const before = this.stickyNotes.length
    this.stickyNotes = this.stickyNotes.filter((note) => note.id !== id)
    const dismissed = before !== this.stickyNotes.length
    if (dismissed) this.sendSnapshot()
    return dismissed
  }

  clearStickyNotes(): void {
    if (this.stickyNotes.length === 0) return
    this.stickyNotes = []
    this.sendSnapshot()
  }

  private persistWindowBounds(): void {
    if (!this.window || this.window.isDestroyed()) return
    const bounds = this.window.getBounds()
    const settings = this.getSettings()
    this.saveSettings({ ...settings, windowBounds: bounds })
  }

  private sendSnapshot(): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('pet:snapshot', this.getSnapshot())
  }
}

export function createPetWindowManager(options: PetWindowManagerOptions): PetWindowManager {
  return new PetWindowManager(options)
}

export { DEFAULT_PET_SETTINGS, PET_SETTINGS_KEY }
export type { PetWindowSnapshot }
