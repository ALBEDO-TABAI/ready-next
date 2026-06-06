import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  resolveBrowserCollectionIntent,
  resolveBrowserBatchCollectionIntent,
  isBrowserCollectionSubsetTool,
  isBrowserBatchCollectionWorkflowTool,
  isHighControlPlatformText,
  stepCollectionIntentTtl,
  isBareContinuationInstruction,
  BROWSER_COLLECTION_SUBSET_TOOL_NAMES,
  BROWSER_BATCH_COLLECTION_WORKFLOW_TOOL_NAMES,
} from '../shared/browser-collection-intent'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'

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

describe('attached browser-page reference (full message text) exposes', () => {
  it('matches a 小红书 platform name embedded in a ### 浏览页面引用 reference section', () => {
    // The SDK passes the FULL message text (not primaryInstructionText, which
    // strips the reference section) to the predicate, so an attached page
    // reference still triggers exposure even with a bare instruction.
    const full = '再试一次看看\n\n### 浏览页面引用\nAoi葵 – 小红书 https://www.xiaohongshu.com/user/profile/abc'
    assert.equal(resolveBrowserCollectionIntent(full), true)
  })

  it('a bare retry with NO reference and NO platform does not match the predicate alone', () => {
    // (continuity / browse-page-reference marker handle this at the SDK layer;
    // the pure predicate on bare text stays false)
    assert.equal(resolveBrowserCollectionIntent('再重试一遍看看'), false)
  })
})

