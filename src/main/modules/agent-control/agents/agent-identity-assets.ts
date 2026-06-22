import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, resolve, sep } from 'path'

import type { BeliefCardStore } from '../knowledge/belief-card-store'
import { isValidAgentSlug, type BuiltinAgentId } from '../../../../shared/agent-identity'
import {
  BUILTIN_AGENT_PRESETS,
  BUILTIN_AGENT_PRESET_VERSION,
  LEGACY_BUILTIN_SOULS,
} from './builtin-agent-presets'

interface AgentIdentityDbStatement {
  all<T = unknown>(...params: unknown[]): T[]
  run(...params: unknown[]): unknown
}

interface AgentIdentityDb {
  prepare(sql: string): AgentIdentityDbStatement
}

interface AgentIdentityMigrationRow {
  id: string
  old_agent_id: string | null
  new_agent_id: string | null
}

function absInside(root: string, relPath: string): string {
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`[agent-identity-assets] path escapes memory root: ${relPath}`)
  }
  return abs
}

function moveIfPossible(root: string, fromRelPath: string, toRelPath: string): void {
  const from = absInside(root, fromRelPath)
  const to = absInside(root, toRelPath)
  if (!existsSync(from) || existsSync(to)) return
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
}

export function reconcileAgentIdentityAssets(db: AgentIdentityDb, store: BeliefCardStore): number {
  const rows = db.prepare(`
    SELECT id, old_agent_id, new_agent_id
    FROM agent_identity_migration
    WHERE kind = 'reserved_slug_reassigned'
      AND asset_reconciled_at IS NULL
  `).all<AgentIdentityMigrationRow>()
  let reconciled = 0
  for (const row of rows) {
    const oldId = String(row.old_agent_id || '').trim()
    const newId = String(row.new_agent_id || '').trim()
    if (!isValidAgentSlug(oldId) || !isValidAgentSlug(newId)) continue
    moveIfPossible(store.rootPath, `agents/${oldId}`, `agents/${newId}`)
    moveIfPossible(store.rootPath, `knowledge/routing-${oldId}.md`, `knowledge/routing-${newId}.md`)
    db.prepare('UPDATE agent_identity_migration SET asset_reconciled_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id)
    reconciled += 1
  }
  return reconciled
}

export function deleteAgentIdentityAssets(store: BeliefCardStore, agentId: string): void {
  const id = String(agentId || '').trim()
  if (!isValidAgentSlug(id)) throw new Error('[agent-identity-assets] invalid agent id')
  rmSync(absInside(store.rootPath, `agents/${id}`), { recursive: true, force: true })
  rmSync(absInside(store.rootPath, `knowledge/routing-${id}.md`), { force: true })
}

function ensureFile(root: string, relPath: string, content: string): number {
  const abs = absInside(root, relPath)
  if (existsSync(abs)) return 0
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
  return 1
}

/**
 * 内置专项 agent（文案 / 美术 / 智识）的预设资产 seed。幂等：
 * - SOUL：仅当现值 == 064 旧默认（未被用户改过）时覆盖为新预设 soul（守卫见 LEGACY_BUILTIN_SOULS）。
 * - RULES.md / FOUNDATION.md：文件不存在才写。
 * - 知识卡 / 路由卡：卡片不存在（含 staged）才写；内置 agent 是系统钦定实体，直接 active
 *   （路由仍受 agent_auto_routing 默认 suggest 兜底，不会无确认自动转派）。
 * 返回各类写入计数，便于启动日志与测试断言。
 */
export function seedBuiltinAgentAssets(
  db: AgentIdentityDb,
  store: BeliefCardStore,
): { souls: number; files: number; cards: number } {
  const created = new Date().toISOString().slice(0, 10)
  let souls = 0
  let files = 0
  let cards = 0

  for (const [agentId, preset] of Object.entries(BUILTIN_AGENT_PRESETS)) {
    if (!preset || !isValidAgentSlug(agentId)) continue

    // 1) SOUL —— 守卫式更新，绝不覆盖用户改过的 soul
    const legacy = LEGACY_BUILTIN_SOULS[agentId as BuiltinAgentId]
    if (legacy) {
      const res = db.prepare(
        `UPDATE agent_personalities
         SET personality_text = ?, updated_at = ?
         WHERE agent_name = ? AND personality_text = ?`,
      ).run(preset.soul, Date.now(), agentId, legacy) as { changes?: number }
      if (res && typeof res.changes === 'number') souls += res.changes
    }

    // 2) RULES.md / FOUNDATION.md —— 文件缺失才写
    files += ensureFile(store.rootPath, `agents/${agentId}/RULES.md`, `${preset.rules}\n`)
    files += ensureFile(store.rootPath, `agents/${agentId}/FOUNDATION.md`, `${preset.foundation}\n`)

    // 3) 知识卡（active）—— 卡片缺失才写
    for (const seed of preset.knowledge) {
      const relPath = `agents/${agentId}/knowledge/${seed.slug}.md`
      if (store.readCard(relPath, { includeStaged: true })) continue
      const written = store.writeCard({
        relPath,
        frontmatter: {
          title: seed.title,
          description: seed.description,
          confidence: seed.confidence,
          tag: 'knowledge',
          created,
          status: 'active',
          source: `builtin-preset:v${BUILTIN_AGENT_PRESET_VERSION}`,
        },
        body: seed.body,
      })
      if (written.ok) cards += 1
    }

    // 4) 路由卡（active，tag=self）—— 卡片缺失才写
    const routingRel = `knowledge/routing-${agentId}.md`
    if (!store.readCard(routingRel, { includeStaged: true })) {
      const written = store.writeCard({
        relPath: routingRel,
        frontmatter: {
          title: preset.routing.title,
          description: preset.routing.description,
          confidence: 'H',
          tag: 'self',
          created,
          status: 'active',
          source: `builtin-preset:v${BUILTIN_AGENT_PRESET_VERSION}`,
          triggers: preset.routing.triggers,
        },
        body: preset.routing.body,
      })
      if (written.ok) cards += 1
    }
  }

  return { souls, files, cards }
}
