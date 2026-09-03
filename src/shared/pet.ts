export type PetAnimationState =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

export const PET_ANIMATION_FRAME_COUNTS: Record<PetAnimationState, number> = {
  idle: 6,
  'running-right': 8,
  'running-left': 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6,
}

export type PetSize = 'small' | 'medium' | 'large'
export type PetSource = 'builtin' | 'codex'

export interface PetCustomMeta {
  displayName?: string
  description?: string
}

export interface PetWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PetSettings {
  enabled: boolean
  selectedPetId: string
  bubbleEnabled: boolean
  alwaysOnTop: boolean
  size: PetSize
  windowBounds: PetWindowBounds | null
  customPetMeta: Record<string, PetCustomMeta>
}

export interface PetDefinition {
  id: string
  displayName: string
  description: string
  spritesheetUrl: string
  spritesheetPath: string
  source: PetSource
  available: boolean
}

export interface PetActivityEvent {
  id: string
  kind: 'call' | 'result' | 'status'
  text: string
  timestamp: string
}

export interface PetActivitySnapshot {
  revision: number
  kind: 'needs_input' | 'blocked' | 'ready' | 'running' | 'idle'
  taskId: string | null
  scopeId: string | null
  runId: string | null
  messageId: string | null
  busy: boolean
  state: PetAnimationState
  title: string
  summary: string
  events: PetActivityEvent[]
  updatedAt: string | null
}

export interface PetActivityOpenIdentity {
  revision: number
  taskId: string
  scopeId: string
  runId: string
  messageId: string | null
  updatedAt: string
}

export type PetStickyNoteTone = 'default' | 'info' | 'success' | 'warning' | 'danger'

export interface PetStickyNote {
  id: string
  title?: string
  body: string
  tone: PetStickyNoteTone
  createdAt: string
}

export interface PetStickyNoteInput {
  id?: string
  title?: string
  body: string
  tone?: PetStickyNoteTone
}

export interface PetWindowSnapshot {
  revision: number
  settings: PetSettings
  pets: PetDefinition[]
  activity: PetActivitySnapshot
  stickyNotes: PetStickyNote[]
  stickyNotesDigest: string
}

export const DEFAULT_SELECTED_PET_ID = 'white-chinchilla-cat'

export const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: false,
  selectedPetId: DEFAULT_SELECTED_PET_ID,
  bubbleEnabled: true,
  alwaysOnTop: true,
  size: 'medium',
  windowBounds: null,
  customPetMeta: {},
}
