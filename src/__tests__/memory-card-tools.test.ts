import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { executeMemoryTool } from '../main/modules/tools/memory-tools'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { ToolContext } from '../main/modules/tools/tool-executor'

test('memory-card-tools declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'memory-card-tools transitive sqlite load')
})

function makeContext(memoryRoot: string): ToolContext & { store: BeliefCardStore } {
  const store = new BeliefCardStore({ memoryRoot })
  return {
    store,
    invoker: 'model',
    executionProfile: {
      knowledgeWriteOwnerAgentId: 'butler',
      allowedKnowledgeRefs: ['knowledge/rate-limits.md', 'knowledge/pref.md'],
    } as never,
    runtime: {
      getBeliefCardStore: () => store,
      // executeMemoryTool retrieves these up-front for all tools; card cases
      // don't use them, so stubs are sufficient.
      getMemoryRepository: () => ({}),
      getPromptAssembly: () => ({}),
    } as unknown as ToolContext['runtime'],
  } as ToolContext & { store: BeliefCardStore }
}

test('memory_write_card defaults to staged and is hidden from default read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-card-tool-'))
  try {
    const ctx = makeContext(dir)
    const writeRes = JSON.parse(
      await executeMemoryTool(
        'memory_write_card',
        {
          rel_path: 'knowledge/rate-limits.md',
          title: '限流策略',
          description: '采集限流的处理',
          confidence: 'M',
          tag: 'knowledge',
          body: '正文',
        },
        ctx,
      ),
    )
    assert.equal(writeRes.success, true)
    assert.equal(writeRes.status, 'staged')

    // default read excludes staged
    const readDefault = JSON.parse(
      await executeMemoryTool('memory_read_card', { rel_path: 'knowledge/rate-limits.md' }, ctx),
    )
    assert.equal(readDefault.success, false)

    // include_staged returns it
    const readStaged = JSON.parse(
      await executeMemoryTool(
        'memory_read_card',
        { rel_path: 'knowledge/rate-limits.md', include_staged: true },
        { ...ctx, invoker: 'host' },
      ),
    )
    assert.equal(readStaged.success, true)
    assert.equal(readStaged.frontmatter.title, '限流策略')
    assert.equal(readStaged.body, '正文')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory_write_card downgrades model active request; transition remains the confirmation path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-card-tool-'))
  try {
    const ctx = makeContext(dir)
    const writeRes = JSON.parse(
      await executeMemoryTool(
        'memory_write_card',
        {
          rel_path: 'knowledge/pref.md',
          title: '偏好',
          description: 'x',
          confidence: 'H',
          tag: 'preference',
          body: 'b',
          status: 'active',
        },
        ctx,
      ),
    )
    assert.equal(writeRes.success, true)
    assert.equal(writeRes.status, 'staged')

    const hidden = JSON.parse(
      await executeMemoryTool('memory_read_card', { rel_path: 'knowledge/pref.md' }, ctx),
    )
    assert.equal(hidden.success, false)

    assert.equal(ctx.store.transition('knowledge/pref.md', 'active'), true)
    const read = JSON.parse(
      await executeMemoryTool('memory_read_card', { rel_path: 'knowledge/pref.md' }, ctx),
    )
    assert.equal(read.success, true)
    assert.equal(read.frontmatter.status, 'active')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory_write_card rejects a disallowed path with a structured error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-card-tool-'))
  try {
    const ctx = makeContext(dir)
    const res = JSON.parse(
      await executeMemoryTool(
        'memory_write_card',
        {
          rel_path: 'notes/foo.md',
          title: 't',
          description: 'd',
          confidence: 'M',
          tag: 'knowledge',
          body: 'b',
        },
        ctx,
      ),
    )
    assert.equal(res.success, false)
    assert.match(res.error, /not allowed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
