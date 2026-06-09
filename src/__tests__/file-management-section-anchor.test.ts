import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executeFileManagementTool } from '../main/modules/tools/file-management-tools'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('file-management-section-anchor declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'file-management-section-anchor transitive sqlite load')
})

function fakeSearchEngine(root: string) {
  const db = {
    prepare() {
      return {
        get: () => undefined,
        all: () => [],
      }
    },
  }
  return {
    findWorkspaceRootForPath: (path: string) => path.startsWith(root) ? root : null,
    indexDocument: async () => undefined,
    getRepository: () => ({ getConnection: () => db }),
  }
}

function ebookStyleMarkdown(): string {
  return [
    '# 白痴',
    '',
    '- [第二部](#第二部)',
    '',
    '## 第一部',
    '',
    '### 一',
    '',
    '第一部第一章正文。',
    '',
    '## 第二部',
    '',
    '![cover](x.png)',
    '',
    '## 第二部',
    '',
    '### 一',
    '',
    '第二部第一章正文。',
    '',
    '### 二',
    '',
    '第二部第二章正文。',
    '',
    '## 第三部',
    '',
    '### 一',
    '',
    '第三部第一章正文。',
  ].join('\n')
}

test('file_locate and file_read_excerpt resolve part + chapter anchors with the shared index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-file-anchor-'))
  try {
    const path = join(root, '白痴.md')
    await writeFile(path, ebookStyleMarkdown(), 'utf-8')
    const context = { searchEngine: fakeSearchEngine(root) as never }

    const locate = JSON.parse(await executeFileManagementTool('file_locate', {
      path,
      anchor: '第二部第一章',
    }, context))
    assert.equal(locate.ok, true)
    assert.equal(locate.sectionTitle, '第二部第一章')
    assert.equal(locate.line, 17)

    const excerpt = JSON.parse(await executeFileManagementTool('file_read_excerpt', {
      path,
      anchor: '第二部第一章',
    }, context))
    assert.equal(excerpt.ok, true)
    assert.equal(excerpt.sectionTitle, '第二部第一章')
    assert.match(excerpt.content, /第二部第一章正文/)
    assert.doesNotMatch(excerpt.content, /第二部第二章正文/)
    assert.doesNotMatch(excerpt.content, /第一部第一章正文/)

    const third = JSON.parse(await executeFileManagementTool('file_locate', {
      path,
      anchor: '第三部第一章',
    }, context))
    assert.equal(third.sectionTitle, '第三部第一章')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file_read_excerpt keeps explicit line ranges independent of section anchors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-file-lines-'))
  try {
    const path = join(root, 'note.md')
    await writeFile(path, ['# A', 'one', '# B', 'two'].join('\n'), 'utf-8')
    const result = JSON.parse(await executeFileManagementTool('file_read_excerpt', {
      path,
      anchor: 'B',
      lineStart: 1,
      lineEnd: 2,
    }, { searchEngine: fakeSearchEngine(root) as never }))
    assert.equal(result.content, '# A\none')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
