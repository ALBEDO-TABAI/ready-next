import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildProjectTitle,
  chooseDirectoryAnchor,
  documentProjectKey,
  directoryProjectKey,
  semanticProjectKey,
  shouldMergeSemanticIntoDirectory,
} from '../main/modules/file-emergence/project-normalizer'
import { candidatesFromConversations } from '../main/modules/file-emergence/candidate-extractors'

test('directory project keys keep same-name folders separate', () => {
  assert.notEqual(
    directoryProjectKey('/workspace/a/资料'),
    directoryProjectKey('/workspace/b/资料'),
  )
})

test('directory anchors skip generic staging folders for activity projects', () => {
  assert.equal(
    chooseDirectoryAnchor('/workspace/测试/测试13/淘金小镇分析/BV15.md', ['/workspace']),
    '/workspace/测试/测试13/淘金小镇分析',
  )
  assert.equal(
    chooseDirectoryAnchor('/workspace/置身钉内/置身钉内.md', ['/workspace']),
    '/workspace/置身钉内',
  )
})

test('semantic project keys are title based, separate from directory anchors', () => {
  const semantic = semanticProjectKey('品牌空间案例观察')
  assert.ok(semantic.startsWith('semantic:'))
  assert.notEqual(semantic, directoryProjectKey('/workspace/品牌空间案例观察'))
})

test('document project titles use the file name body instead of parent containers', () => {
  const result = buildProjectTitle({
    rawLabels: ['测试', '资料'],
    anchorPath: '/workspace/测试/lib-a/置身钉内.md',
    evidence: [],
  })

  assert.equal(result.title, '置身钉内')
  assert.ok(documentProjectKey('/workspace/测试/lib-a/置身钉内.md').startsWith('doc:'))
})

test('abstract raw labels can be refined with more specific evidence', () => {
  const result = buildProjectTitle({
    rawLabels: ['门店'],
    anchorPath: '/workspace/门店',
    evidence: [
      {
        source: 'calendar',
        label: '2026 门店图片数据库复盘',
        score: 0.9,
        timestamp: Date.now(),
      },
      {
        source: 'agent',
        label: '门店图片数据库资料整理',
        score: 0.7,
      },
    ],
  })

  assert.equal(result.title, '2026 门店图片数据库复盘')
  assert.equal(result.titleSource, 'rule_refined')
  assert.ok(result.confidenceHint > 0.2)
})

test('directory project titles prefer concrete folder names over opened file names', () => {
  const result = buildProjectTitle({
    rawLabels: ['BV15.md'],
    anchorPath: '/workspace/测试/淘金小镇分析',
    evidence: [
      {
        source: 'file_activity',
        label: 'BV15.md',
        score: 1,
        timestamp: Date.now(),
      },
    ],
  })

  assert.equal(result.title, '淘金小镇分析')
  assert.equal(result.titleSource, 'directory')
})

test('semantic candidates matching a directory project merge into directory evidence', () => {
  assert.equal(
    shouldMergeSemanticIntoDirectory({
      semanticTitle: '品牌空间案例观察',
      directoryPath: '/workspace/客户资料/空间案例',
      rawLabels: ['案例', '品牌空间'],
      fileNames: ['品牌空间案例观察.md'],
    }),
    true,
  )
})

test('generic semantic candidates do not create weak duplicate projects', () => {
  assert.equal(
    shouldMergeSemanticIntoDirectory({
      semanticTitle: '资料',
      directoryPath: '/workspace/a/资料',
      rawLabels: ['资料'],
      fileNames: ['readme.md'],
    }),
    false,
  )
})

test('agent file mentions and generic continuations do not become project titles', () => {
  const now = Date.now()
  const candidates = candidatesFromConversations(
    [{ id: 'c1', title: '继续', updatedAt: new Date(now).toISOString() }],
    new Map([
      ['c1', [
        {
          id: 'm1',
          conversation_id: 'c1',
          role: 'user',
          content: '@[新文档.md]这份文档是我接下来准备给你看的内容',
          timestamp: new Date(now).toISOString(),
          meta_json: null,
        },
      ]],
    ]),
    now,
  )

  assert.equal(candidates.length, 0)
})

test('agent extraction still keeps concrete project phrases', () => {
  const now = Date.now()
  const candidates = candidatesFromConversations(
    [{ id: 'c1', title: '继续', updatedAt: new Date(now).toISOString() }],
    new Map([
      ['c1', [
        {
          id: 'm1',
          conversation_id: 'c1',
          role: 'user',
          content: '明天继续整理品牌空间案例资料',
          timestamp: new Date(now).toISOString(),
          meta_json: null,
        },
      ]],
    ]),
    now,
  )

  assert.equal(candidates.length, 1)
  assert.match(candidates[0].rawLabels[0], /品牌空间案例/)
})
