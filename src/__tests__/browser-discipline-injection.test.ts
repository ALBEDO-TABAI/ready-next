import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import { BrowserDomainAdapter } from '../main/modules/agent-control/domain-adapters/browser-domain-adapter'
import { PromptAssetLoader } from '../main/modules/agent-control/prompt-assets/loader'

const DISCIPLINE = '浏览器交互纪律：五步配方 + 定位器优先级 + 风险站点硬规则'

function makeAdapter(text: string): BrowserDomainAdapter {
  // orchestrator is unused by contributePromptFragment.
  return new BrowserDomainAdapter({} as never, text)
}

test('discipline fragment is contributed and carries inline asset text', () => {
  const fragments = makeAdapter(DISCIPLINE).contributePromptFragment() ?? []
  const discipline = fragments.find((f) => f.id === 'browser-discipline')
  assert.ok(discipline, 'browser-discipline fragment must be present')
  assert.equal(discipline!.refs[0].text, DISCIPLINE)
  assert.equal(discipline!.refs[0].path, null)
})

test('discipline fragment matches browser intent, not arbitrary text', () => {
  const fragments = makeAdapter(DISCIPLINE).contributePromptFragment() ?? []
  const discipline = fragments.find((f) => f.id === 'browser-discipline')!
  // browser intent (matchesBrowserPromptTrigger covers 上传/输入/打开网页 etc.)
  assert.ok(discipline.matches({ userText: '帮我打开网页上传这个文件', route: null }))
  // arbitrary non-browser text does not trigger it
  assert.ok(!discipline.matches({ userText: '今天天气怎么样', route: null }))
})

test('no discipline fragment when text is empty (asset failed to load)', () => {
  const fragments = makeAdapter('').contributePromptFragment() ?? []
  assert.ok(!fragments.some((f) => f.id === 'browser-discipline'))
  // legacy fragments still present
  assert.ok(fragments.some((f) => f.id === 'browser-collect-notes'))
})

test('shipped discipline asset parses and renders within budget', () => {
  const loader = new PromptAssetLoader({ roots: [join(process.cwd(), 'assets', 'prompts')] })
  const asset = loader.load('browser/discipline')
  assert.equal(asset.name, 'browser-discipline')
  assert.deepEqual(asset.variables, [])
  const rendered = loader.render('browser/discipline')
  assert.ok(rendered.includes('交互五步配方'))
  assert.ok(rendered.includes('riskLevel=high'))
  assert.ok(rendered.length <= 2500, 'discipline must fit the 2500-char fragment budget')
})
