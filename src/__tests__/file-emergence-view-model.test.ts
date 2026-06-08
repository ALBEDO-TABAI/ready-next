import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFileEmergenceViewModel } from '../renderer/components/layout/fileEmergenceViewModel'
import {
  createEmptyFileEmergenceBuckets,
  type FileEmergenceProject,
  type FileEmergenceReadingProgress,
  type FileEmergenceSnapshot,
} from '../shared/file-emergence'

const now = new Date('2026-06-08T10:00:00+08:00').getTime()
const day = 24 * 60 * 60 * 1000

const DEFAULT_FILTERS = {
  folder: true,
  document: true,
  code: true,
  image: true,
  video: true,
  audio: true,
  spreadsheet: true,
  design: true,
  other: true,
}

function project(
  id: string,
  bucket: FileEmergenceProject['bucket'] = 'today',
  anchorPath = `/workspace/${id}`,
): FileEmergenceProject {
  return {
    id,
    bucket,
    title: id,
    rawLabels: [id],
    anchorType: 'directory',
    anchorPath,
    titleSource: 'directory',
    score: 1,
    confidence: 'high',
    files: [
      {
        path: `/workspace/${id}/note.md`,
        name: 'note.md',
        kind: 'document',
        score: 1,
        reason: '最近打开',
      },
    ],
    evidence: [],
    updatedAt: Date.now(),
  }
}

function snapshot(projects: FileEmergenceProject[]): FileEmergenceSnapshot {
  const buckets = createEmptyFileEmergenceBuckets()
  for (const item of projects) {
    buckets[item.bucket].push(item)
  }
  return {
    generatedAt: Date.now(),
    workspaceRoots: ['/workspace'],
    enabled: true,
    buckets,
  }
}

test('file emergence view model hides outside tree mode and while searching', () => {
  assert.equal(buildFileEmergenceViewModel({
    snapshot: snapshot([project('a')]),
    query: '',
    viewMode: 'grid',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
  }), null)

  assert.equal(buildFileEmergenceViewModel({
    snapshot: snapshot([project('a')]),
    query: 'note',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
  }), null)
})

test('file emergence view model hides disabled or empty snapshots', () => {
  const disabled = snapshot([project('a')])
  disabled.enabled = false
  assert.equal(buildFileEmergenceViewModel({
    snapshot: disabled,
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
  }), null)

  assert.equal(buildFileEmergenceViewModel({
    snapshot: snapshot([]),
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
  }), null)
})

test('file emergence view model caps visible projects at 10 and opens today by default', () => {
  const model = buildFileEmergenceViewModel({
    snapshot: snapshot(Array.from({ length: 12 }, (_, index) => project(`p-${index}`))),
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
  })

  assert.equal(model?.defaultExpandedBucket, 'today')
  assert.equal(model?.buckets.find((bucket) => bucket.bucket === 'today')?.projects.length, 10)
})

test('file emergence view model keeps all bucket rows when any bucket has projects', () => {
  const model = buildFileEmergenceViewModel({
    snapshot: snapshot([project('p-1', 'past')]),
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
  })

  assert.deepEqual(model?.buckets.map((bucket) => bucket.bucket), ['future', 'today', 'past', 'distant'])
  assert.equal(model?.buckets.find((bucket) => bucket.bucket === 'future')?.projects.length, 0)
  assert.equal(model?.buckets.find((bucket) => bucket.bucket === 'today')?.projects.length, 0)
  assert.equal(model?.buckets.find((bucket) => bucket.bucket === 'past')?.projects.length, 1)
  assert.equal(model?.buckets.find((bucket) => bucket.bucket === 'distant')?.projects.length, 0)
})

test('file emergence view model falls back to the first non-empty bucket after today', () => {
  const model = buildFileEmergenceViewModel({
    snapshot: snapshot([project('future-plan', 'future'), project('past-review', 'past')]),
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
  })

  assert.equal(model?.defaultExpandedBucket, 'future')
})

test('file emergence view model applies file filters in renderer only', () => {
  const filters = { ...DEFAULT_FILTERS, document: false }
  const model = buildFileEmergenceViewModel({
    snapshot: snapshot([project('a')]),
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters,
  })

  assert.equal(model?.totalProjects, 1)
  assert.equal(model?.buckets.find((bucket) => bucket.bucket === 'today')?.projects[0]?.files.length, 0)
})

test('current active document is ensured into today without changing the base snapshot', () => {
  const base = snapshot([])
  const model = buildFileEmergenceViewModel({
    snapshot: base,
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
    now,
    currentDocumentContext: {
      tabs: [{
        path: '/workspace/lib-a/置身钉内.md',
        title: '置身钉内.md',
        isActive: true,
        isSplit: false,
        isDirty: false,
      }],
    },
    readingProgress: [],
  })

  const today = model?.buckets.find((bucket) => bucket.bucket === 'today')?.projects || []
  assert.equal(today[0]?.title, '置身钉内')
  assert.equal(today[0]?.files[0]?.path, '/workspace/lib-a/置身钉内.md')
  assert.equal(today[0]?.files[0]?.isCurrent, true)
  assert.equal(base.buckets.today.length, 0)
})

