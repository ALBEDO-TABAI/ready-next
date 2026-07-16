import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import WelcomePanel from '../renderer/components/agent/WelcomePanel'
import {
  buildWelcomeSuggestions,
  DEFAULT_WELCOME_SUGGESTIONS,
} from '../renderer/modules/agent/welcomeSuggestions'
import { useWorkspace } from '../renderer/stores/useWorkspace'
import type {
  FileEmergenceBucket,
  FileEmergenceIntentCard,
  FileEmergenceProject,
  FileEmergenceSnapshot,
} from '../shared/file-emergence'

function project(input: {
  id: string
  title: string
  bucket: FileEmergenceBucket
  score?: number
  status?: FileEmergenceProject['status']
  files?: string[]
}): FileEmergenceProject {
  return {
    id: input.id,
    projectKey: `project:${input.id}`,
    title: input.title,
    bucket: input.bucket,
    rawLabels: [input.title],
    anchorType: 'directory',
    anchorPath: `/workspace/${input.id}`,
    titleSource: 'directory',
    score: input.score ?? 0.8,
    confidence: 'high',
    status: input.status,
    files: (input.files ?? []).map((name, index) => ({
      path: `/workspace/${input.id}/${name}`,
      name,
      kind: 'document' as const,
      score: 0.8 - index * 0.05,
      reason: '相关文件',
    })),
    evidence: [],
    updatedAt: 1_720_000_000_000,
  }
}

function snapshot(
  projects: FileEmergenceProject[],
  intentCards: FileEmergenceIntentCard[] = [],
): FileEmergenceSnapshot {
  return {
    generatedAt: 1_720_000_000_000,
    workspaceRoots: ['/Users/test/Documents/project'],
    enabled: true,
    buckets: {
      future: projects.filter((item) => item.bucket === 'future'),
      today: projects.filter((item) => item.bucket === 'today'),
      past: projects.filter((item) => item.bucket === 'past'),
      distant: projects.filter((item) => item.bucket === 'distant'),
    },
    intentCards,
  }
}

test('welcome suggestions prioritize current work and turn emergence facts into actionable prompts', () => {
  const suggestions = buildWelcomeSuggestions(snapshot([
    project({
      id: 'launch',
      title: '夏季发布',
      bucket: 'today',
      status: 'active',
      files: ['brief.md', 'schedule.xlsx'],
    }),
    project({
      id: 'review',
      title: '年度复盘',
      bucket: 'future',
      status: 'upcoming',
      files: ['notes.md'],
    }),
  ]))

  assert.equal(suggestions.length, 2)
  assert.equal(suggestions[0].label, '继续 · 夏季发布')
  assert.match(suggestions[0].description, /brief\.md/)
  assert.match(suggestions[0].prompt, /夏季发布/)
  assert.equal(suggestions[1].label, '准备 · 年度复盘')
})

test('explicit forming intent wins its duplicate project without showing the same work twice', () => {
  const forming: FileEmergenceIntentCard = {
    id: 'forming:launch',
    projectKey: 'project:launch',
    type: 'forming',
    title: '正在成形：夏季发布',
    confidence: 0.86,
    action: { kind: 'open_project_group', ref: 'project:launch' },
    evidence: [{ fact: '相关文件 3 个', ref: 'project:launch' }],
  }
  const suggestions = buildWelcomeSuggestions(snapshot([
    project({ id: 'launch', title: '夏季发布', bucket: 'today', status: 'active' }),
    project({ id: 'archive', title: '素材归档', bucket: 'past', status: 'recently_finished' }),
  ], [forming]))

  assert.equal(suggestions[0].label, '推进 · 夏季发布')
  assert.equal(suggestions.filter((item) => item.label.includes('夏季发布')).length, 1)
  assert.equal(suggestions[1].label, '收尾 · 素材归档')
})

test('one emerged project produces two complementary dynamic actions', () => {
  const suggestions = buildWelcomeSuggestions(snapshot([
    project({
      id: 'reading',
      title: '品牌案例研究',
      bucket: 'future',
      status: 'continuation',
      files: ['case-study.pdf'],
    }),
  ]))

  assert.equal(suggestions[0].label, '续读 · 品牌案例研究')
  assert.equal(suggestions[1].label, '梳理 · 品牌案例研究')
  assert.ok(suggestions.every((item) => item.prompt.includes('品牌案例研究')))
})

test('disabled or empty emergence keeps two stable local presets', () => {
  assert.deepEqual(buildWelcomeSuggestions(null), DEFAULT_WELCOME_SUGGESTIONS)
  assert.deepEqual(buildWelcomeSuggestions({ ...snapshot([]), enabled: false }), DEFAULT_WELCOME_SUGGESTIONS)
  assert.deepEqual(buildWelcomeSuggestions(snapshot([])), DEFAULT_WELCOME_SUGGESTIONS)
})

const DOM_GLOBAL_KEYS = [
  'window',
  'document',
  'HTMLElement',
  'SVGElement',
  'Node',
  'Element',
  'MouseEvent',
  'navigator',
  'IS_REACT_ACT_ENVIRONMENT',
] as const

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

async function withDom(
  electronAPI: unknown,
  fn: (root: Root, container: HTMLElement) => Promise<void>,
): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://ready.test',
    pretendToBeVisual: true,
  })
  const previous = Object.fromEntries(
    DOM_GLOBAL_KEYS.map((key) => [key, (globalThis as Record<string, unknown>)[key]]),
  )
  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('SVGElement', dom.window.SVGElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Element', dom.window.Element)
  setGlobal('MouseEvent', dom.window.MouseEvent)
  setGlobal('navigator', dom.window.navigator)
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(dom.window, 'electronAPI', { value: electronAPI, configurable: true })

  const container = dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  try {
    await fn(root, container)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of DOM_GLOBAL_KEYS) setGlobal(key, previous[key])
  }
}

test('welcome panel loads the active workspace snapshot and fills the clicked prompt', async () => {
  const previousWorkspace = useWorkspace.getState()
  useWorkspace.setState({ workspaceRoot: '/Users/test/Documents/project', pinnedFolders: [] })
  const dynamicSnapshot = snapshot([
    project({ id: 'launch', title: '夏季发布', bucket: 'today', status: 'active' }),
  ])
  const requestedRoots: string[][] = []
  let filledPrompt = ''

  try {
    await withDom({
      fileEmergence: {
        getSnapshot: async (payload: { workspaceRoots: string[] }) => {
          requestedRoots.push(payload.workspaceRoots)
          return { success: true, data: dynamicSnapshot }
        },
      },
    }, async (root, container) => {
      await act(async () => {
        root.render(createElement(WelcomePanel, {
          onSetInputSuggestion: (value: string) => { filledPrompt = value },
        }))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      assert.deepEqual(requestedRoots, [['/Users/test/Documents/project']])
      assert.equal(container.querySelectorAll('[data-ready-dot-r] circle').length, 22)
      assert.match(container.textContent || '', /Ready for work , Ready for life\./)
      assert.match(container.textContent || '', /继续 · 夏季发布/)

      const button = container.querySelector('[data-welcome-suggestion="project:project:launch"]') as HTMLButtonElement
      assert.ok(button)
      await act(async () => button.click())
      assert.match(filledPrompt, /夏季发布/)
    })
  } finally {
    useWorkspace.setState({
      workspaceRoot: previousWorkspace.workspaceRoot,
      pinnedFolders: previousWorkspace.pinnedFolders,
    })
  }
})
