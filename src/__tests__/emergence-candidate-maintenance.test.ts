import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { extractCrystallizeCards } from '../main/modules/agent-control/emergence/emergence-cards'

const repoRoot = resolve(import.meta.dirname, '../..')

test('historical candidate stages never become live emergence actions', () => {
  const cards = extractCrystallizeCards([
    {
      relPath: 'knowledge/agent-candidate-a.md',
      title: '小红书行情采集',
      tag: 'aspire',
      status: 'staged',
      source: null,
      stage: 'candidate',
    },
    {
      relPath: 'knowledge/agent-hint-a.md',
      title: '近期请求观察',
      tag: 'aspire',
      status: 'staged',
      source: 'possible-duplicate-of:knowledge/x.md',
      stage: 'hint',
    },
  ])

  assert.deepEqual(cards, [])
})

test('candidate maintenance remains outside the live runtime and renderer feed', () => {
  const liveSources = [
    'src/main/modules/agent-control/runtime-core/runtime.ts',
    'src/main/modules/claude-bridge/ipc/emergence-feed-group.ts',
    'src/preload/index.ts',
  ].map((relativePath) => readFileSync(resolve(repoRoot, relativePath), 'utf8')).join('\n')

  assert.doesNotMatch(liveSources, /maintainAgentCandidates|extractAgentCandidateCards/)
  assert.doesNotMatch(liveSources, /adopt_candidate/)
})
