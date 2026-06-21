import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { executeMemoryTool } from '../main/modules/tools/memory-tools'
import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import type { ToolContext } from '../main/modules/tools/tool-executor'

test('memory-card-write-discipline declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'memory-card-write-discipline transitive sqlite load')
})

function makeScope(agent: string): ConversationScope {
  return {
    id: `scope-${agent}`,
    agent,
    title: 'scope',
    sourceKind: 'local',
    sourceId: `local-${agent}`,
    threadKey: `thread-${agent}`,
    meta: {},
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
  }
}

function makeContext(
  memoryRoot: string,
  options: { invoker?: ToolContext['invoker']; agent?: string } = {},
): ToolContext & { store: BeliefCardStore } {
  const store = new BeliefCardStore({ memoryRoot })
  return {
    store,
    invoker: options.invoker ?? 'model',
    scope: options.agent ? makeScope(options.agent) : null,
    runtime: {
      getBeliefCardStore: () => store,
      getMemoryRepository: () => ({}),
      getPromptAssembly: () => ({}),
    } as unknown as ToolContext['runtime'],
  } as ToolContext & { store: BeliefCardStore }
}

function cardArgs(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    rel_path: 'knowledge/pref.md',
    title: '偏好',
    description: '用户偏好',
    confidence: 'H',
    tag: 'preference',
    body: '原始正文',
    ...overrides,
  }
}

function activeFrontmatter(overrides: Partial<BeliefCardFrontmatter> = {}): BeliefCardFrontmatter {
  return {
    title: '已确认偏好',
    description: '已确认',
    confidence: 'H',
    tag: 'preference',
    created: '2026-06-20',
    status: 'active',
    ...overrides,
  }
}

test('model-supplied active status is downgraded to staged and hidden from default read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-card-discipline-'))
  try {
    const ctx = makeContext(dir)
    const writeRes = JSON.parse(
      await executeMemoryTool('memory_write_card', cardArgs({ status: 'active' }), ctx),
    )
    assert.equal(writeRes.success, true)
    assert.equal(writeRes.status, 'staged')

    const defaultRead = JSON.parse(
      await executeMemoryTool('memory_read_card', { rel_path: 'knowledge/pref.md' }, ctx),
    )
    assert.equal(defaultRead.success, false)

    const stagedRead = JSON.parse(
      await executeMemoryTool('memory_read_card', { rel_path: 'knowledge/pref.md', include_staged: true }, ctx),
    )
    assert.equal(stagedRead.success, true)
    assert.equal(stagedRead.frontmatter.status, 'staged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('model write cannot silently overwrite an existing active card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-card-discipline-'))
  try {
    const ctx = makeContext(dir)
    const existing = ctx.store.writeCard({
      relPath: 'knowledge/pref.md',
      frontmatter: activeFrontmatter(),
      body: 'active body',
    })
    assert.equal(existing.ok, true)

    const writeRes = JSON.parse(
      await executeMemoryTool(
        'memory_write_card',
        cardArgs({ status: 'active', body: 'model overwrite' }),
        ctx,
      ),
    )
    assert.equal(writeRes.success, false)
    assert.match(writeRes.error, /active/i)

    const read = JSON.parse(
      await executeMemoryTool('memory_read_card', { rel_path: 'knowledge/pref.md' }, ctx),
    )
    assert.equal(read.success, true)
    assert.equal(read.body, 'active body')
    assert.equal(read.frontmatter.status, 'active')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agent-scoped writes require matching owner and never fall back to global', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-card-discipline-'))
  try {
    const mismatchCtx = makeContext(dir, { agent: 'alpha' })
    const mismatch = JSON.parse(
      await executeMemoryTool(
        'memory_write_card',
        cardArgs({ rel_path: 'agents/beta/knowledge/pref.md' }),
        mismatchCtx,
      ),
    )
    assert.equal(mismatch.success, false)
    assert.match(mismatch.error, /owner|agent/i)

    const noOwnerCtx = makeContext(dir)
    const missingOwner = JSON.parse(
      await executeMemoryTool(
        'memory_write_card',
        cardArgs({ rel_path: 'agents/alpha/knowledge/pref.md' }),
        noOwnerCtx,
      ),
    )
    assert.equal(missingOwner.success, false)
    assert.match(missingOwner.error, /owner|agent/i)

    const globalFallback = JSON.parse(
      await executeMemoryTool('memory_read_card', { rel_path: 'knowledge/pref.md', include_staged: true }, noOwnerCtx),
    )
    assert.equal(globalFallback.success, false)

    const matchCtx = makeContext(dir, { agent: 'alpha' })
    const match = JSON.parse(
      await executeMemoryTool(
        'memory_write_card',
        cardArgs({ rel_path: 'agents/alpha/knowledge/pref.md', status: 'active' }),
        matchCtx,
      ),
    )
    assert.equal(match.success, true)
    assert.equal(match.status, 'staged')

    const stagedRead = JSON.parse(
      await executeMemoryTool(
        'memory_read_card',
        { rel_path: 'agents/alpha/knowledge/pref.md', include_staged: true },
        matchCtx,
      ),
    )
    assert.equal(stagedRead.success, true)
    assert.equal(stagedRead.frontmatter.status, 'staged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('confirmed active production remains the existing transition path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-card-discipline-'))
  try {
    const ctx = makeContext(dir)
    const writeRes = JSON.parse(
      await executeMemoryTool('memory_write_card', cardArgs({ rel_path: 'knowledge/confirm.md' }), ctx),
    )
    assert.equal(writeRes.success, true)
    assert.equal(writeRes.status, 'staged')

    assert.equal(ctx.store.transition('knowledge/confirm.md', 'active'), true)
    const read = JSON.parse(
      await executeMemoryTool('memory_read_card', { rel_path: 'knowledge/confirm.md' }, ctx),
    )
    assert.equal(read.success, true)
    assert.equal(read.frontmatter.status, 'active')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