describe('bootstrap-leading envelope must not hide collection intent (regression)', () => {
  it('extracts the trailing user instruction past a ## L1 会话上下文 prefix and detects intent', () => {
    // The live bug: the prompt envelope leads with bootstrap sections (## L1 会话
    // 上下文 / ## L2…) and TRAILS the user instruction. The runtime's stale
    // primaryInstructionText assumed the instruction LEADS, so it saw only the
    // bootstrap preamble (no intent) and browser collection silently failed.
    // The fix routes the predicate through the envelope's canonical
    // primaryInstruction, which correctly extracts the trailing instruction.
    const userText = [
      '## L1 会话上下文',
      '（记忆内容）',
      '',
      '## 最近会话摘要',
      '用户之前提到小红书博主 Aoi 葵',
      '',
      '把你能看到的这个博主的笔记，每篇笔记都新建一个独立文件夹，把笔记内的图片保存到@[ao’i]这个文件夹下的对应文件夹中',
    ].join('\n')
    const envelope = buildRequestEnvelope({ userText })
    assert.match(envelope.primaryInstruction, /这个博主的笔记/, 'envelope extracts the trailing instruction, not the bootstrap')
    assert.equal(resolveBrowserCollectionIntent(envelope.primaryInstruction), true)
  })
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
    for (const name of ['browser_navigate', 'browser_read_page', 'browser_visible_collect', 'browser_resolve_video', 'browser_download_urls', 'browser_get_task']) {
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

describe('batch collection workflow subset', () => {
  it('detects multi-note/profile collection separately from ordinary single-page collection', () => {
    assert.equal(resolveBrowserBatchCollectionIntent('把这个博主的每篇笔记都保存图片'), true)
    assert.equal(resolveBrowserBatchCollectionIntent('继续\n\n## 最近会话摘要\n用户要采集小红书博主全部笔记'), true)
    assert.equal(resolveBrowserBatchCollectionIntent('下载当前页面里这张图片'), false)
  })

  it('keeps only background collection workflow tools for batch note collection', () => {
    for (const name of ['browser_visible_collect', 'browser_collect_notes', 'browser_resume_task', 'browser_get_task']) {
      assert.equal(isBrowserBatchCollectionWorkflowTool(name), true, `${name} should stay available`)
    }
    for (const name of ['browser_navigate', 'browser_click_text', 'browser_collect_images', 'browser_resolve_video', 'browser_download_urls', 'browser_extract_structured']) {
      assert.equal(isBrowserBatchCollectionWorkflowTool(name), false, `${name} must not be available for batch workflow`)
    }
    assert.ok(BROWSER_BATCH_COLLECTION_WORKFLOW_TOOL_NAMES.length > 0)
    assert.ok(BROWSER_BATCH_COLLECTION_WORKFLOW_TOOL_NAMES.length < BROWSER_COLLECTION_SUBSET_TOOL_NAMES.length)
  })
})

describe('collection-intent TTL continuity (bare follow-ups stay exposed, then decay)', () => {
  const TTL = 6
  it('an intent turn refreshes the TTL and stays exposed for the window, then decays', () => {
    // Turn 1: intent → exposed, TTL refreshed.
    let { recent, nextTtl } = stepCollectionIntentTtl(0, true, TTL)
    assert.equal(recent, true)
    assert.equal(nextTtl, TTL)
    // Following bare turns (no intent) stay exposed while the window decays.
    let ttl = nextTtl
    for (let i = 0; i < TTL; i += 1) {
      const step = stepCollectionIntentTtl(ttl, false, TTL)
      assert.equal(step.recent, true, `follow-up ${i + 1} should still be exposed`)
      ttl = step.nextTtl
    }
    // After the window fully decays, exposure stops.
    assert.equal(ttl, 0)
    assert.equal(stepCollectionIntentTtl(ttl, false, TTL).recent, false)
  })

  it('a non-intent turn with no prior window is not exposed', () => {
    assert.equal(stepCollectionIntentTtl(0, false, TTL).recent, false)
  })

  it('a mid-window intent turn re-refreshes the TTL', () => {
    const step = stepCollectionIntentTtl(2, true, TTL)
    assert.equal(step.nextTtl, TTL)
    assert.equal(step.recent, true)
  })
})

describe('over-exposure guard (context markers must not trigger via primary-text predicate)', () => {
  it('a platform name inside a context-marker section does NOT match the predicate on its own', () => {
    // The SDK runs the predicate over primaryInstructionText (the part BEFORE
    // context markers), so a 小红书 mention only in a "## 最近会话摘要" section
    // is excluded — the bare instruction here ("你是谁") has no intent.
    // (We simulate that by passing only the primary text, which is what the SDK does.)
    assert.equal(resolveBrowserCollectionIntent('你是谁'), false)
  })
})

describe('bare continuation resumes a browser collection (continuation + recalled context)', () => {
  it('recognizes bare continue/retry instructions', () => {
    for (const t of ['继续', '重试一下，继续', '再试一次', '接着采', 'continue', 'retry', '再来一次']) {
      assert.equal(isBareContinuationInstruction(t), true, `${t} should be a bare continuation`)
    }
  })
  it('does NOT treat a substantive instruction as a bare continuation', () => {
    for (const t of ['把小红书这个博主的笔记都采集了', '你是谁', '帮我润色这段文档', '把这张图保存到桌面']) {
      assert.equal(isBareContinuationInstruction(t), false, `${t} is not a bare continuation`)
    }
  })
  it('a bare 继续 with browser-collection in the recalled summary exposes via the continuation path', () => {
    // The SDK composition: isBareContinuationInstruction(primary) &&
    // resolveBrowserCollectionIntent(fullText). The primary alone has no intent,
    // but the recalled summary carries the platform — so a resume exposes.
    const primary = '重试一下，继续'
    const fullText = '重试一下，继续\n\n## 最近会话摘要\n用户之前要采集小红书博主 Aoi 葵 的全部笔记'
    assert.equal(isBareContinuationInstruction(primary), true)
    assert.equal(resolveBrowserCollectionIntent(primary), false, 'primary alone has no intent')
    assert.equal(resolveBrowserCollectionIntent(fullText), true, 'recalled summary supplies the platform')
  })
  it('a bare 继续 with NO browser context in recall does NOT expose', () => {
    const fullText = '继续\n\n## 最近会话摘要\n用户在写一份周报文档'
    assert.equal(isBareContinuationInstruction('继续'), true)
    assert.equal(resolveBrowserCollectionIntent(fullText), false, 'no platform/web surface in recall → no expose')
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
