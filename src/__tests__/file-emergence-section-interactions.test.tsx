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
