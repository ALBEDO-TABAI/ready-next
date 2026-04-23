import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { filterAttachmentsForComposedAgentInput } from '../renderer/modules/agent/messageComposer'
import { createDocumentWidgetTargetAttachment } from '../renderer/modules/agent/widget-target-attachment'

function makeAttachment() {
  return createDocumentWidgetTargetAttachment({
    documentTitle: '新文档.md',
    documentPath: '/tmp/新文档.md',
    tabId: undefined,
    widgetTitle: 'quarterly_kpi',
    widgetId: 'widget_quarterly_kpi',
    widgetCode: '<div>demo</div>',
    widgetMode: 'scripted',
  })
}

describe('messageComposer widget subject heuristic (G-Z8 收敛)', () => {
  it('drops widget attachment when only ambient doc nouns appear and no pronoun prefix', () => {
    const attachment = makeAttachment()
    // 不以 pronoun_prefix 词（再/继续/把/让/…/改）开头，纯 ambient 主语，应被过滤
    const kept = filterAttachmentsForComposedAgentInput('段落结构需要重新调整', [attachment])
    assert.equal(kept.length, 0, '仅 ambient 主语 + 无 pronoun 前缀不应触发 widget sticky')
  })

  it('drops widget attachment for plain content about 正文 / 章节 / 文档 without pronoun prefix', () => {
    const attachment = makeAttachment()
    for (const prompt of ['正文似乎需要润色', '章节顺序似乎错了', '文档整体重新组织']) {
      const kept = filterAttachmentsForComposedAgentInput(prompt, [attachment])
      assert.equal(kept.length, 0, `"${prompt}" 不应保留 widget attachment`)
    }
  })

  it('keeps widget attachment when strong widget subject co-occurs with an edit verb', () => {
    const attachment = makeAttachment()
    const kept = filterAttachmentsForComposedAgentInput('把信息卡改成蓝色', [attachment])
    assert.equal(kept.length, 1)
  })

  it('keeps widget attachment when strong widget subject and 段落 co-occur', () => {
    const attachment = makeAttachment()
    const kept = filterAttachmentsForComposedAgentInput('把图表里的段落改短', [attachment])
    assert.equal(kept.length, 1)
  })

  it('keeps widget attachment under pronoun_prefix short continuation', () => {
    const attachment = makeAttachment()
    const kept = filterAttachmentsForComposedAgentInput('再调一下', [attachment])
    assert.equal(kept.length, 1)
  })
})
