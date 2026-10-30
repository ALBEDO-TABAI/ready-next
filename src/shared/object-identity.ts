export type PortableIdentityResult =
  | { ok: true; objectId: string; portable: true }
  | { ok: false; objectId: string; portable: false; code: 'version_conflict' | 'dirty_conflict' | 'operation_failed' | 'write_failed' | 'readback_mismatch' | 'identity_conflict' | 'not_markdown' | 'not_present'; message: string }
