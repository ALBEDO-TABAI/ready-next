import assert from 'node:assert/strict'
import test from 'node:test'

import { FileEmergenceService, isFileEmergenceEnabled } from '../main/modules/file-emergence/service'
import type { FileEmergenceServiceDeps } from '../main/modules/file-emergence/service'
import type { CalendarEvent } from '../main/modules/database'
import type { FileActivityEvent, FileReadingSession } from '../shared/file-emergence'

const now = new Date('2026-06-08T10:00:00+08:00').getTime()
const day = 24 * 60 * 60 * 1000

function makeDeps(overrides: Partial<FileEmergenceServiceDeps> = {}, counters = { reads: 0, searches: 0 }): FileEmergenceServiceDeps {
  const deps: FileEmergenceServiceDeps = {
    settings: {
      getSetting: () => undefined,
    },
    activity: {
      listRecent: () => {
        counters.reads += 1
        return []
      },
      prune: () => undefined,
    },
    readingSessions: {
      listRecent: () => {
        counters.reads += 1
        return []
      },
      prune: () => undefined,
    },
    calendar: {
      getEvents: () => {
        counters.reads += 1
        return []
      },
      getRecurringEventsAndOverrides: () => ({ events: [], overridesByParent: new Map() }),
    },
    browser: {
      getHistory: () => {
        counters.reads += 1
        return []
      },
    },
    chat: {
      listRecentConversations: () => {
        counters.reads += 1
        return []
      },
      getMessages: () => [],
    },
    search: {
      search: async () => {
        counters.searches += 1
        return { items: [] }
      },
    },
    documentMetadata: null,
    now: () => now,
  }
  return { ...deps, ...overrides }
}

function activity(path: string, createdAt = now): FileActivityEvent {
  return {
    id: `act-${path}`,
    path,
    workspaceRoot: '/workspace',
    eventType: 'open',
    source: 'file_tree',
    weight: 1,
    meta: null,
    createdAt,
  }
}

function readingSession(
  path: string,
  endedAt: number,
  activeMs: number,
  progressEnd = 0.4,
): FileReadingSession {
  return {
    id: `session-${path}-${endedAt}`,
    path,
    workspaceRoot: '/workspace',
    source: 'document_mode',
    startedAt: endedAt - activeMs,
    endedAt,
    activeMs,
    progressStart: null,
    progressEnd,
    progressKind: path.endsWith('.epub') ? 'ebook' : 'document',
    meta: null,
  }
}

function calendar(title: string, startMs: number): CalendarEvent {
  return {
    id: `cal-${title}`,
    calendar_id: 'work',
    title,
    description: null,
    location: null,
    start_time: Math.floor(startMs / 1000),
    end_time: Math.floor((startMs + 60 * 60 * 1000) / 1000),
    all_day: 0,
    recurrence_rule: null,
    reminders: null,
    start_tz: null,
    end_tz: null,
    ics_uid: null,
    source_id: null,
    created_at: Math.floor(now / 1000),
    updated_at: Math.floor(now / 1000),
  }
}

test('disabled file emergence returns without reading source data', async () => {
  const counters = { reads: 0, searches: 0 }
  const service = new FileEmergenceService(makeDeps({
    settings: { getSetting: () => 'false' },
  }, counters))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })

  assert.equal(snapshot.enabled, false)
  assert.equal(counters.reads, 0)
  assert.equal(counters.searches, 0)
})

test('file emergence setting defaults on and only false disables it', () => {
  assert.equal(isFileEmergenceEnabled({ getSetting: () => undefined }), true)
  assert.equal(isFileEmergenceEnabled({ getSetting: () => 'true' }), true)
  assert.equal(isFileEmergenceEnabled({ getSetting: () => 'false' }), false)
})

test('snapshot uses root-only cache and force refresh bypasses it', async () => {
  const counters = { reads: 0, searches: 0 }
  const service = new FileEmergenceService(makeDeps({
    activity: {
      prune: () => undefined,
      listRecent: () => {
        counters.reads += 1
        return [activity('/workspace/project/today.md')]
      },
    },
  }, counters))

  await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.equal(counters.reads, 5)

  await service.getSnapshot({ workspaceRoots: ['/workspace'], forceRefresh: true })
  assert.equal(counters.reads, 10)
})

