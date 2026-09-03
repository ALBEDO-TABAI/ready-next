import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MarkdownContent, renderInline } from '../renderer/components/agent/chat-panel/markdown'
import {
  fileReferenceLabel,
  parseLocalReferences,
} from '../renderer/components/agent/chat-panel/markdown/local-reference'

test('parseLocalReferences splits mentions and absolute file citations', () => {
  const parts = parseLocalReferences(
    '@[surf-pro]整理到@[工作内容] 见 /Users/user/实验田/idea-1/call_outcome.py (line 1)',
  )
  assert.deepEqual(parts[0], { kind: 'mention', name: 'surf-pro', raw: '@[surf-pro]' })
  assert.equal(parts[1], '整理到')
  assert.deepEqual(parts[2], { kind: 'mention', name: '工作内容', raw: '@[工作内容]' })
  assert.equal(typeof parts[3], 'string')
  assert.deepEqual(parts[4], {
    kind: 'file',
    path: '/Users/user/实验田/idea-1/call_outcome.py',
    line: 1,
    raw: '/Users/user/实验田/idea-1/call_outcome.py (line 1)',
  })
  assert.equal(fileReferenceLabel('/Users/user/实验田/idea-1/call_outcome.py', 1), 'call_outcome.py (line 1)')
})

test('chat prose wraps file paths and mentions as local reference chips', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: '根因在 /Users/user/实验田/idea-1/call_outcome.py (line 1)，继续用 @[surf-pro]',
    mentions: { 'surf-pro': { path: '/Users/user/Library/Application Support/ready/skill-runtime/skills/surf-pro' } },
  }))
  assert.match(html, /data-ready-local-ref="file"/)
  assert.match(html, /call_outcome\.py \(line 1\)/)
  assert.match(html, /data-ready-local-ref="file"/)
  assert.doesNotMatch(html, /@\[surf-pro\]/)
})

test('file markdown links become local chips instead of external arrows', () => {
  const html = renderToStaticMarkup(createElement('div', null, renderInline(
    '见 [call_outcome.py](file:///Users/user/实验田/idea-1/call_outcome.py)',
  )))
  assert.match(html, /data-ready-local-ref="file"/)
  assert.doesNotMatch(html, /↗/)
})
