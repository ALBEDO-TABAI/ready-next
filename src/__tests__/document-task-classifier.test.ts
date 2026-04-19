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

  it('keeps UPDATE for "优化当前信息卡"', () => {
    assert.equal(classifyStructuredDocumentIntent('优化当前信息卡'), 'document_read_then_widget_update')
  })

  it('keeps UPDATE for "修改这个 widget，把标题改成指引"', () => {
    assert.equal(
      classifyStructuredDocumentIntent('修改这个 widget，把标题改成指引'),
      'document_read_then_widget_update',
    )
  })

  it('keeps LIST for pure query without edit verbs', () => {
    assert.equal(classifyStructuredDocumentIntent('看一下有哪些卡片'), 'document_list_widgets')
  })

  it('suppresses LIST routing when an edit verb co-occurs with LIST keywords', () => {
    // "看一下…改成…" 同时携带 LIST 关键词与编辑动词；LIST 必须被抑制，否则会把 list 原文当答案。
    // UPDATE regex 依赖顺序 (edit-verb before widget keyword) 未命中时，应回落到 null 让 pipeline 走非结构化路径，
    // 而不是继续走 LIST 分支。
    assert.equal(
      classifyStructuredDocumentIntent('看一下当前这个卡片，能不能改成蓝色'),
      null,
    )
  })

  it('returns null when input starts with a structured attachment header', () => {
    assert.equal(
      classifyStructuredDocumentIntent('### Widget 更新上下文\n卡片列表：指引 / 进度'),
      null,
    )
  })
})
