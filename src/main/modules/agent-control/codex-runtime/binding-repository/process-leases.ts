import { CodexBindingRepositoryError } from '../codex-binding-error'
import type { CodexBindingContext } from './context'
import { requireProcessLease } from './core'
import { changes, nonEmpty, processLeaseFromRow, safePositive } from './shared'
import type { CodexProcessLeaseIdentity, CodexProcessLeaseRow, ProcessLeaseDbRow } from './types'

// The sidecar process lease: intent, ownership, connection and process-tree evidence.

export function createProcessLeaseIntent(context: CodexBindingContext, input: CodexProcessLeaseIdentity & {
  spawnIntentAt: string
  spawnVisibilityDeadlineAt: string
}): CodexProcessLeaseRow {
  assertDistinctProcessIdentities(context, input)
  return context.immediate(() => {
    context.db.prepare(`
        INSERT INTO codex_sidecar_process_leases (
          process_lease_id, singleton_slot, owner_main_boot_id, owner_main_pid,
          owner_main_process_start_identity, sidecar_spawn_instance_id, connection_epoch,
          runtime_manifest_digest, binary_sha256, executable_path, isolated_state_dir,
          spawn_intent_at, spawn_visibility_deadline_at, revision
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
      input.processLeaseId,
      input.ownerMainBootId,
      input.ownerMainPid,
      input.ownerMainProcessStartIdentity,
      input.sidecarSpawnInstanceId,
      input.connectionEpoch,
      input.runtimeManifestDigest,
      input.binarySha256,
      input.executablePath,
      input.isolatedStateDir,
      input.spawnIntentAt,
      input.spawnVisibilityDeadlineAt,
    )
    return requireProcessLease(context, input.processLeaseId)
  })
}

export function confirmProcessLeaseOwnership(context: CodexBindingContext, input: {
  processLeaseId: string
  expectedRevision: number
  pid: number
  processGroupId: number
  processStartIdentity: string
  confirmedAt: string
}): CodexProcessLeaseRow {
  safePositive(input.pid, 'sidecar_pid_invalid')
  safePositive(input.processGroupId, 'sidecar_process_group_invalid')
  nonEmpty(input.processStartIdentity, 'sidecar_process_start_identity_invalid')
  return context.immediate(() => {
    const result = context.db.prepare(`
        UPDATE codex_sidecar_process_leases
           SET pid = ?, process_group_id = ?, process_start_identity = ?,
               ownership_confirmed_at = ?, revision = revision + 1
         WHERE process_lease_id = ? AND revision = ?
           AND pid IS NULL AND ownership_confirmed_at IS NULL AND tree_zero_at IS NULL
      `).run(
      input.pid,
      input.processGroupId,
      input.processStartIdentity,
      input.confirmedAt,
      input.processLeaseId,
      input.expectedRevision,
    )
    if (changes(result) !== 1) throw new CodexBindingRepositoryError('process_lease_ownership_cas_failed')
    return requireProcessLease(context, input.processLeaseId)
  })
}

export function markProcessConnectionOpened(context: CodexBindingContext, input: {
  processLeaseId: string
  expectedRevision: number
  openedAt: string
}): CodexProcessLeaseRow {
  return updateProcessLease(
    context,
    input.processLeaseId,
    input.expectedRevision,
    'connection_opened_at = ?',
    [input.openedAt],
    'connection_opened_at IS NULL AND ownership_confirmed_at IS NOT NULL',
  )
}

export function markProcessConnectionClosed(context: CodexBindingContext, input: {
  processLeaseId: string
  expectedRevision: number
  closedAt: string
}): CodexProcessLeaseRow {
  return updateProcessLease(
    context,
    input.processLeaseId,
    input.expectedRevision,
    'closed_at = ?',
    [input.closedAt],
    'closed_at IS NULL AND tree_zero_at IS NULL',
  )
}

export function recordOldMainDeath(context: CodexBindingContext, input: {
  processLeaseId: string
  expectedRevision: number
  deadAt: string
  evidenceDigest: string
}): CodexProcessLeaseRow {
  return updateProcessLease(
    context,
    input.processLeaseId,
    input.expectedRevision,
    'owner_main_dead_at = ?, owner_main_death_evidence_digest = ?',
    [input.deadAt, input.evidenceDigest],
    'owner_main_dead_at IS NULL',
  )
}

export function recordProcessTreeZero(context: CodexBindingContext, input: {
  processLeaseId: string
  expectedRevision: number
  treeZeroAt: string
  matcherMode: 'pre_cas' | 'post_cas'
  sampleTranscriptDigest: string
  evidenceDigest: string
}): CodexProcessLeaseRow {
  return updateProcessLease(
    context,
    input.processLeaseId,
    input.expectedRevision,
    `tree_zero_at = ?, tree_zero_matcher_mode = ?,
       stable_zero_sample_transcript_digest = ?, tree_zero_evidence_digest = ?`,
    [
      input.treeZeroAt,
      input.matcherMode,
      input.sampleTranscriptDigest,
      input.evidenceDigest,
    ],
    'tree_zero_at IS NULL',
  )
}

export function readLiveProcessLease(context: CodexBindingContext): CodexProcessLeaseRow | null {
  const row = context.db.prepare(`
      SELECT * FROM codex_sidecar_process_leases WHERE tree_zero_at IS NULL LIMIT 1
    `).get<ProcessLeaseDbRow>()
  return row ? processLeaseFromRow(row) : null
}

export function readProcessLeaseByConnectionEpoch(context: CodexBindingContext, connectionEpoch: string): CodexProcessLeaseRow | null {
  nonEmpty(connectionEpoch, 'connection_epoch_invalid')
  const row = context.db.prepare(`
      SELECT * FROM codex_sidecar_process_leases
       WHERE connection_epoch = ? LIMIT 1
    `).get<ProcessLeaseDbRow>(connectionEpoch)
  return row ? processLeaseFromRow(row) : null
}

export function readLatestProcessLeaseByOwnerMainBootId(context: CodexBindingContext, ownerMainBootId: string): CodexProcessLeaseRow | null {
  nonEmpty(ownerMainBootId, 'owner_main_boot_id_invalid')
  const row = context.db.prepare(`
      SELECT * FROM codex_sidecar_process_leases
       WHERE owner_main_boot_id = ?
       ORDER BY spawn_intent_at DESC LIMIT 1
    `).get<ProcessLeaseDbRow>(ownerMainBootId)
  return row ? processLeaseFromRow(row) : null
}

export function assertDistinctProcessIdentities(context: CodexBindingContext, input: CodexProcessLeaseIdentity): void {
  const identities = [
    input.ownerMainBootId,
    input.sidecarSpawnInstanceId,
    input.connectionEpoch,
  ]
  identities.forEach((value) => nonEmpty(value, 'process_identity_invalid'))
  if (new Set(identities).size !== identities.length) {
    throw new CodexBindingRepositoryError('process_identity_reused')
  }
  safePositive(input.ownerMainPid, 'owner_main_pid_invalid')
  for (const value of [
    input.processLeaseId,
    input.ownerMainProcessStartIdentity,
    input.runtimeManifestDigest,
    input.binarySha256,
    input.executablePath,
    input.isolatedStateDir,
  ]) nonEmpty(value, 'process_lease_identity_invalid')
}

export function updateProcessLease(
  context: CodexBindingContext,
  processLeaseId: string,
  expectedRevision: number,
  assignments: string,
  values: unknown[],
  condition: string,
): CodexProcessLeaseRow {
  return context.immediate(() => {
    const result = context.db.prepare(`
        UPDATE codex_sidecar_process_leases
           SET ${assignments}, revision = revision + 1
         WHERE process_lease_id = ? AND revision = ? AND ${condition}
      `).run(...values, processLeaseId, expectedRevision)
    if (changes(result) !== 1) throw new CodexBindingRepositoryError('process_lease_cas_failed')
    return requireProcessLease(context, processLeaseId)
  })
}
