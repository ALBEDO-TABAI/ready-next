import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import {
  decodeMarkdownRefLocalCandidate,
  rewriteMarkdownMediaRefs,
} from '../shared/markdown-asset-refs'
import { planMarkdownBundle } from '../main/modules/document-engine/export/markdown-bundle'

function planWith(content: string, files: string[], documentDir: string | null = '/docs') {
  const existing = new Set(files)
  return planMarkdownBundle({
    content,
    documentDir,
    fileExists: (candidate) => existing.has(candidate),
  })
}

test('markdown bundle rewrites relative and absolute image refs into assets/', () => {
  const content = [
    '# 标题',
    '![截图](./images/shot.png)',
    '![绝对](/data/pics/photo.jpg)',
  ].join('\n')
  const plan = planWith(content, ['/docs/images/shot.png', '/data/pics/photo.jpg'])

  assert.ok(plan.markdown.includes('![截图](assets/shot.png)'))
  assert.ok(plan.markdown.includes('![绝对](assets/photo.jpg)'))
  assert.deepEqual(plan.assets.map((asset) => asset.zipPath), ['assets/shot.png', 'assets/photo.jpg'])
  assert.deepEqual(plan.assets.map((asset) => asset.sourcePath), ['/docs/images/shot.png', '/data/pics/photo.jpg'])
  assert.equal(plan.missing.length, 0)
})

test('markdown bundle decodes local-file:// refs and wraps spaced names in angle brackets', () => {
  const spaced = '/docs/img dir/my shot.png'
  const content = `![a](local-file://${encodeURI(spaced)})`
  const plan = planWith(content, [spaced])

  assert.equal(plan.assets.length, 1)
  assert.equal(plan.assets[0].sourcePath, spaced)
  assert.ok(plan.markdown.includes('![a](<assets/my shot.png>)'))
})

test('markdown bundle keeps remote/data refs and code-fenced refs untouched', () => {
  const content = [
    '![remote](https://example.com/a.png)',
    '![data](data:image/png;base64,AAAA)',
    '```md',
    '![fenced](./images/shot.png)',
    '```',
    '行内 `![inline](./images/shot.png)` 不动',
  ].join('\n')
  const plan = planWith(content, ['/docs/images/shot.png'])

  assert.equal(plan.assets.length, 0)
  assert.equal(plan.markdown, content)
})

test('markdown bundle packs plain links only when they point at media files', () => {
  const content = [
    '[视频](./media/demo.mp4)',
    '[另一篇](./other.md)',
  ].join('\n')
  const plan = planWith(content, ['/docs/media/demo.mp4', '/docs/other.md'])

  assert.ok(plan.markdown.includes('[视频](assets/demo.mp4)'))
  assert.ok(plan.markdown.includes('[另一篇](./other.md)'))
  assert.deepEqual(plan.assets.map((asset) => asset.zipPath), ['assets/demo.mp4'])
})

test('markdown bundle rewrites inline HTML media srcs', () => {
  const content = '<img src="./images/shot.png" alt="x" />\n<video src="./media/demo.mp4"></video>'
  const plan = planWith(content, ['/docs/images/shot.png', '/docs/media/demo.mp4'])

  assert.ok(plan.markdown.includes('<img src="assets/shot.png"'))
  assert.ok(plan.markdown.includes('<video src="assets/demo.mp4"'))
})

test('markdown bundle uniquifies name collisions and reuses repeat refs', () => {
  const content = [
    '![一](./a/shot.png)',
    '![二](./b/shot.png)',
    '![再一](./a/shot.png)',
  ].join('\n')
  const plan = planWith(content, ['/docs/a/shot.png', '/docs/b/shot.png'])

  assert.deepEqual(plan.assets.map((asset) => asset.zipPath), ['assets/shot.png', 'assets/shot-2.png'])
  const first = plan.markdown.match(/assets\/shot\.png/g) || []
  assert.equal(first.length, 2, '同一来源的两处引用共用一个资源名')
  assert.ok(plan.markdown.includes('assets/shot-2.png'))
})

test('markdown bundle records missing files and untitled-draft relative refs without rewriting', () => {
  const missingRel = '![缺](./gone.png)'
  const planMissing = planWith(missingRel, [])
  assert.equal(planMissing.markdown, missingRel)
  assert.deepEqual(planMissing.missing, ['./gone.png'])

  const draftPlan = planWith('![孤](./img.png)', [join('/anywhere', 'img.png')], null)
  assert.equal(draftPlan.assets.length, 0)
  assert.deepEqual(draftPlan.missing, ['./img.png'])
})

test('decodeMarkdownRefLocalCandidate handles schemes and windows drive paths', () => {
  assert.equal(decodeMarkdownRefLocalCandidate('https://a.com/x.png'), null)
  assert.equal(decodeMarkdownRefLocalCandidate('data:image/png;base64,xx'), null)
  assert.equal(decodeMarkdownRefLocalCandidate('local-file:///Users/x/a%20b.png'), '/Users/x/a b.png')
  assert.equal(decodeMarkdownRefLocalCandidate('file:///C:/Users/x/a.png'), 'C:/Users/x/a.png')
  assert.equal(decodeMarkdownRefLocalCandidate('C:\\Users\\x\\a.png'), 'C:\\Users\\x\\a.png')
  assert.equal(decodeMarkdownRefLocalCandidate('./img/a.png'), './img/a.png')
})

test('rewriteMarkdownMediaRefs preserves image titles and skips unknown schemes', () => {
  const content = '![a](./x.png "标题")\n![b](unknown-scheme://x/y.png)'
  const rewritten = rewriteMarkdownMediaRefs(content, (ref) => {
    if (!ref.localCandidate) return null
    return 'assets/x.png'
  })
  assert.ok(rewritten.includes('![a](assets/x.png "标题")'))
  assert.ok(rewritten.includes('![b](unknown-scheme://x/y.png)'))
})