test('activity stale marker refreshes the cached snapshot', async () => {
  const counters = { reads: 0, searches: 0 }
  const service = new FileEmergenceService(makeDeps({
    activity: {
      prune: () => undefined,
      listRecent: () => {
        counters.reads += 1
        return [activity('/workspace/project/today.md')]
      },
    },
  }, counters))

  await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  service.markStale(['/workspace'])
  await service.getSnapshot({ workspaceRoots: ['/workspace'] })

  assert.equal(counters.reads, 10)
})

test('cross-day cached snapshots are treated as stale', async () => {
  let currentNow = now
  const counters = { reads: 0, searches: 0 }
  const service = new FileEmergenceService(makeDeps({
    now: () => currentNow,
    activity: {
      prune: () => undefined,
      listRecent: () => {
        counters.reads += 1
        return [activity('/workspace/project/today.md', currentNow)]
      },
    },
  }, counters))

  await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  currentNow += day
  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })

  assert.equal(snapshot.refreshReason, 'scheduled')
  assert.equal(counters.reads, 10)
})

test('snapshot caps each bucket at 10 projects and each project at 3 files', async () => {
  const events = Array.from({ length: 12 }, (_, index) =>
    activity(`/workspace/project-${index}/file-${index}.md`, now),
  )
  const service = new FileEmergenceService(makeDeps({
    activity: {
      prune: () => undefined,
      listRecent: () => events,
    },
  }))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.equal(snapshot.buckets.today.length, 10)
  assert.ok(snapshot.buckets.today.every((project) => project.files.length <= 3))
})

test('search index failures degrade semantic projects without crashing', async () => {
  const service = new FileEmergenceService(makeDeps({
    calendar: {
      getEvents: () => [calendar('未来品牌发布计划', now + 3 * day)],
      getRecurringEventsAndOverrides: () => ({ events: [], overridesByParent: new Map() }),
    },
    search: {
      search: async () => {
        throw new Error('fts unavailable')
      },
    },
  }))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.ok(snapshot.degraded?.some((item) => item.source === 'search_index'))
})

test('semantic search query count is bounded', async () => {
  const counters = { reads: 0, searches: 0 }
  const events = Array.from({ length: 20 }, (_, index) => calendar(`未来客户${index}发布计划`, now + (index + 1) * day))
  const service = new FileEmergenceService(makeDeps({
    calendar: {
      getEvents: () => events,
      getRecurringEventsAndOverrides: () => ({ events: [], overridesByParent: new Map() }),
    },
    search: {
      search: async () => {
        counters.searches += 1
        return {
          items: [{
            path: '/workspace/shared/match.md',
            name: 'match.md',
            sourceType: 'document',
          }],
        }
      },
    },
  }, counters))

  await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.ok(counters.searches <= 12)
})

test('numeric calendar titles are ignored as low-signal projects', async () => {
  const counters = { reads: 0, searches: 0 }
  const service = new FileEmergenceService(makeDeps({
    calendar: {
      getEvents: () => [calendar('123', now - 2 * day)],
      getRecurringEventsAndOverrides: () => ({ events: [], overridesByParent: new Map() }),
    },
    search: {
      search: async () => {
        counters.searches += 1
        return {
          items: [{
            path: '/workspace/video/BV15oXnBJE43_audiovisual_analysis.md',
            name: 'BV15oXnBJE43_audiovisual_analysis.md',
            sourceType: 'document',
          }],
        }
      },
    },
  }, counters))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })

  assert.equal(snapshot.buckets.past.length, 0)
  assert.equal(counters.searches, 0)
})

