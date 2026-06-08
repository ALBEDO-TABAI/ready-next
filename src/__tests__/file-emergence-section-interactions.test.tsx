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
    totalProjects: 1,
    defaultExpandedBucket: 'past',
    buckets: [
      { bucket: 'future', label: '未来', projects: [] },
      { bucket: 'today', label: '今天', projects: [] },
      { bucket: 'past', label: '过去', projects: [makeProject('品牌空间案例研究', 'past')] },
      { bucket: 'distant', label: '遥远', projects: [] },
    ],
  }
}

test('file emergence section renders all bucket rows and lets the open bucket collapse', async () => {
  const { dom, rootElement, cleanup } = installDom()
  const root = createRoot(rootElement)

  try {
    flushSync(() => {
      root.render(createElement(FileEmergenceSection, {
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
    assert.equal(pastButton.getAttribute('aria-expanded'), 'true')
    assert.ok(dom.window.document.querySelector('[data-file-emergence-project="品牌空间案例研究"]'))

    flushSync(() => {
      pastButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(pastButton.getAttribute('aria-expanded'), 'false')
    assert.equal(dom.window.document.querySelector('[data-file-emergence-project="品牌空间案例研究"]'), null)

    const futureButton = dom.window.document.querySelector('[data-file-emergence-bucket="future"]') as HTMLElement | null
    assert.ok(futureButton)
    flushSync(() => {
      futureButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(futureButton.getAttribute('aria-expanded'), 'true')
    assert.match(rootElement.textContent ?? '', /暂无项目/)
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    flushSync(() => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 0))
    cleanup()
  }
})
