import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AskUserQuestionsCard } from '../renderer/components/agent/AskUserQuestionsCard'
import { MarkdownContent } from '../renderer/components/agent/chat-panel/markdown'

test('agent messages render bare authorization URLs as external clickable links', () => {
  const url = 'https://auth.example.com/device?code=AB%2012&state=x'
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: `请打开 ${url}。`,
  }))

  assert.match(html, /<a /)
  assert.match(html, /href="https:\/\/auth\.example\.com\/device\?code=AB%2012&amp;state=x"/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noreferrer"/)
  assert.doesNotMatch(html, /href="[^"]*。"/)
})

test('agent messages support labeled http(s) links but never linkify code or unsafe schemes', () => {
  const url = 'https://auth.example.com/verify?device=42'
  const linked = renderToStaticMarkup(createElement(MarkdownContent, {
    content: `[打开授权页](${url})`,
  }))
  assert.match(linked, new RegExp(`<a href="${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>打开授权页</a>`))

  const code = renderToStaticMarkup(createElement(MarkdownContent, {
    content: `\`${url}\` [危险](javascript:alert(1))`,
  }))
  assert.match(code, /<code/)
  assert.doesNotMatch(code, /<a /)
  assert.match(code, /javascript:alert/)
})

test('authorization URLs remain clickable when the agent waits in a question card', () => {
  const url = 'https://auth.example.com/device?code=ready-42'
  const html = renderToStaticMarkup(createElement(AskUserQuestionsCard, {
    card: {
      cardId: 'auth-card',
      status: 'pending',
      askedAt: Date.now(),
      questions: [{
        id: 'authorized',
        question: `请先打开 ${url} 完成授权，再选择继续。`,
        kind: 'single_choice',
        options: ['已完成授权', '取消'],
        required: true,
      }],
    },
    onSubmit: async () => ({ success: true }),
    onCancel: async () => ({ success: true }),
  }))

  assert.match(html, /<a /)
  assert.match(html, /href="https:\/\/auth\.example\.com\/device\?code=ready-42"/)
  assert.match(html, /target="_blank"/)
})
