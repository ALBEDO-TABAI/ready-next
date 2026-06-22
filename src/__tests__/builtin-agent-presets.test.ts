import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import { seedBuiltinAgentAssets } from '../main/modules/agent-control/agents/agent-identity-assets'
import {
  BUILTIN_AGENT_PRESETS,
  LEGACY_BUILTIN_SOULS,
} from '../main/modules/agent-control/agents/builtin-agent-presets'

// Minimal fake DB: only the guarded SOUL UPDATE matters.
function makeFakeDb(personalities: Record<string, string>) {
  const rows = new Map(Object.entries(personalities))
  const db = {
    rows,
    prepare(sql: string) {
      return {
        run(...params: unknown[]) {
          if (/UPDATE\s+agent_personalities/i.test(sql)) {
            const [newText, , agentName, guardText] = params as [string, number, string, string]
            const cur = rows.get(agentName)
            if (cur !== undefined && cur === guardText) {
              rows.set(agentName, newText)
              return { changes: 1 }
            }
            return { changes: 0 }
          }
          return { changes: 0 }
        },
        all() {
          return []
        },
      }
    },
  }
  return db
}

function tempStore(): { store: BeliefCardStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ready-builtin-preset-'))
  return { store: new BeliefCardStore({ memoryRoot: root }), root }
}

const PRESET_IDS = Object.keys(BUILTIN_AGENT_PRESETS) as Array<keyof typeof BUILTIN_AGENT_PRESETS>
const expectedFiles = PRESET_IDS.length * 2 // RULES + FOUNDATION each
const expectedCards = PRESET_IDS.reduce((sum, id) => sum + (BUILTIN_AGENT_PRESETS[id]!.knowledge.length + 1), 0)
const expectedSouls = PRESET_IDS.filter((id) => LEGACY_BUILTIN_SOULS[id]).length

test('seedBuiltinAgentAssets writes RULES/FOUNDATION files, active knowledge + routing cards, and updates legacy souls', () => {
  const { store, root } = tempStore()
  try {
    const legacy = Object.fromEntries(PRESET_IDS.map((id) => [id, LEGACY_BUILTIN_SOULS[id]!]))
    const db = makeFakeDb(legacy)

    const result = seedBuiltinAgentAssets(db as never, store)
    assert.equal(result.files, expectedFiles, 'all RULES + FOUNDATION files written')
    assert.equal(result.cards, expectedCards, 'all knowledge + routing cards written')
    assert.equal(result.souls, expectedSouls, 'all legacy souls refreshed')

    for (const id of PRESET_IDS) {
      const preset = BUILTIN_AGENT_PRESETS[id]!
      // files exist with the preset content
      assert.ok(existsSync(join(root, `agents/${id}/RULES.md`)), `${id} RULES.md exists`)
      assert.ok(existsSync(join(root, `agents/${id}/FOUNDATION.md`)), `${id} FOUNDATION.md exists`)
      assert.match(readFileSync(join(root, `agents/${id}/RULES.md`), 'utf-8'), /运行规则/)

      // knowledge cards active + injectable (renderKnowledgeIndex only shows active)
      for (const seed of preset.knowledge) {
        const card = store.readCard(`agents/${id}/knowledge/${seed.slug}.md`)
        assert.ok(card, `${id} knowledge card ${seed.slug} is active/readable`)
        assert.equal(card!.frontmatter.status, 'active')
        assert.equal(card!.frontmatter.title, seed.title)
      }

      // routing card active with literal triggers (≤8), bound to the agent id by filename
      const routing = store.listRoutingCards().find((r) => r.targetAgentId === id)
      assert.ok(routing, `${id} has an active routing card`)
      assert.deepEqual(routing!.triggers, preset.routing.triggers)
      assert.ok((routing!.triggers?.length ?? 0) <= 8, 'triggers ≤ 8')

      // soul refreshed to the preset value
      assert.equal(db.rows.get(id), preset.soul, `${id} soul updated to preset`)
    }

    // idempotent: second run writes nothing and refreshes no soul (current != legacy now)
    const second = seedBuiltinAgentAssets(db as never, store)
    assert.deepEqual(second, { souls: 0, files: 0, cards: 0 }, 'second seed is a no-op')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('seedBuiltinAgentAssets never clobbers a user-edited soul or an existing card', () => {
  const { store, root } = tempStore()
  try {
    const firstId = PRESET_IDS[0]
    const preset = BUILTIN_AGENT_PRESETS[firstId]!

    // user already edited this agent's soul → must NOT be overwritten
    const personalities: Record<string, string> = Object.fromEntries(
      PRESET_IDS.map((id) => [id, LEGACY_BUILTIN_SOULS[id]!]),
    )
    personalities[firstId] = '# 我自己改过的人格，别动'
    const db = makeFakeDb(personalities)

    // user already authored one of the seed knowledge cards (staged) → must NOT be overwritten
    const keepSlug = preset.knowledge[0].slug
    const keepRel = `agents/${firstId}/knowledge/${keepSlug}.md`
    const customBody = '用户手写的知识，不许覆盖'
    const pre = store.writeCard({
      relPath: keepRel,
      frontmatter: {
        title: '用户卡',
        description: 'x',
        confidence: 'M',
        tag: 'knowledge',
        created: '2026-06-22',
        status: 'staged',
      },
      body: customBody,
    })
    assert.ok(pre.ok)

    seedBuiltinAgentAssets(db as never, store)

    assert.equal(db.rows.get(firstId), '# 我自己改过的人格，别动', 'user-edited soul preserved')
    const kept = store.readCard(keepRel, { includeStaged: true })
    assert.equal(kept!.body.trim(), customBody, 'existing user card body preserved')
    assert.equal(kept!.frontmatter.status, 'staged', 'existing card status preserved')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
