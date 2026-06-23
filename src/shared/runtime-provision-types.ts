// Renderer-facing contracts for the one-click runtime provisioner. Shared so
// preload + renderer + main agree on one shape. Orchestration lives in
// main/modules/skills-runtime/runtime-provisioner.ts.

import type { ProvisionErrorKind } from './runtime-asset-registry'

export interface RuntimeComponentStatus {
  ready: boolean
  detail?: string
  path?: string
}

export interface RuntimeStatus {
  platformSupported: boolean
  python: RuntimeComponentStatus & { version?: string; sslOk?: boolean }
  ffmpeg: RuntimeComponentStatus & { archOk?: boolean }
  ffprobe: RuntimeComponentStatus
  coreDeps: RuntimeComponentStatus & { missing?: string[] }
  overallReady: boolean
}

export type RuntimeProvisionPhase =
  | 'probe' | 'download' | 'verify' | 'extract' | 'connect' | 'venv' | 'deps' | 'done'

export interface RuntimeProvisionProgress {
  assetId?: 'python' | 'ffmpeg'
  phase: RuntimeProvisionPhase
  receivedBytes?: number
  totalBytes?: number | null
  message?: string
}

export type RuntimeProvisionErrorKind =
  | ProvisionErrorKind
  | 'assets_not_pinned'
  | 'runtime_setup_failed'
  | 'cancelled'
