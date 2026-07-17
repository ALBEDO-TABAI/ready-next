export const RENDERER_STATE_FLUSH_TIMEOUT_MS = 5_000
export const RENDERER_STATE_FLUSH_LEASE_TIMEOUT_MS = RENDERER_STATE_FLUSH_TIMEOUT_MS + 1_000

export type RendererStateFlushOutcome =
  | { success: true }
  | { success: false; error: string }
