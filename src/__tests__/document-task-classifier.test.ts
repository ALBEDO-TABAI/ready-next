import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyStructuredDocumentIntent } from '../main/modules/agent-control/document-task-types'

describe('classifyStructuredDocumentIntent', () => {
  it('routes create requests that pair widget generation with document reading', () => {
    const intent = classifyStructuredDocumentIntent('先阅读当前文档，然后做一个项目定位信息卡')
    assert.equal(intent, 'document_read_then_widget_create')
  })

  it('routes update requests targeting existing widgets', () => {
    const intent = classifyStructuredDocumentIntent('把这个信息卡改成极简风格')
    assert.equal(intent, 'document_read_then_widget_update')
  })

  it('routes list requests referencing widgets/cards', () => {
    assert.equal(classifyStructuredDocumentIntent('列出当前文档里的所有 widget'), 'document_list_widgets')
    assert.equal(classifyStructuredDocumentIntent('看看这个文档里有哪些信息卡'), 'document_list_widgets')
  })

  it('routes remove requests referencing widgets/cards', () => {
    assert.equal(classifyStructuredDocumentIntent('把当前文档里的那个信息卡删掉'), 'document_remove_widget')
    assert.equal(classifyStructuredDocumentIntent('移除这个 widget'), 'document_remove_widget')
  })

  it('returns null for unrelated questions', () => {
    assert.equal(classifyStructuredDocumentIntent('今天北京的天气怎么样'), null)
    assert.equal(classifyStructuredDocumentIntent(''), null)
  })

  it('prefers remove over generic update when keywords overlap', () => {
    const intent = classifyStructuredDocumentIntent('把这个已有的信息卡删除掉')
    assert.equal(intent, 'document_remove_widget')
  })
})
