import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFastCardTags,
  detectFastCardTargetLanguage,
  renderFastCardMarkdown,
  type FastCardItem,
} from '../shared/fastcard'

test('FastCard target language defaults by selected text script', () => {
  assert.equal(detectFastCardTargetLanguage('A short English paragraph.'), 'zh-CN')
  assert.equal(detectFastCardTargetLanguage('这是一段中文。'), 'en')
})

test('FastCard markdown includes deterministic tags and video links', () => {
  const items: FastCardItem[] = [
    {
      id: 'one',
      kind: 'translation',
      createdAt: 1,
      originalText: 'Hello',
      translatedText: '你好',
      targetLanguage: 'zh-CN',
      source: { pageUrl: 'https://example.com/a', domain: 'example.com' },
    },
    {
      id: 'two',
      kind: 'video',
      createdAt: 2,
      source: { pageUrl: 'https://youtu.be/demo', domain: 'youtu.be' },
      video: {
        originalUrl: 'https://youtu.be/demo',
        playableUrl: 'https://cdn.example.com/demo.mp4',
        title: 'Demo video',
        platform: 'youtube',
        parseStatus: 'resolved',
      },
    },
  ]

  const tags = buildFastCardTags(items)
  assert.deepEqual(tags, [
    'fastcard',
    'platform-youtube',
    'source-example.com',
    'source-youtu.be',
    'translation',
    'video',
    'video-reference',
  ])

  const markdown = renderFastCardMarkdown(items, new Date('2026-05-21T08:00:00.000Z'))
  assert.match(markdown, /created: "2026-05-21T08:00:00.000Z"/)
  assert.match(markdown, /- platform-youtube/)
  assert.match(markdown, /译文（zh-CN）/)
  assert.match(markdown, /播放链接：https:\/\/cdn\.example\.com\/demo\.mp4/)
})