test('active document covered by a directory project is lifted without a duplicate card', () => {
  const covered = project('置身钉内项目', 'past', '/workspace/lib-a/置身钉内')
  covered.files = [{
    path: '/workspace/lib-a/置身钉内/旧稿.md',
    name: '旧稿.md',
    kind: 'document',
    score: 0.4,
    reason: '项目目录内文件',
  }]

  const model = buildFileEmergenceViewModel({
    snapshot: snapshot([covered]),
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
    now,
    currentDocumentContext: {
      tabs: [{
        path: '/workspace/lib-a/置身钉内/置身钉内.md',
        title: '置身钉内.md',
        isActive: true,
        isSplit: false,
        isDirty: false,
      }],
    },
    readingProgress: [],
  })

  const today = model?.buckets.find((bucket) => bucket.bucket === 'today')?.projects || []
  const past = model?.buckets.find((bucket) => bucket.bucket === 'past')?.projects || []
  assert.equal(today.length, 1)
  assert.equal(past.length, 0)
  assert.equal(today[0]?.id, '置身钉内项目')
  assert.equal(today[0]?.files[0]?.path, '/workspace/lib-a/置身钉内/置身钉内.md')
  assert.equal(today[0]?.files[0]?.isCurrent, true)
})

test('active document injection keeps today capped at 10 and replaces the lowest item', () => {
  const baseProjects = Array.from({ length: 10 }, (_, index) => {
    const item = project(`p-${index}`)
    item.score = index / 10
    return item
  })
  const model = buildFileEmergenceViewModel({
    snapshot: snapshot(baseProjects),
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
    now,
    currentDocumentContext: {
      tabs: [{
        path: '/workspace/books/白痴.epub',
        title: '白痴.epub',
        isActive: true,
        isSplit: false,
        isDirty: false,
      }],
    },
    readingProgress: [],
  })

  const today = model?.buckets.find((bucket) => bucket.bucket === 'today')?.projects || []
  assert.equal(today.length, 10)
  assert.equal(today[0]?.title, '白痴')
  assert.equal(today.some((item) => item.id === 'p-0'), false)
})

test('current documents in the same concrete directory are clustered into one project', () => {
  const model = buildFileEmergenceViewModel({
    snapshot: snapshot([]),
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
    now,
    currentDocumentContext: {
      tabs: [{
        path: '/workspace/宝库/门店图片数据库.md',
        title: '门店图片数据库.md',
        isActive: true,
        isSplit: false,
        isDirty: false,
      }, {
        path: '/workspace/宝库/Aesop 空间案例.md',
        title: 'Aesop 空间案例.md',
        isActive: false,
        isSplit: false,
        isDirty: false,
      }],
    },
    readingProgress: [],
  })

  const today = model?.buckets.find((bucket) => bucket.bucket === 'today')?.projects || []
  assert.equal(today.length, 1)
  assert.equal(today[0]?.title, '宝库')
  assert.equal(today[0]?.files[0]?.path, '/workspace/宝库/门店图片数据库.md')
  assert.equal(today[0]?.files[0]?.isCurrent, true)
})

test('reading progress can create a guarded future continuation project', () => {
  const progress: FileEmergenceReadingProgress[] = [{
    path: '/workspace/books/白痴.epub',
    title: '白痴',
    kind: 'ebook',
    progressRatio: 0.62,
    updatedAt: now - 3 * day,
    detail: '阅读进度 62%',
    exists: true,
  }, {
    path: '/workspace/books/残留.epub',
    title: '残留',
    kind: 'ebook',
    progressRatio: 0.8,
    updatedAt: now,
    exists: false,
  }]

  const model = buildFileEmergenceViewModel({
    snapshot: snapshot([]),
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
    now,
    currentDocumentContext: { tabs: [] },
    readingProgress: progress,
  })

  const future = model?.buckets.find((bucket) => bucket.bucket === 'future')?.projects || []
  const today = model?.buckets.find((bucket) => bucket.bucket === 'today')?.projects || []
  assert.equal(future[0]?.title, '白痴')
  assert.equal(future[0]?.status, 'continuation')
  assert.match(future[0]?.evidence[0]?.label || '', /已停 3 天/)
  assert.equal(today.some((item) => item.title === '残留'), false)
})

test('switching active tabs changes only the displayed view model for the same snapshot', () => {
  const base = snapshot([])
  const left = buildFileEmergenceViewModel({
    snapshot: base,
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
    now,
    currentDocumentContext: {
      tabs: [{
        path: '/workspace/docs/置身钉内.md',
        title: '置身钉内.md',
        isActive: true,
        isSplit: false,
        isDirty: false,
      }],
    },
    readingProgress: [],
  })
  const right = buildFileEmergenceViewModel({
    snapshot: base,
    query: '',
    viewMode: 'tree',
    workspaceRoots: ['/workspace'],
    filters: DEFAULT_FILTERS,
    now,
    currentDocumentContext: {
      tabs: [{
        path: '/workspace/books/白痴.epub',
        title: '白痴.epub',
        isActive: true,
        isSplit: false,
        isDirty: false,
      }],
    },
    readingProgress: [],
  })

  assert.equal(left?.buckets.find((bucket) => bucket.bucket === 'today')?.projects[0]?.title, '置身钉内')
  assert.equal(right?.buckets.find((bucket) => bucket.bucket === 'today')?.projects[0]?.title, '白痴')
  assert.equal(base.buckets.today.length, 0)
})
