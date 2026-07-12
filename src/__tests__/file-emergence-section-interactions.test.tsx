import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import FileEmergenceSection from '../renderer/components/layout/FileEmergenceSection'
import type { FileEmergenceViewModel } from '../renderer/components/layout/fileEmergenceViewModel'
import type { FileEmergenceProject } from '../shared/file-emergence'

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://ready.test',
  })

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    navigator: globalThis.navigator,
  }

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })

  return {
    dom,
    rootElement: dom.window.document.getElementById('root') as HTMLElement,
    cleanup: () => {
      dom.window.close()
      Object.assign(globalThis, {
        window: previous.window,
        document: previous.document,
        HTMLElement: previous.HTMLElement,
        MouseEvent: previous.MouseEvent,
      })
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previous.navigator,
      })
    },
  }
}

function makeProject(id: string, bucket: FileEmergenceProject['bucket']): FileEmergenceProject {
  return {
    projectKey: `project-${id}`,
    id,
    bucket,
    title: id,
    rawLabels: [id],
    anchorType: 'directory',
    anchorPath: `/workspace/${id}`,
    titleSource: 'directory',
    score: 1,
    confidence: 'high',
    status: bucket === 'past' ? 'recently_finished' : undefined,
    files: [
      {
        fileKey: `file-${id}`,
        path: `/workspace/${id}/brief.pdf`,
        name: 'brief.pdf',
        kind: 'document',
        score: 1,
        reason: '相关文件',
      },
    ],
    evidence: [],
    updatedAt: Date.now(),
  }
}

function makeViewModel(): FileEmergenceViewModel {
  return {
    totalProjects: 2,
    defaultExpandedBucket: 'past',
    buckets: [
      { bucket: 'future', label: '未来', projects: [] },
      { bucket: 'today', label: '今天', projects: [] },
      { bucket: 'past', label: '过去', projects: [makeProject('品牌空间案例研究', 'past'), makeProject('门店图片数据库', 'past')] },
      { bucket: 'distant', label: '遥远', projects: [] },
    ],
  }
}

