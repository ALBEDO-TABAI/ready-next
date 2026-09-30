import type { CalendarEvent } from '../main/modules/database/records'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileEmergenceService, isFileEmergenceEnabled } from '../main/modules/file-emergence/service'
import type { FileEmergenceServiceDeps } from '../main/modules/file-emergence/service'

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

test('activity stale marker invalidates every cached root set containing the changed root', async () => {
  const counters = { reads: 0, searches: 0 }
  const service = new FileEmergenceService(makeDeps({}, counters))

  await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  await service.getSnapshot({ workspaceRoots: ['/workspace', '/archive'] })
  service.markStale(['/workspace'])
  await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  await service.getSnapshot({ workspaceRoots: ['/workspace', '/archive'] })

  assert.equal(counters.reads, 20)
})

test('concurrent refreshes for the same workspace share one snapshot generation', async () => {
  const counters = { reads: 0, searches: 0 }
  const service = new FileEmergenceService(makeDeps({}, counters))

  const [first, second] = await Promise.all([
    service.getSnapshot({ workspaceRoots: ['/workspace'] }),
    service.getSnapshot({ workspaceRoots: ['/workspace'] }),
  ])

  assert.strictEqual(first, second)
  assert.equal(counters.reads, 5)
})

test('stale markers raised during generation survive singleflight completion', async () => {
  const counters = { reads: 0, searches: 0 }
  let releaseSearch!: () => void
  let reportSearchStarted!: () => void
  const searchGate = new Promise<void>((resolve) => { releaseSearch = resolve })
  const searchStarted = new Promise<void>((resolve) => { reportSearchStarted = resolve })
  const service = new FileEmergenceService(makeDeps({
    calendar: {
      getEvents: () => {
        counters.reads += 1
        return [calendar('未来品牌发布计划', now + 3 * day)]
      },
      getRecurringEventsAndOverrides: () => ({ events: [], overridesByParent: new Map() }),
    },
    search: {
      search: async () => {
        counters.searches += 1
        if (counters.searches === 1) {
          reportSearchStarted()
          await searchGate
        }
        return { items: [] }
      },
    },
  }, counters))

  const firstGeneration = service.getSnapshot({ workspaceRoots: ['/workspace'] })
  await searchStarted
  service.markStale(['/workspace'])
  releaseSearch()
  await firstGeneration

  await service.getSnapshot({ workspaceRoots: ['/workspace'] })

  assert.equal(counters.reads, 10)
  assert.equal(counters.searches, 2)
})

