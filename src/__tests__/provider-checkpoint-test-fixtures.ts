import { createRequire } from 'node:module'

import type { DatabaseConnection } from '../main/modules/database/connection'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { buildPreparedSkillTurnTruth } from '../main/modules/agent-control/skills/prepared-skill-turn'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import {
  KIMI_K3_SESSION_IDENTITY,
  KIMI_K3_SESSION_IDENTITY_FIELD,
} from '../shared/ai-providers/kimi-k3'

type SqliteCtor = new (path: string) => DatabaseConnection & MigrationDatabase
const require = createRequire(import.meta.url)

export function openProviderCheckpointTestDb(): DatabaseConnection & MigrationDatabase {
  const mod = require('better-sqlite3') as SqliteCtor & { default?: SqliteCtor }
  const Sqlite = mod.default || mod
  const db = new Sqlite(':memory:')
  runMigrations(db)
  return db
}

export function providerCheckpointExecutionBinding(runId: string) {
  return {
    schemaVersion: 1 as const,
    runId,
    ownerAgentIdAtStart: 'butler',
    runOrigin: 'initial' as const,
    kind: 'registered_agent' as const,
    requestedAgentId: 'butler',
    effectiveAgentId: 'butler',
    executionMaterialHash: 'butler-material-hash',
    ownerAssignmentSource: 'conversation_active' as const,
    executionSelectionSource: 'task_owner' as const,
    resolutionKind: 'direct' as const,
  }
}

export function providerCheckpointPreparedSkill() {
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  return buildPreparedSkillTurnTruth({
    identity: { mode: 'none', reason: 'no_skill_signal' },
    authorization,
    requestOrResourceAnchorDigest: 'request-anchor-digest',
    floors: { toolNames: new Set(), reasons: [] },
    surface: { composition: 'additive', exclusiveScopeRef: null },
  })
}

export function kimiK3ProviderTestData(turn: number) {
  return {
    [KIMI_K3_SESSION_IDENTITY_FIELD]: KIMI_K3_SESSION_IDENTITY,
    anthropicThinkingBlocks: [{
      type: 'thinking',
      thinking: `reasoning-${turn}`,
      signature: `sig-k3-${turn}`,
    }],
  }
}