test('semantic calendar projects reject unrelated search hits', async () => {
  const service = new FileEmergenceService(makeDeps({
    calendar: {
      getEvents: () => [calendar('见客户复盘', now - 2 * day)],
      getRecurringEventsAndOverrides: () => ({ events: [], overridesByParent: new Map() }),
    },
    search: {
      search: async () => ({
        items: [{
          path: '/workspace/lib-a/置身钉内/置身钉内.md',
          name: '置身钉内.md',
          sourceType: 'document',
        }],
      }),
    },
  }))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })

  assert.equal(snapshot.buckets.past.length, 0)
})

test('recently ended calendar events can become past projects', async () => {
  const service = new FileEmergenceService(makeDeps({
    calendar: {
      getEvents: () => [calendar('品牌空间案例复盘', now - 2 * day)],
      getRecurringEventsAndOverrides: () => ({ events: [], overridesByParent: new Map() }),
    },
    search: {
      search: async () => ({
        items: [{
          path: '/workspace/case/复盘.md',
          name: '复盘.md',
          sourceType: 'document',
        }],
      }),
    },
  }))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.equal(snapshot.buckets.past[0]?.title, '品牌空间案例复盘')
})

test('reading sessions can make a recently read book appear in today without save events', async () => {
  const service = new FileEmergenceService(makeDeps({
    readingSessions: {
      prune: () => undefined,
      listRecent: () => [
        readingSession('/workspace/books/白痴.epub', now - day, 90 * 60_000, 0.3),
        readingSession('/workspace/books/白痴.epub', now, 20 * 60_000, 0.45),
      ],
    },
    search: null,
  }))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.equal(snapshot.buckets.today[0]?.title, '白痴')
  assert.match(snapshot.buckets.today[0]?.evidence[0]?.label || '', /今天阅读/)
})

test('reading sessions can create future continuation without calendar events', async () => {
  const service = new FileEmergenceService(makeDeps({
    readingSessions: {
      prune: () => undefined,
      listRecent: () => [
        readingSession('/workspace/books/白痴.epub', now - 3 * day, 5 * 60 * 60_000, 0.65),
      ],
    },
    search: null,
  }))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.equal(snapshot.buckets.future[0]?.title, '白痴')
  assert.equal(snapshot.buckets.future[0]?.status, 'continuation')
  assert.match(snapshot.buckets.future[0]?.evidence[0]?.label || '', /已停 3 天/)
})

test('document title metadata keeps generic containers from naming document projects', async () => {
  const event = activity('/workspace/测试/lib-a/置身钉内.md', now)
  event.source = 'document_mode'
  const service = new FileEmergenceService(makeDeps({
    activity: {
      prune: () => undefined,
      listRecent: () => [event],
    },
    documentMetadata: {
      getTitleMetadata: () => new Map([
        ['/workspace/测试/lib-a/置身钉内.md', {
          path: '/workspace/测试/lib-a/置身钉内.md',
          name: '置身钉内.md',
          frontmatterTitle: null,
          metadataTitle: null,
        }],
      ]),
    },
    search: null,
  }))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })

  assert.equal(snapshot.buckets.today[0]?.title, '置身钉内')
})

test('frontmatter title can name a document when the file name is generic', async () => {
  const event = activity('/workspace/资料/untitled.md', now)
  event.source = 'document_mode'
  const service = new FileEmergenceService(makeDeps({
    activity: {
      prune: () => undefined,
      listRecent: () => [event],
    },
    documentMetadata: {
      getTitleMetadata: () => new Map([
        ['/workspace/资料/untitled.md', {
          path: '/workspace/资料/untitled.md',
          name: 'untitled.md',
          frontmatterTitle: '宝库数据库整理',
          metadataTitle: null,
        }],
      ]),
    },
    search: null,
  }))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })

  assert.equal(snapshot.buckets.today[0]?.title, '宝库数据库整理')
})

test('emergence source open does not single-handedly promote an old project to today', async () => {
  const event = activity('/workspace/old/淘金小镇.md', now)
  event.source = 'emergence'
  event.weight = 0.15
  const service = new FileEmergenceService(makeDeps({
    activity: {
      prune: () => undefined,
      listRecent: () => [event],
    },
    search: null,
  }))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.equal(snapshot.buckets.today.length, 0)
})
