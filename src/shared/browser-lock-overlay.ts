export interface BrowserLockOverlayBounds {
  left: number
  top: number
  width: number
  height: number
}

export type BrowserLockOverlayKind =
  | 'agent-current'
  | 'agent-background'
  | 'pending-confirm'
  | 'frozen'
  | 'takeover'

export type BrowserLockOverlayTone = 'agent' | 'warning'

export interface BrowserLockOverlayProofMarker {
  enabled: boolean
  color: string
  samplePoint: { x: number; y: number }
}

export interface BrowserLockOverlaySnapshot {
  kind: BrowserLockOverlayKind
  label: string
  detail: string
  tone: BrowserLockOverlayTone
  bounds: BrowserLockOverlayBounds
  proof?: BrowserLockOverlayProofMarker | null
}

export interface BrowserLockOverlayIPCResult<T> {
  success: boolean
  data?: T
  error?: string
}
