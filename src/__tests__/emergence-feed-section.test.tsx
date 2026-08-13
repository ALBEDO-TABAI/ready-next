/**
 * 梯队三 — EmergenceFeedSection 行为测试（JSDOM）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import { EmergenceFeedSection } from '../renderer/components/ready/EmergenceFeedSection'

const DOM_GLOBAL_KEYS = ['window', 'document', 'HTMLElement', 'Node', 'Element', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

async function withDom(
  emergenceApi: unknown,
  fn: (root: Root, container: HTMLElement) => Promise<void>,
): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = Object.fromEntries(
    DOM_GLOBAL_KEYS.map((key) => [key, (globalThis as Record<string, unknown>)[key]]),
  )
  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Element', dom.window.Element)
  setGlobal('navigator', dom.window.navigator)
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;(dom.window as unknown as Record<string, unknown>).electronAPI = emergenceApi === undefined
    ? {}
    : { emergence: emergenceApi }

  const container = dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  try {
    await fn(root, container)
  } finally {
    await act(async () => root.unmount())
    for (const key of DOM_GLOBAL_KEYS) setGlobal(key, previous[key])
  }
}

const FOLLOW_UP_ENTRY = {
  card: {
    id: 'followup:adjudicate:task-1',
    type: 'follow_up',
    title: '「写周报」完成待裁决',
    evidence: [{ fact: 'interaction_state=check_in_pending', ref: 'task:task-1' }],
    confidence: 0.85,
    action: { kind: 'adjudicate_task', ref: 'task-1' },
    requiresExplicitConfirm: false,
  },
  scopeId: 'scope-1',
}

const SITE_REVIEW_ENTRY = {
  card: {
    id: 'crystallize:site:knowledge/x.md',
    type: 'crystallize',
    title: '浏览器发现「站点规则」有风险提示待你处理',
    evidence: [{ fact: 'staged 站点卡 source=possible-risk-update-of:site-x', ref: 'knowledge/x.md' }],
    confidence: 0.7,
    action: { kind: 'review_duplicate', ref: 'knowledge/x.md' },
    requiresExplicitConfirm: true,
  },
  scopeId: null,
}

test('renders live feed entries with evidence and routes scope vs site-review exits', async () => {
  const opened: string[] = []
  let settingsOpened = 0
  await withDom(
    { feed: async () => ({ success: true, data: [FOLLOW_UP_ENTRY, SITE_REVIEW_ENTRY] }) },
    async (root, container) => {
      await act(async () => {
        root.render(createElement(EmergenceFeedSection, {
          onOpenScope: (scopeId: string) => { opened.push(scopeId) },
          onOpenSettings: () => { settingsOpened += 1 },
        }))
      })
      assert.ok(container.querySelector('[data-ready-emergence-feed]'))
      assert.match(container.textContent || '', /完成待裁决/)
      assert.match(container.textContent || '', /check_in_pending/)

      const adjudicateButton = container.querySelector('[data-ready-emergence-action="adjudicate_task"]') as HTMLButtonElement
      await act(async () => { adjudicateButton.click() })
      assert.deepEqual(opened, ['scope-1'])

      const reviewButton = container.querySelector('[data-ready-emergence-action="review_duplicate"]') as HTMLButtonElement
      await act(async () => { reviewButton.click() })
      assert.equal(settingsOpened, 1)
    },
  )
})

test('hides entirely when the feed is empty or the API is missing', async () => {
  await withDom(
    { feed: async () => ({ success: true, data: [] }) },
    async (root, container) => {
      await act(async () => {
        root.render(createElement(EmergenceFeedSection, { onOpenScope: () => {}, onOpenSettings: () => {} }))
      })
      assert.equal(container.querySelector('[data-ready-emergence-feed]'), null)
    },
  )
  await withDom(undefined, async (root, container) => {
    await act(async () => {
      root.render(createElement(EmergenceFeedSection, { onOpenScope: () => {}, onOpenSettings: () => {} }))
    })
    assert.equal(container.querySelector('[data-ready-emergence-feed]'), null)
  })
})

test('file action failure is shown on the card surface',async()=>{
  const entry={card:{id:'prepare:p',projectKey:'p',type:'prepare',title:'准备发布',evidence:[{fact:'五天后',ref:'cal'}],confidence:.8,action:{kind:'open_project',ref:'p',targetPath:'/gone.md'},requiresExplicitConfirm:false},scopeId:null}
  await withDom({feed:async()=>({success:true,data:[entry]})},async(root,container)=>{
    await act(async()=>root.render(createElement(EmergenceFeedSection,{onOpenScope:()=>{},onOpenSettings:()=>{}})))
    const button=container.querySelector('[data-ready-emergence-action="open_project"]') as HTMLButtonElement
    await act(async()=>{button.click();await new Promise((resolve)=>setTimeout(resolve,0))})
    assert.match(container.querySelector('[role="alert"]')?.textContent||'',/已移动或删除/)
  })
})
