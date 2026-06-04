import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  resolveBrowserCollectionIntent,
  isBrowserCollectionSubsetTool,
  isHighControlPlatformText,
  BROWSER_COLLECTION_SUBSET_TOOL_NAMES,
} from '../shared/browser-collection-intent'

describe('resolveBrowserCollectionIntent — positive (expose browser collection)', () => {
  const positives = [
    '把你能看到的这个博主的笔记，每篇都新建文件夹，把图片保存进去', // collection verb + web object (笔记/图片)
    '用我的登录态，开一个独立网页用 rpa 来操作',                    // explicit browser surface
    '去小红书采集这个博主主页的所有笔记和图片',                      // platform + collection
    '帮我爬一下抖音这个号的视频封面',                               // platform + collection
    '把这个页面的评论都收集下来',                                   // explicit browser surface + collection
    '下载微博这个博主相册里的图片',                                 // platform + collection
  ]
  for (const text of positives) {
    it(`exposes: ${text.slice(0, 24)}`, () => {
      assert.equal(resolveBrowserCollectionIntent(text), true)
    })
  }
})

describe('resolveBrowserCollectionIntent — negative (keep document mode)', () => {
  const negatives = [
    '把这张图保存到 @[白痴.md] 的第二章',          // document anchor wins
    '帮我整理一下我上传的附件',                     // attachment housekeeping, no web surface
    '读一下这个 docx 然后改写第三段',               // local file + 改写
    '给这篇文档插入一个趋势图 widget',              // widget/document
    '把原文这一段润色一下并排版',                   // strong document signal
    '你是谁',                                       // no intent at all
    '',                                             // empty
    '把这张图片下载到本地',                          // bare image download, no web surface (Codex R1 #3)
    '保存这张照片到桌面',                            // bare photo save
    '帮我整理一下这些图片',                          // bare image housekeeping
  ]
  for (const text of negatives) {
    it(`does NOT expose: ${text.slice(0, 24) || '(empty)'}`, () => {
      assert.equal(resolveBrowserCollectionIntent(text), false)
    })
  }
})

describe('document signal priority', () => {
  it('platform present overrides a document save phrasing (小红书 + 保存到文档 → expose)', () => {
    assert.equal(resolveBrowserCollectionIntent('把小红书这个博主的图片保存到文档里'), true)
  })
  it('pure document save without a web surface → do not expose', () => {
    assert.equal(resolveBrowserCollectionIntent('把这张图片保存到当前文档'), false)
  })
})

describe('collection subset white-list', () => {
  it('includes navigation/read/collect/download/task tools', () => {
    for (const name of ['browser_navigate', 'browser_read_page', 'browser_visible_collect', 'browser_download_urls', 'browser_get_task']) {
      assert.equal(isBrowserCollectionSubsetTool(name), true, `${name} should be in subset`)
    }
  })
  it('EXCLUDES high-risk script and form-write/transmit tools', () => {
    for (const name of ['browser_execute_js', 'browser_run_workflow', 'browser_type', 'browser_type_at', 'browser_compose_message', 'browser_send_keys', 'browser_upload_scope_attachment']) {
      assert.equal(isBrowserCollectionSubsetTool(name), false, `${name} must NOT be in subset`)
    }
  })
  it('the subset is a small curated list, not the whole catalog', () => {
    assert.ok(BROWSER_COLLECTION_SUBSET_TOOL_NAMES.length > 0 && BROWSER_COLLECTION_SUBSET_TOOL_NAMES.length < 30)
  })
})

describe('high-control platform detection', () => {
  it('recognizes 小红书 / 抖音 / 微博 / bilibili', () => {
    assert.equal(isHighControlPlatformText('小红书'), true)
    assert.equal(isHighControlPlatformText('打开抖音'), true)
    assert.equal(isHighControlPlatformText('weibo.com'), true)
    assert.equal(isHighControlPlatformText('bilibili 视频'), true)
  })
  it('does not flag a generic site', () => {
    assert.equal(isHighControlPlatformText('打开 github.com'), false)
  })
})