test('empty snapshots distinguish insufficient history, degraded sources, and rejected candidates', async () => {
  const insufficient = await new FileEmergenceService(makeDeps()).getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.equal(insufficient.emptyState, 'insufficient_history')

  const degraded = await new FileEmergenceService(makeDeps({
    activity: { prune: () => undefined, listRecent: () => { throw new Error('activity unavailable') } },
  })).getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.equal(degraded.emptyState, 'sources_degraded')

  const rejected = await new FileEmergenceService(makeDeps({
    activity: {
      prune: () => undefined,
      listRecent: () => [
        activity('/workspace/a/one.md', now - 20 * day),
        activity('/workspace/b/two.md', now - 20 * day),
      ],
    },
  })).getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.equal(rejected.emptyState, 'no_trusted_candidates')
  assert.equal(rejected.diagnostics?.rejectedCount, 2)
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

test('controlled tags enrich existing attention but never create eligibility by themselves', async () => {
  const metadata = {
    getTitleMetadata: (paths: readonly string[]) => new Map(paths.map((path) => [path, {
      path,
      readyProject: path.includes('active') ? '宝矿力持续工作' : null,
      controlledTags: path.includes('active')
        ? [{tagId:'entity-pocari',facet:'entity' as const,label:'宝矿力'},{tagId:'domain-brand',facet:'domain' as const,label:'品牌研究'}]
        : [{tagId:'domain-brand',facet:'domain' as const,label:'品牌研究'}],
    }])),
    findRelatedFiles: () => [{fileKey:'related',path:'/workspace/related/reference.md',name:'reference.md',sharedTags:[{tagId:'domain-brand',facet:'domain' as const,label:'品牌研究'}]}],
  }
  const active = await new FileEmergenceService(makeDeps({
    activity:{prune:()=>undefined,listRecent:()=>[activity('/workspace/active/brief.md')]},
    documentMetadata:metadata,
  })).getSnapshot({workspaceRoots:['/workspace']})
  assert.equal(active.buckets.today[0]?.title,'宝矿力持续工作','ready_project remains the project title; entity does not become it')
  assert.ok(active.buckets.today[0]?.files.some((file)=>file.fileKey==='related'),'domain tag recalls a related controlled file')
  assert.ok(active.buckets.today[0]?.evidence.some((item)=>item.source==='controlled_tag'&&item.label==='entity: 宝矿力'))

  const tagsOnly = await new FileEmergenceService(makeDeps({documentMetadata:metadata})).getSnapshot({workspaceRoots:['/workspace']})
  assert.equal(tagsOnly.diagnostics?.candidateCount,0,'assignments are modifiers, never candidate generators')
})

test('raw body tags and CSS color tokens have no metadata port into emergence', async () => {
  const snapshot = await new FileEmergenceService(makeDeps({
    activity:{prune:()=>undefined,listRecent:()=>[activity('/workspace/css/theme.md')]},
    documentMetadata:{getTitleMetadata:(paths)=>new Map(paths.map((path)=>[path,{path,frontmatterTitle:'主题设计',controlledTags:[]}]))},
  })).getSnapshot({workspaceRoots:['/workspace']})
  assert.ok(snapshot.buckets.today[0])
  assert.equal(snapshot.buckets.today[0]?.evidence.some((item)=>/fff|f5f5f5/i.test(item.label)),false)
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

test('production snapshot derives prepare, forming, and harvest from the same resolved projects', async () => {
  const root = await mkdtemp(join(tmpdir(),'ready-p4-intent-'))
  const formingA=join(root,'forming','brief.md');const formingB=join(root,'forming','notes.md')
  const prepareFile=join(root,'launch','新品发布准备.md');const harvestFile=join(root,'done','品牌交付复盘.md')
  await Promise.all([formingA,formingB,prepareFile,harvestFile].map(async(path)=>{await import('node:fs/promises').then(({mkdir})=>mkdir(path.slice(0,path.lastIndexOf('/')),{recursive:true}));await writeFile(path,'# proof')}))
  const identity: NonNullable<FileEmergenceServiceDeps['identity']> = {
    resolveCurrentFile: (_root,path)=>({fileKey:`file:${path}`,currentPath:path}),
    resolveProject: (input)=>({projectKey:`project:${input.displayName}`,displayName:input.displayName,source:input.source,confidence:input.confidence,files:input.filePaths.map((path)=>({fileKey:`file:${path}`,currentPath:path}))}),
  }
  const snapshot = await new FileEmergenceService(makeDeps({
    identity,
    activity:{prune:()=>undefined,listRecent:()=>[activity(formingA),activity(formingB)]},
    readingSessions:{prune:()=>undefined,listRecent:()=>[readingSession(formingA,now,12*60_000,.4)]},
    calendar:{getEvents:()=>[calendar('新品发布准备',now+5*day),calendar('品牌交付复盘',now-2*day)],getRecurringEventsAndOverrides:()=>({events:[],overridesByParent:new Map()})},
    search:{search:async(query)=>({items:[{path:query.includes('交付')?harvestFile:prepareFile,name:query.includes('交付')?'品牌交付复盘.md':'新品发布准备.md',sourceType:'document'}]})},
  })).getSnapshot({workspaceRoots:[root]})
  assert.ok(snapshot.intentCards?.some((card)=>card.type==='prepare'&&card.projectKey&&card.action.kind==='open_project'))
  assert.ok(snapshot.intentCards?.some((card)=>card.type==='forming'&&card.projectKey&&card.action.kind==='open_project_group'))
  assert.ok(snapshot.intentCards?.some((card)=>card.type==='harvest'&&card.projectKey&&card.action.ref===harvestFile))
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

test('explicit ready_project overrides an unrelated single-file title', async () => {
  const event = activity('/workspace/资料/5ecdf91a6a98532ba0fec7ec22d35dc4.md', now)
  const service = new FileEmergenceService(makeDeps({
    activity: { prune: () => undefined, listRecent: () => [event] },
    documentMetadata: {
      getTitleMetadata: () => new Map([[event.path, {
        path: event.path,
        name: '5ecdf91a6a98532ba0fec7ec22d35dc4.md',
        readyProject: 'Pin 灵感整理',
      }]]),
    },
    search: null,
  }))

  const snapshot = await service.getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.equal(snapshot.buckets.today[0]?.title, 'Pin 灵感整理')
  assert.equal(snapshot.buckets.today[0]?.titleSource, 'frontmatter')
})

test('named tab groups and task artifacts provide bounded structural title evidence', async () => {
  const event = activity('/workspace/campaign/a.md', now)
  const service = new FileEmergenceService(makeDeps({
    activity: { prune: () => undefined, listRecent: () => [event] },
    structuralHints: {
      listHints: () => [{
        source: 'task',
        label: '夏季发布任务',
        paths: ['/workspace/campaign/a.md'],
        updatedAt: now,
      }],
    },
    search: null,
  }))

  const grouped = await service.getSnapshot({
    workspaceRoots: ['/workspace'],
    projectContext: {
      tabGroups: [{ name: '用户命名发布组', paths: ['/workspace/campaign/a.md', '/workspace/campaign/b.md'] }],
    },
  })
  assert.equal(grouped.buckets.today[0]?.title, '用户命名发布组')
  assert.equal(grouped.buckets.today[0]?.titleSource, 'tab_group')
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

test('feedback suppression produces a recoverable all-suppressed empty state', async () => {
  const identity: NonNullable<FileEmergenceServiceDeps['identity']> = {
    resolveCurrentFile: (_root, path) => ({ fileKey: `file:${path}`, currentPath: path }),
    resolveProject: (input) => ({ projectKey: 'project:stable', displayName: input.displayName, source: input.source, confidence: input.confidence, files: input.filePaths.map((path) => ({ fileKey: `file:${path}`, currentPath: path })) }),
  }
  const snapshot = await new FileEmergenceService(makeDeps({
    activity: { prune: () => undefined, listRecent: () => [activity('/workspace/project/a.md')] },
    identity,
    feedback: {
      resolve: () => ({ visible: false, reason: 'hidden', until: null }),
      listProjectFilePaths: () => ['/workspace/project/a.md'],
      listSuppressedFilePaths: () => ['/workspace/project/a.md'],
    },
    search: null,
  })).getSnapshot({ workspaceRoots: ['/workspace'] })
  assert.equal(snapshot.emptyState, 'all_suppressed')
  assert.equal(snapshot.diagnostics?.suppressedCounts?.hidden, 1)
  assert.deepEqual(snapshot.suppressedFilePaths, ['/workspace/project/a.md'])
  assert.equal(Object.values(snapshot.buckets).flat().length, 0)
})