test('file emergence section starts collapsed and keeps only the last clicked row selected', async () => {
  const { dom, rootElement, cleanup } = installDom()
  let root: ReturnType<typeof createRoot> | null = createRoot(rootElement)

  try {
    flushSync(() => {
      root?.render(createElement(FileEmergenceSection, {
        viewModel: makeViewModel(),
        isRefreshing: false,
        onRefresh: () => {},
        onOpenFile: () => {},
      }))
    })

    for (const label of ['未来', '今天', '过去', '遥远']) {
      assert.match(rootElement.textContent ?? '', new RegExp(label))
    }

    const pastButton = dom.window.document.querySelector('[data-file-emergence-bucket="past"]') as HTMLElement | null
    assert.ok(pastButton)
    assert.equal(pastButton.getAttribute('aria-expanded'), 'false')
    assert.equal(dom.window.document.querySelector('[data-file-emergence-project="品牌空间案例研究"]'), null)
    assert.equal(dom.window.document.querySelectorAll('[data-selected="true"]').length, 0)

    flushSync(() => {
      pastButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(pastButton.getAttribute('aria-expanded'), 'true')
    assert.equal(pastButton.getAttribute('data-selected'), 'true')
    assert.ok(dom.window.document.querySelector('[data-file-emergence-project="品牌空间案例研究"]'))

    const firstProject = dom.window.document.querySelector('[data-file-emergence-project="品牌空间案例研究"]') as HTMLElement | null
    const secondProject = dom.window.document.querySelector('[data-file-emergence-project="门店图片数据库"]') as HTMLElement | null
    assert.ok(firstProject)
    assert.ok(secondProject)
    flushSync(() => {
      firstProject.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(firstProject.getAttribute('data-selected'), 'true')
    assert.equal(dom.window.document.querySelectorAll('[data-selected="true"]').length, 1)

    flushSync(() => {
      secondProject.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(firstProject.getAttribute('data-selected'), null)
    assert.equal(secondProject.getAttribute('data-selected'), 'true')
    assert.equal(dom.window.document.querySelectorAll('[data-selected="true"]').length, 1)

    await new Promise((resolve) => setTimeout(resolve, 0))
    const stored = JSON.parse(dom.window.localStorage.getItem('ready:file-emergence:ui-state:v1') ?? '{}') as {
      expandedBucket?: string
      expandedProjects?: string[]
      selectedItemKey?: string
    }
    assert.equal(stored.expandedBucket, 'past')
    assert.deepEqual(new Set(stored.expandedProjects), new Set(['品牌空间案例研究', '门店图片数据库']))
    assert.equal(stored.selectedItemKey, 'project:门店图片数据库')

    flushSync(() => root?.unmount())
    root = null
    root = createRoot(rootElement)
    flushSync(() => {
      root?.render(createElement(FileEmergenceSection, {
        viewModel: makeViewModel(),
        isRefreshing: false,
        onRefresh: () => {},
        onOpenFile: () => {},
      }))
    })

    const restoredPastButton = dom.window.document.querySelector('[data-file-emergence-bucket="past"]') as HTMLElement | null
    const restoredSecondProject = dom.window.document.querySelector('[data-file-emergence-project="门店图片数据库"]') as HTMLElement | null
    assert.ok(restoredPastButton)
    assert.ok(restoredSecondProject)
    assert.equal(restoredPastButton.getAttribute('aria-expanded'), 'true')
    assert.equal(restoredSecondProject.getAttribute('data-selected'), 'true')
    assert.equal(dom.window.document.querySelectorAll('[data-selected="true"]').length, 1)
  } finally {
    flushSync(() => root?.unmount())
    await new Promise((resolve) => setTimeout(resolve, 0))
    cleanup()
  }
})

test('file emergence persists project rename and file reassignment through identity IPC', async () => {
  const { dom, rootElement, cleanup } = installDom()
  const root = createRoot(rootElement)
  const renameCalls: unknown[] = []
  const assignCalls: unknown[] = []
  const createCalls: unknown[] = []
  let refreshCalls = 0
  Object.defineProperty(dom.window, 'electronAPI', {
    configurable: true,
    value: {
      fileEmergence: {
        renameProject: async (payload: unknown) => { renameCalls.push(payload); return { success: true } },
        assignFile: async (payload: unknown) => { assignCalls.push(payload); return { success: true } },
        createProjectForFile: async (payload: unknown) => { createCalls.push(payload); return { success: true } },
      },
    },
  })

  try {
    flushSync(() => {
      root.render(createElement(FileEmergenceSection, {
        viewModel: makeViewModel(),
        isRefreshing: false,
        onRefresh: () => { refreshCalls += 1 },
        onOpenFile: () => {},
        workspaceRoots: ['/workspace'],
      }))
    })
    const past = dom.window.document.querySelector('[data-file-emergence-bucket="past"]') as HTMLElement
    flushSync(() => past.click())
    const rename = dom.window.document.querySelector('[aria-label="重命名项目 品牌空间案例研究"]') as HTMLButtonElement
    flushSync(() => rename.click())
    const input = dom.window.document.querySelector('[aria-label="项目名称"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, '用户修正名称')
    flushSync(() => input.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
    const confirm = dom.window.document.querySelector('[aria-label="确认项目名称"]') as HTMLButtonElement
    flushSync(() => { confirm.click() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(renameCalls, [{ projectKey: 'project-品牌空间案例研究', displayName: '用户修正名称', workspaceRoots: ['/workspace'] }])

    const projectRow = dom.window.document.querySelector('[data-file-emergence-project="品牌空间案例研究"]') as HTMLElement
    flushSync(() => projectRow.click())
    const assign = dom.window.document.querySelector('[aria-label="调整 brief.pdf 的项目归属"]') as HTMLElement
    flushSync(() => assign.click())
    const select = dom.window.document.querySelector('[aria-label="选择目标项目"]') as HTMLSelectElement
    select.value = 'project-门店图片数据库'
    flushSync(() => select.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(assignCalls, [{
      projectKey: 'project-门店图片数据库',
      path: '/workspace/品牌空间案例研究/brief.pdf',
      workspaceRoots: ['/workspace'],
    }])
    flushSync(() => assign.click())
    const newSelect = dom.window.document.querySelector('[aria-label="选择目标项目"]') as HTMLSelectElement
    newSelect.value = '__new__'
    flushSync(() => newSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
    const newName = dom.window.document.querySelector('[aria-label="新项目名称"]') as HTMLInputElement
    const inputSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
    inputSetter?.call(newName, '独立新项目')
    const create = dom.window.document.querySelector('[aria-label="确认新建项目"]') as HTMLButtonElement
    flushSync(() => create.click())
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(createCalls, [{
      displayName: '独立新项目',
      path: '/workspace/品牌空间案例研究/brief.pdf',
      workspaceRoots: ['/workspace'],
    }])
    assert.equal(refreshCalls, 3)
  } finally {
    flushSync(() => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 0))
    cleanup()
  }
})

test('file emergence refresh control shares the bucket count column', async () => {
  const { dom, rootElement, cleanup } = installDom()
  const root = createRoot(rootElement)
  let refreshCalls = 0

  try {
    flushSync(() => {
      root.render(createElement(FileEmergenceSection, {
        viewModel: makeViewModel(),
        isRefreshing: false,
        onRefresh: () => { refreshCalls += 1 },
        onOpenFile: () => {},
      }))
    })

    const refreshButton = dom.window.document.querySelector('[aria-label="重新涌现"]') as HTMLButtonElement | null
    assert.ok(refreshButton)
    assert.match(refreshButton.className, /justify-self-center/)
    assert.match(refreshButton.parentElement?.className ?? '', /grid-cols-\[22px_82px_minmax\(0,1fr\)_24px\]/)

    flushSync(() => {
      refreshButton.click()
    })
    assert.equal(refreshCalls, 1)
  } finally {
    flushSync(() => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 0))
    cleanup()
  }
})

test('file emergence renders each classified empty state instead of disappearing', async () => {
  const labels = {
    no_trusted_candidates: '暂时没有足够可信的项目',
    sources_degraded: '部分记录暂时无法读取，请稍后刷新',
    insufficient_history: '使用记录还不够，继续工作后会逐渐出现',
    all_suppressed: '推荐项目都已隐藏或延后',
  } as const

  for (const [emptyState, label] of Object.entries(labels)) {
    const { dom, rootElement, cleanup } = installDom()
    const root = createRoot(rootElement)
    try {
      const viewModel = makeViewModel()
      viewModel.totalProjects = 0
      viewModel.emptyState = emptyState as keyof typeof labels
      viewModel.buckets = viewModel.buckets.map((bucket) => ({ ...bucket, projects: [] }))
      flushSync(() => {
        root.render(createElement(FileEmergenceSection, {
          viewModel,
          isRefreshing: false,
          onRefresh: () => {},
          onOpenFile: () => {},
        }))
      })
      const empty = dom.window.document.querySelector(`[data-file-emergence-empty-state="${emptyState}"]`)
      assert.equal(empty?.textContent?.trim(), label)
    } finally {
      flushSync(() => root.unmount())
      await new Promise((resolve) => setTimeout(resolve, 0))
      cleanup()
    }
  }
})

test('file emergence records project feedback and restores suppressed projects', async () => {
  const { dom, rootElement, cleanup } = installDom()
  const root = createRoot(rootElement)
  const feedbackCalls: unknown[] = []
  let refreshCalls = 0
  Object.defineProperty(dom.window, 'electronAPI', {
    configurable: true,
    value: { fileEmergence: {
      feedbackProject: async (payload: unknown) => { feedbackCalls.push(payload); return { success: true } },
      listSuppressed: async () => ({ success: true, data: [{ projectKey: 'project-hidden', displayName: '已隐藏项目', reason: 'hidden', until: null }] }),
    } },
  })
  try {
    flushSync(() => root.render(createElement(FileEmergenceSection, { viewModel: makeViewModel(), isRefreshing: false, onRefresh: () => { refreshCalls += 1 }, onOpenFile: () => {}, workspaceRoots: ['/workspace'] })))
    flushSync(() => (dom.window.document.querySelector('[data-file-emergence-bucket="past"]') as HTMLElement).click())
    flushSync(() => (dom.window.document.querySelector('[data-file-emergence-project="品牌空间案例研究"]') as HTMLElement).click())
    const notRelated = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === '不相关') as HTMLButtonElement
    flushSync(() => notRelated.click())
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal((feedbackCalls[0] as {action:string}).action, 'not_related')
    assert.equal(refreshCalls, 1)

    const suppressed = makeViewModel()
    suppressed.totalProjects = 0
    suppressed.emptyState = 'all_suppressed'
    suppressed.buckets = suppressed.buckets.map((bucket) => ({ ...bucket, projects: [] }))
    flushSync(() => root.render(createElement(FileEmergenceSection, { viewModel: suppressed, isRefreshing: false, onRefresh: () => { refreshCalls += 1 }, onOpenFile: () => {}, workspaceRoots: ['/workspace'] })))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const restore = dom.window.document.querySelector('[aria-label="恢复项目 已隐藏项目"]') as HTMLButtonElement
    assert.ok(restore)
    flushSync(() => restore.click())
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal((feedbackCalls[1] as {action:string}).action, 'restore')
    assert.equal(refreshCalls, 2)
  } finally {
    flushSync(() => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 0))
    cleanup()
  }
})
