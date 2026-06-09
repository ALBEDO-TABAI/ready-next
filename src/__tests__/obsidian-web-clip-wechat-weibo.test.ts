import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWeiboVisitorWallHtml } from '../main/modules/clipping/clip-fetch'
import {
  cleanJinaReaderMarkdown,
  runClipPipeline,
} from '../main/modules/clipping/clip-pipeline'
import { ReadabilityJsdomAdapter } from '../main/modules/clipping/readability-jsdom-adapter'

const PRESET_DIR = join(
  process.cwd(),
  'assets',
  'embedded-skills',
  'obsidian-web-clip',
  'assets',
  'presets',
)

const WEIBO_URL = 'https://weibo.com/2217035934/5306419714982956'

const WEIBO_JINA_MARKDOWN = `Title: 微博正文 - 微博
URL Source: ${WEIBO_URL}

Markdown Content:
# 微博正文 - 微博

## 推荐

微博热搜

返回

王落北

公开

![avatar](https://tvax2.sinaimg.cn/crop.0.0.828.828.1024/avatar.jpg)

[26-6-5 04:08](https://weibo.com/2217035934/R2H0nkUig)

发布于 广东

来自 萝北诶的iPhone客户端

关注

[王落北](https://weibo.com/u/2217035934)

[26-6-5 04:08](https://weibo.com/2217035934/R2H0nkUig)

发布于 广东

来自 萝北诶的iPhone客户端

阿里内网 7 万字长文《置身钉内》，看完真的好压抑![Image 15: [允悲]](https://face.t.sinajs.cn/t4/appstyle/expression/ext/normal/65/201810_ybnew_mobile.png)

长图

![Image 16](https://wx2.sinaimg.cn/orj360/002q2sk6gy1iduayrq2i0j60hwcmr4qs02.jpg)

![Image 17](https://wx1.sinaimg.cn/orj360/002q2sk6gy1iduayu7hm5j60hwcmrx6r02.jpg)

784

37

524

同时转发

随时随地发现新鲜事

微博热搜

分享这条博文

评论

[一个专员](https://weibo.com/u/6451575366): 字太多了
`

