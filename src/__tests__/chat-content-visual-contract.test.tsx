import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ThinkingIndicator } from '../renderer/components/agent/chat-panel/ThinkingIndicator'
import { MarkdownContent } from '../renderer/components/agent/chat-panel/markdown'
import { TaskCard } from '../renderer/components/agent/chat-panel/task/TaskCard'
import {
  resolveToolActivityPresentation,
  ToolTimeline,
} from '../renderer/components/agent/chat-panel/task/ToolTimeline'
import { taskProjectionToTaskCardRun } from '../renderer/components/agent/task-card-from-projection'

test('thinking indicator is a compact live status without an assistant avatar', () => {
  const html = renderToStaticMarkup(createElement(ThinkingIndicator))

  assert.match(html, /data-ready-thinking-state="true"/)
  assert.match(html, /role="status"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, />思考中</)
  assert.doesNotMatch(html, />R</)
})

test('streaming prose exposes a steady caret while completed prose does not', () => {
  const streaming = renderToStaticMarkup(createElement(MarkdownContent, {
    content: '正在整理结果',
    streaming: true,
  }))
  const complete = renderToStaticMarkup(createElement(MarkdownContent, {
    content: '结果已经整理完成',
  }))

  assert.match(streaming, /data-ready-stream-caret="true"/)
  assert.doesNotMatch(complete, /data-ready-stream-caret/)
})

test('fenced code renders as an operable code block with language, lines, and copy action', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: ['```ts', 'const ready = true', 'console.log(ready)', '```'].join('\n'),
  }))

  assert.match(html, /data-ready-code-block="true"/)
  assert.match(html, /data-ready-code-language="true">ts</)
  assert.match(html, /data-ready-code-line="1"/)
  assert.match(html, /data-ready-code-line="2"/)
  assert.match(html, /aria-label="复制代码"/)
})

test('real diff blocks and numbered links receive their adapted presentation', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: [
      '参考 [1](https://example.com/source)',
      '',
      '```diff',
      '-旧内容',
      '+新内容',
      '```',
    ].join('\n'),
  }))

  assert.match(html, /data-ready-agent-citation="true"/)
  assert.match(html, /data-ready-code-kind="diff"/)
  assert.match(html, /data-ready-diff-line="remove"/)
  assert.match(html, /data-ready-diff-line="add"/)
})

test('tool activity presentation uses typed, truthful labels from existing trace data', () => {
  const search = resolveToolActivityPresentation({
    id: 'search',
    callText: 'web_search(query, topK)',
    resultText: null,
    status: 'running',
    toolName: 'web_search',
    callDetail: JSON.stringify({ query: 'Ready Electron 42' }),
  })
  const image = resolveToolActivityPresentation({
    id: 'image',
    callText: 'generate_image(prompt)',
    resultText: 'generate_image: 已生成',
    status: 'done',
    toolName: 'generate_image',
    callDetail: JSON.stringify({ prompt: '安静的桌面工作台' }),
  })

  assert.deepEqual(search, {
    kind: 'research',
    title: '搜索网页 · Ready Electron 42',
  })
  assert.deepEqual(image, {
    kind: 'image',
    title: '图片已生成 · 安静的桌面工作台',
  })

  const html = renderToStaticMarkup(createElement(ToolTimeline, {
    items: [{
      id: 'search',
      callText: 'web_search(query, topK)',
      resultText: null,
      status: 'running' as const,
      toolName: 'web_search',
      callDetail: JSON.stringify({ query: 'Ready Electron 42' }),
    }],
  }))
  assert.match(html, /data-ready-tool-activity-kind="research"/)
  assert.match(html, /搜索网页 · Ready Electron 42/)
})

test('Ready tool names map to their actual product activity instead of reference-library names', () => {
  const cases = [
    { name: 'web_fetch', kind: 'research', title: '读取网页' },
    { name: 'document_read_section', kind: 'document', title: '处理文档' },
    { name: 'file_read_excerpt', kind: 'file', title: '处理文件' },
    { name: 'skill_run_shell', kind: 'command', title: '运行本地命令' },
    { name: 'use_skill', kind: 'skill', title: '运行技能' },
    { name: 'browser_read', kind: 'browser', title: '操作网页' },
  ] as const

  for (const item of cases) {
    const presentation = resolveToolActivityPresentation({
      id: item.name,
      callText: `${item.name}()`,
      resultText: null,
      status: 'running',
      toolName: item.name,
    })
    assert.equal(presentation.kind, item.kind, item.name)
    assert.equal(presentation.title, item.title, item.name)
  }
})

test('task steps expose distinct semantic states without relying on colored bullets alone', () => {
  const run = taskProjectionToTaskCardRun({
    scopeId: 'scope-visual',
    taskId: 'task-visual',
    phase: 'tool_running',
    title: '整理资料',
    steps: [
      { id: 'done', title: '读取资料', status: 'done', updatedAt: '2026-07-23T00:00:00.000Z' },
      { id: 'running', title: '提炼重点', status: 'running', updatedAt: '2026-07-23T00:00:01.000Z' },
      { id: 'pending', title: '写入文档', status: 'pending', updatedAt: '2026-07-23T00:00:02.000Z' },
    ],
    currentStepId: 'running',
    waitingFor: 'none',
    resumableActions: [],
    recentArtifacts: [],
    taskContinuation: null,
    progress: null,
    memoryCapture: null,
    taskType: 'multi_step_task',
    interactionState: 'running',
    canResume: false,
    updatedAt: '2026-07-23T00:00:02.000Z',
    toolTrace: [],
  })
  const html = renderToStaticMarkup(createElement(TaskCard, {
    run,
    expanded: true,
  }))

  assert.match(html, /data-ready-task-step-status="done"/)
  assert.match(html, /data-ready-task-step-status="running"/)
  assert.match(html, /data-ready-task-step-status="pending"/)
  assert.match(html, /aria-label="步骤已完成"/)
  assert.match(html, /aria-label="步骤进行中"/)
  assert.match(html, /aria-label="步骤待执行"/)
})
