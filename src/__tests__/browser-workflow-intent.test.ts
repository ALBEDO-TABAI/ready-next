import assert from 'node:assert/strict'
import test from 'node:test'

import {
  browserWorkflowIntentToDecisionMode,
  resolveBrowserWorkflowIntent,
} from '../shared/browser-workflow-intent'

test('publish/upload/submit/form wording routes to browser transaction workflow', () => {
  const cases = [
    ['从小红书创作服务平台新建笔记，内容是今天天气不错', 'publish', 'browser_workflow'],
    ['写一篇小红书，发到小红书', 'publish', 'browser_workflow'],
    ['发一篇普通长文笔记，今天心情很好', 'publish', 'browser_workflow'],
    ['打开发布页，选择文字配图，然后提交草稿', 'publish', 'browser_workflow'],
    ['在网页上传这张图片并发布', 'upload', 'browser_upload_workflow'],
    ['在当前页面提交表单', 'submit', 'browser_workflow'],
    ['帮我填写这个网页表单', 'form', 'browser_workflow'],
  ] as const

  for (const [text, transactionKind, mode] of cases) {
    const intent = resolveBrowserWorkflowIntent(text)
    assert.equal(intent.kind, 'transaction', text)
    assert.equal(intent.transactionKind, transactionKind, text)
    assert.equal(browserWorkflowIntentToDecisionMode(intent), mode, text)
  }
})

test('collection wording remains collection and does not steal transaction wording', () => {
  const collection = resolveBrowserWorkflowIntent('把这个网页里的图片批量采集到文件夹')
  assert.equal(collection.kind, 'collection')
  assert.equal(browserWorkflowIntentToDecisionMode(collection), 'free_tool_loop')

  const transaction = resolveBrowserWorkflowIntent('把这句话发到小红书，不要采集内容')
  assert.equal(transaction.kind, 'transaction')
  assert.equal(transaction.transactionKind, 'publish')
})

test('local IM delivery wording is not treated as webpage publish transaction', () => {
  const intent = resolveBrowserWorkflowIntent('把小红书这个博主的图片都采集下来，并把这四张图发到我微信')
  assert.equal(intent.kind, 'observe')
  assert.equal(intent.reason, 'local_delivery')
  assert.equal(browserWorkflowIntentToDecisionMode(intent), 'free_tool_loop')
})
