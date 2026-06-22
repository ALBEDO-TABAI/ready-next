/**
 * EP4-A7 — agent lifecycle data contract. The repository is the only write
 * gate for reversible active/disabled transitions, terminal merge, and delete.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

function fakeAgentsDb() {
  const rows = new Map<string, Record<string, unknown>>()
  const personalities = new Set<string>()
  return {
    rows,
    personalities,
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('INSERT INTO agents')) {
        return {
          run: (...params: unknown[]) => {
            const [id, name, charter, personaRef, status, parentAgentId, derivationReason, mergedIntoAgentId, createdAt] = params
            rows.set(String(id), {
              id,
              name,
              charter,
              persona_ref: personaRef,
              status,
              parent_agent_id: parentAgentId,
              derivation_reason: derivationReason,
              merged_into_agent_id: mergedIntoAgentId,
              created_at: createdAt,
            })
          },
          all: () => [],
          get: () => undefined,
        }
      }
      if (normalized.startsWith('INSERT OR IGNORE INTO agent_personalities')) {
        return {
          run: (_id: unknown, agentName: unknown) => {
            personalities.add(String(agentName))
          },
          all: () => [],
          get: () => undefined,
        }
      }
      if (normalized.startsWith('UPDATE agent_personalities SET')) {
        return { run: () => undefined, all: () => [], get: () => undefined }
      }
      if (normalized.startsWith('UPDATE agents SET')) {
        return {
          run: (status: unknown, mergedIntoAgentId: unknown, id: unknown) => {
            const row = rows.get(String(id))
            if (row) {
              row.status = status
              row.merged_into_agent_id = mergedIntoAgentId
            }
          },
          all: () => [],
          get: () => undefined,
        }
      }
      if (normalized.startsWith('SELECT') && normalized.includes('WHERE id = ?')) {
        return { get: <R>(id: unknown) => rows.get(String(id)) as R | undefined, run: () => undefined, all: () => [] }
      }
      if (normalized.startsWith('SELECT') && normalized.includes('FROM agents')) {
        return { all: <R>() => [...rows.values()] as R[], run: () => undefined, get: () => undefined }
      }
      if (normalized.startsWith('UPDATE specialist_content_edit_proposals')) {
        return { run: () => undefined, all: () => [], get: () => undefined }
      }
      if (normalized.startsWith('UPDATE specialist_blueprints')) {
        return { run: () => undefined, all: () => [], get: () => undefined }
      }
      if (normalized.startsWith('DELETE FROM agent_personalities')) {
        return {
          run: (id: unknown) => { personalities.delete(String(id)) },
          all: () => [],
          get: () => undefined,
        }
      }
      if (normalized.startsWith('DELETE FROM agents')) {
        return {
          run: (id: unknown) => { rows.delete(String(id)) },
          all: () => [],
          get: () => undefined,
        }
      }
      throw new Error(`unexpected agents SQL: ${normalized}`)
    },
  }
}

test('agent lifecycle supports disable/enable, terminal merge, and delete', async () => {
  const { AgentRegistryRepository } = await import('../main/modules/repositories/agent-registry-repository')
  const raw = fakeAgentsDb()
  const registry = new AgentRegistryRepository({ getRawDb: () => raw as never })

  registry.create({ id: 'butler', name: '管家', charter: '主 agent' })
  registry.create({ id: 'writer', name: '文案专员', charter: '写作' })
  registry.create({ id: 'editor', name: '编辑专员', charter: '编辑' })
  registry.create({ id: 'collector', name: '采集专员', charter: '采集' })
  registry.create({ id: 'old-target', name: '旧目标', charter: '旧目标' })

  assert.throws(() => registry.updateStatus('butler', 'disabled'), /main agent/)
  assert.throws(() => registry.updateStatus('writer', 'merged'), /requires a target/)
  assert.throws(() => registry.updateStatus('writer', 'merged', { mergedIntoAgentId: 'writer' }), /another agent/)
  assert.throws(() => registry.updateStatus('writer', 'merged', { mergedIntoAgentId: 'missing' }), /target must be active/)

  const disabledTarget = registry.updateStatus('old-target', 'retired')
  assert.equal(disabledTarget.status, 'disabled')
  assert.throws(() => registry.updateStatus('writer', 'merged', { mergedIntoAgentId: 'old-target' }), /target must be active/)

  const disabled = registry.updateStatus('collector', 'disabled')
  assert.equal(disabled.status, 'disabled')
  assert.equal(registry.get('collector')?.status, 'disabled')
  const enabled = registry.updateStatus('collector', 'active')
  assert.equal(enabled.status, 'active')

  const merged = registry.updateStatus('writer', 'merged', { mergedIntoAgentId: 'editor' })
  assert.equal(merged.status, 'merged')
  assert.equal(merged.mergedIntoAgentId, 'editor')
  assert.equal(registry.get('writer')?.mergedIntoAgentId, 'editor')
  assert.throws(() => registry.updateStatus('writer', 'disabled'), /merged agents/)

  assert.throws(() => registry.deleteAgent('butler'), /main agent/)
  const deleted = registry.deleteAgent('editor')
  assert.equal(deleted.id, 'editor')
  assert.equal(registry.get('editor'), null)
  assert.equal(raw.personalities.has('editor'), false)
})
