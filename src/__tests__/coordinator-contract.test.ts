import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserDomainAdapter } from '../main/modules/agent-control/domain-adapters/browser-domain-adapter'
import { CalendarDomainAdapter } from '../main/modules/agent-control/domain-adapters/calendar-domain-adapter'
import { DocumentDomainAdapter } from '../main/modules/agent-control/domain-adapters/document-domain-adapter'
import { FeishuDomainAdapter } from '../main/modules/agent-control/domain-adapters/feishu-domain-adapter'
import { RSSDomainAdapter } from '../main/modules/agent-control/domain-adapters/rss-domain-adapter'
import { SkillDomainAdapter } from '../main/modules/agent-control/skills/skill-domain-adapter'

test('every registered DomainAdapter explicitly implements coordinator role hooks', () => {
  const adapters = [
    new BrowserDomainAdapter({} as never),
    new DocumentDomainAdapter({
      orchestrator: {} as never,
      toolLoopOrchestrator: {} as never,
    }),
    new SkillDomainAdapter(),
    new RSSDomainAdapter(),
    new CalendarDomainAdapter(),
    new FeishuDomainAdapter(),
  ]

  for (const adapter of adapters) {
    assert.equal(typeof (adapter as any).contributePromptFragment, 'function', `${adapter.id} prompt hook`)
    assert.equal(typeof (adapter as any).arbitrateRunCapabilities, 'function', `${adapter.id} arbitration hook`)
    assert.equal(typeof (adapter as any).decorateUserText, 'function', `${adapter.id} text decorator`)
  }
})

test('default coordinator hooks preserve existing behavior', () => {
  const adapter = new SkillDomainAdapter() as any

  assert.equal(adapter.contributePromptFragment(), null)
  assert.equal(adapter.arbitrateRunCapabilities({} as never), null)
  assert.equal(adapter.decorateUserText('hello', { phase: 'post_dispatch' }), 'hello')
})

test('document coordinator reports document force arbitration from tool policy', () => {
  const adapter = new DocumentDomainAdapter({
    orchestrator: {} as never,
    toolLoopOrchestrator: {} as never,
  })

  assert.deepEqual(
    adapter.arbitrateRunCapabilities({
      toolPolicy: { forceDocumentTool: true },
    } as never),
    { forceTool: 'document' }
  )
  assert.equal(
    adapter.arbitrateRunCapabilities({
      toolPolicy: { forceDocumentTool: false },
    } as never),
    null
  )
})