describe('ReadabilityJsdomAdapter · WeChat public account extraction', () => {
  it('clips only #js_content and converts WeChat SVG images into markdown images', async () => {
    const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta property="og:title" content="公众号标题">
    <meta property="og:description" content="公众号描述">
    <meta property="og:image" content="https://mmbiz.qpic.cn/cover/0?wx_fmt=jpeg">
  </head>
  <body>
    <h1 id="activity-name"><span class="js_title_inner">公众号标题</span></h1>
    <span id="js_author_name_text">作者名</span>
    <a id="js_name">账号名</a>
    <em id="publish_time"></em>
    <div id="js_content">
      <p>正文第一段，有完整的中文内容用于剪藏。</p>
      <p>继续滑动看下一个</p>
      <section>
        <svg viewBox="0 0 345 100" role="img" aria-label="插图">
          <image href="//mmbiz.qpic.cn/svg-image/0?wx_fmt=png" title="1"></image>
        </svg>
      </section>
      <section>
        <svg viewBox="0 0 345 700" role="img" aria-label="动画">
          <image x="0" y="0" width="100%" height="100%" href="//mmbiz.qpic.cn/frame-1/0?wx_fmt=png"></image>
          <image x="0" y="0" width="100%" height="100%" href="//mmbiz.qpic.cn/frame-2/0?wx_fmt=png"></image>
          <image x="0" y="0" width="100%" height="100%" href="//mmbiz.qpic.cn/frame-3/0?wx_fmt=png"></image>
        </svg>
      </section>
      <p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="http://mmbiz.qpic.cn/rich/640?wx_fmt=jpeg#imgIndex=7" alt="正文图"></p>
    </div>
    <p>向上滑动看下一个</p>
    <script>var ct = "1780932600";</script>
  </body>
</html>`
    const adapter = new ReadabilityJsdomAdapter()
    const result = await adapter.extract({
      html,
      url: 'https://mp.weixin.qq.com/s/example',
    })

    assert.equal(result.title, '公众号标题')
    assert.equal(result.metadata.author, '作者名')
    assert.equal(result.metadata.site, '微信公众平台')
    assert.equal(result.metadata.published, '2026-06-08T15:30:00.000Z')
    assert.match(result.contentMarkdown, /正文第一段/)
    assert.match(result.contentMarkdown, /!\[\]\(https:\/\/mmbiz\.qpic\.cn\/svg-image\/0\?wx_fmt=png\)/)
    assert.match(result.contentMarkdown, /!\[动画\]\(https:\/\/mmbiz\.qpic\.cn\/frame-1\/0\?wx_fmt=png\)/)
    assert.doesNotMatch(result.contentMarkdown, /frame-2/)
    assert.doesNotMatch(result.contentMarkdown, /frame-3/)
    assert.match(result.contentMarkdown, /!\[正文图\]\(https:\/\/mmbiz\.qpic\.cn\/rich\/640\?wx_fmt=jpeg\)/)
    assert.doesNotMatch(result.contentMarkdown, /#imgIndex/)
    assert.doesNotMatch(result.contentMarkdown, /http:\/\/mmbiz\.qpic\.cn/)
    assert.equal(result.contentMarkdown.includes('继续滑动看下一个'), false)
    assert.equal(result.contentMarkdown.includes('向上滑动看下一个'), false)
  })
})

describe('Weibo public post clipping', () => {
  it('treats the Weibo visitor shell as a login wall', () => {
    assert.equal(
      isWeiboVisitorWallHtml(
        'https://passport.weibo.com/visitor/visitor?entry=miniblog',
        '<!doctype html><title>Sina Visitor System</title><script src="/js/visitor/mini_original.js"></script>',
      ),
      true,
    )
  })

  it('cleans Jina-rendered Weibo pages down to the post body and images', () => {
    const cleaned = cleanJinaReaderMarkdown(WEIBO_JINA_MARKDOWN, WEIBO_URL, '')

    assert.match(cleaned, /阿里内网 7 万字长文《置身钉内》/)
    assert.match(cleaned, /https:\/\/wx2\.sinaimg\.cn\/original\/002q2sk6gy1iduayrq2i0j60hwcmr4qs02\.jpg/)
    assert.match(cleaned, /https:\/\/wx1\.sinaimg\.cn\/original\/002q2sk6gy1iduayu7hm5j60hwcmrx6r02\.jpg/)
    assert.equal(cleaned.includes('微博热搜'), false)
    assert.equal(cleaned.includes('分享这条博文'), false)
    assert.equal(cleaned.includes('一个专员'), false)
    assert.equal(cleaned.includes('face.t.sinajs.cn'), false)
    assert.equal(cleaned.includes('tvax2.sinaimg.cn'), false)
  })

  it('uses the cleaned post snippet as the note title when raw HTML is unavailable', async () => {
    const outputsRoot = mkdtempSync(join(tmpdir(), 'ready-weibo-clip-test-'))
    const result = await runClipPipeline(
      { html: '', url: WEIBO_URL, jinaMarkdown: WEIBO_JINA_MARKDOWN },
      {
        presetDir: PRESET_DIR,
        preset: 'auto',
        flattenPath: true,
        outputsRoot,
      },
    )
    const saved = readFileSync(result.savedPath, 'utf8')

    assert.match(result.title, /^阿里内网 7 万字长文《置身钉内》/)
    assert.equal(result.frontmatter.author, '王落北')
    assert.equal(result.frontmatter.published, '26-6-5 04:08')
    assert.match(saved, /https:\/\/wx2\.sinaimg\.cn\/original\/002q2sk6gy1iduayrq2i0j60hwcmr4qs02\.jpg/)
    assert.equal(saved.includes('Sina Visitor System'), false)
    assert.equal(saved.includes('分享这条博文'), false)
  })
})
