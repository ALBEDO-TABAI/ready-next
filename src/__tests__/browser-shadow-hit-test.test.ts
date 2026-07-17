/**
 * R18（真机第十七轮实锚）—— closed shadow 命中扫描的状态读取合同。
 *
 * 第十七轮铁证：逃生扫描命中「发布」、坐标落在按钮内部、可信指针点击，
 * 页面仍无变化——差的不是坐标而是按钮内部状态（disabled/遮挡）与页面
 * 瞬时校验提示。本文件用脚本化 CDP 假端断言：
 *   1. 扫描候选携带 disabled / rect / cover；
 *   2. 选点优先控件真实 rect 中心（采样均值会被 host rect 采样分布拉偏）；
 *   3. 扫描只返回可信坐标，不在页面内触发合成 click()；
 *   4. buildTransientNoticeProbeJs 采集 fixed/高 z-index 的瞬时提示文本。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  scanClosedShadowHostForClickPoint,
} from '../main/modules/tools/browser-shadow-hit-test'
import { buildTransientNoticeProbeJs } from '../main/modules/tools/browser-probe'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-shadow-hit-test declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-shadow-hit-test transitive sqlite load')
})

const HOST_RECT = { left: 434, top: 830, width: 270, height: 42 }
const VIEWPORT = { vw: 1026, vh: 896 }

interface FakeButtonSpec {
  backendNodeId: number
  xMin: number
  xMax: number
  text: string
  disabled: boolean
  rect: { left: number; top: number; width: number; height: number }
  cover?: string
}

function makeScriptedCdpController(buttons: FakeButtonSpec[]): {
  controller: BrowserController
  calls: Array<{ method: string; params: Record<string, unknown> }>
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const byId = new Map(buttons.map((b) => [b.backendNodeId, b]))
  const controller = {
    async sendCdpCommand(_tabId: string | null, method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'DOM.getNodeForLocation') {
        const x = Number(params.x)
        const hit = buttons.find((b) => x >= b.xMin && x <= b.xMax)
        return { backendNodeId: hit ? hit.backendNodeId : 100 }
      }
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: `obj-${Number(params.backendNodeId)}` } }
      }
      if (method === 'Runtime.callFunctionOn') {
        const objectId = String(params.objectId || '')
        const backendNodeId = Number(objectId.replace('obj-', ''))
        const button = byId.get(backendNodeId)
        const declaration = String(params.functionDeclaration || '')
        // HIT_NODE_DESCRIBE_FN 路径
        if (!button) {
          return {
            result: {
              value: {
                tag: 'div', role: '', text: '', interactive: false, isHost: false,
                disabled: false, rect: null, cover: '',
              },
            },
          }
        }
        return {
          result: {
            value: {
              tag: 'button',
              role: '',
              text: button.text,
              interactive: true,
              isHost: false,
              disabled: button.disabled,
              rect: button.rect,
              cover: button.cover ?? '',
            },
          },
        }
      }
      return {}
    },
  }
  return { controller: controller as unknown as BrowserController, calls }
}

function xhsPublishButtons(options: { publishDisabled: boolean }): FakeButtonSpec[] {
  return [
    {
      backendNodeId: 101,
      xMin: 444,
      xMax: 544,
      text: '暂存离开',
      disabled: false,
      rect: { left: 444, top: 832, width: 100, height: 38 },
    },
    {
      backendNodeId: 102,
      xMin: 594,
      xMax: 704,
      text: '发布',
      disabled: options.publishDisabled,
      rect: { left: 594, top: 832, width: 100, height: 38 },
    },
  ]
}

test('scan carries disabled state and prefers the matched control rect center over sample average', async () => {
  const { controller } = makeScriptedCdpController(xhsPublishButtons({ publishDisabled: true }))
  const scan = await scanClosedShadowHostForClickPoint(
    controller,
    'tab-1',
    HOST_RECT,
    VIEWPORT,
    { targetName: 'xhs-publish-btn', disambiguation: '发布页面底部主发布按钮' },
  )
  assert.equal(scan.via, 'disambiguation_match')
  assert.equal(scan.matchedText, '发布')
  // rect 中心 (594 + 100/2, 832 + 38/2) = (644, 851)；采样均值 ≈ 651.35，
  // 若断言失败说明选点退回了采样均值。
  assert.equal(scan.point?.cssX, 644)
  assert.equal(scan.point?.cssY, 851)
  const publish = scan.candidates.find((c) => c.text === '发布')
  const stash = scan.candidates.find((c) => c.text === '暂存离开')
  assert.equal(publish?.disabled, true, 'publish button disabled state must surface')
  assert.equal(publish?.rect?.left, 594)
  assert.equal(stash?.disabled, false)
})

test('scan matches by exact map target name when unique', async () => {
  const { controller } = makeScriptedCdpController(xhsPublishButtons({ publishDisabled: false }))
  const scan = await scanClosedShadowHostForClickPoint(
    controller,
    'tab-1',
    HOST_RECT,
    VIEWPORT,
    { targetName: '发布', disambiguation: '' },
  )
  assert.equal(scan.via, 'name_match')
  assert.equal(scan.point?.cssX, 644)
})

test('scan refuses to pick a point among ambiguous candidates', async () => {
  const { controller } = makeScriptedCdpController(xhsPublishButtons({ publishDisabled: false }))
  const scan = await scanClosedShadowHostForClickPoint(
    controller,
    'tab-1',
    HOST_RECT,
    VIEWPORT,
    { targetName: '', disambiguation: '' },
  )
  assert.equal(scan.point, null)
  assert.equal(scan.candidates.length, 2)
})

test('closed-shadow scan returns a point without invoking page-side synthetic click', async () => {
  const { controller, calls } = makeScriptedCdpController(xhsPublishButtons({ publishDisabled: false }))
  const scan = await scanClosedShadowHostForClickPoint(
    controller,
    'tab-1',
    HOST_RECT,
    VIEWPORT,
    { targetName: '发布', disambiguation: '' },
  )
  assert.deepEqual(scan.point, { cssX: 644, cssY: 851 })
  assert.equal(calls.some((call) =>
    call.method === 'Runtime.callFunctionOn' && String(call.params.functionDeclaration || '').includes('.click()')
  ), false)
})

test('transient notice probe collects fixed/high-z short texts and skips inline content', () => {
  class SandboxElement {
    className: string
    innerText: string
    private readonly cs: Record<string, string>
    private readonly rect: { width: number; height: number }

    constructor(options: {
      className?: string
      text?: string
      position?: string
      zIndex?: string
      width?: number
      height?: number
      display?: string
    }) {
      this.className = options.className ?? ''
      this.innerText = options.text ?? ''
      this.cs = {
        display: options.display ?? 'block',
        visibility: 'visible',
        opacity: '1',
        position: options.position ?? 'static',
        zIndex: options.zIndex ?? 'auto',
      }
      this.rect = { width: options.width ?? 300, height: options.height ?? 48 }
    }

    getBoundingClientRect() {
      return this.rect
    }

    computedStyle() {
      return this.cs
    }
  }

  const toast = new SandboxElement({ className: 'd-toast', text: '笔记描述不能为空', position: 'fixed' })
  const duplicateToast = new SandboxElement({ className: 'toast-item', text: '笔记描述不能为空', position: 'fixed' })
  const inlineBlock = new SandboxElement({ className: 'message-body', text: '正文里的普通段落', position: 'static' })
  const lowZAbsolute = new SandboxElement({ className: 'tips-inline', text: '低层绝对定位不算 toast', position: 'absolute', zIndex: '3' })
  const highZAbsolute = new SandboxElement({ className: 'alert-pop', text: '请先添加封面', position: 'absolute', zIndex: '2000' })
  const hiddenToast = new SandboxElement({ className: 'd-toast', text: '看不见的提示', position: 'fixed', display: 'none' })

  const result = vm.runInNewContext(buildTransientNoticeProbeJs(), {
    HTMLElement: SandboxElement,
    document: {
      querySelectorAll: () => [toast, duplicateToast, inlineBlock, lowZAbsolute, highZAbsolute, hiddenToast],
    },
    getComputedStyle: (el: SandboxElement) => el.computedStyle(),
  })

  // vm 返回的是另一 realm 的 Array（原型不同），先落回本 realm 再深比
  assert.deepEqual([...(result as string[])], ['笔记描述不能为空', '请先添加封面'])
})
