/**
 * Behavior tests for `runContentStudyBackground`.
 *
 * Injects fake clip runner + fake headless one-shot + fake fs so the
 * test stays pure (no electron, no SQLite, no real network).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runContentStudyBackground,
  sanitizeStudyFilename,
  validateContentStudyArgs,
  type ContentStudyBackgroundUpdate,
  type ContentStudyRunnerDeps,
} from '../main/modules/clipping/content-study-runner'
import type {
  ClipBackgroundUpdate,
  ClipDraggedTabRunnerDeps,
  ClipDraggedTabIPCController,
} from '../main/modules/clipping/clip-dragged-tab-runner'

const fakeAIConfig = {
  provider: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-test',
  model: 'claude-sonnet-4-6',
}

function buildClipRunnerDepsStub(): ClipDraggedTabRunnerDeps {
  return {
    getRuntimeInfo: () => ({ skillsRoot: '/fake/skills', outputsRoot: '/fake/outputs' }),
    fetchHtml: async () => {
      throw new Error('fetchHtml should not be called when runClipBackground is mocked')
    },
    fetchJina: async () => '',
    runPipeline: (async () => {
      throw new Error('runPipeline should not be called when runClipBackground is mocked')
    }) as ClipDraggedTabRunnerDeps['runPipeline'],
    generateTaskId: () => 'unused',
    materializeToTargetDir: async () => ({
      ok: false,
      error: { kind: 'target_write_failed', message: 'unused' },
    }),
  }
}

interface RecorderController {
  controller: ClipDraggedTabIPCController
  events: Array<{ channel: string; data: unknown }>
}

function makeRecorderController(): RecorderController {
  const events: Array<{ channel: string; data: unknown }> = []
  return {
    controller: {
      sendToRenderer: (channel: string, data: unknown) => {
        events.push({ channel, data })
      },
    },
    events,
  }
}

function pickStudyEvents(events: Array<{ channel: string; data: unknown }>): ContentStudyBackgroundUpdate[] {
  return events
    .filter((e) => e.channel === 'clip:contentStudyUpdate')
    .map((e) => e.data as ContentStudyBackgroundUpdate)
}

function buildDeps(overrides: Partial<ContentStudyRunnerDeps> = {}): ContentStudyRunnerDeps {
  const fsStore = new Map<string, string>()
  return {
    runClipBackground: async (clipTaskId, _args, controller, _deps) => {
      const completedEvent: ClipBackgroundUpdate = {
        taskId: clipTaskId,
        status: 'completed',
        url: 'https://example.com/article',
        title: 'Hello World',
        targetHint: '/workspace/notes',
        savedPath: '',
        savedPathRelative: '',
        suggestedVaultRelativePath: 'Hello World.md',
        copiedPath: '/workspace/notes/Hello World.md',
        preset: { id: 'auto', name: 'auto' },
        frontmatter: {},
        warnings: [],
      }
      fsStore.set('/workspace/notes/Hello World.md', '# Hello\n\nbody markdown')
      controller.sendToRenderer('clip:backgroundUpdate', completedEvent)
    },
    clipRunnerDeps: buildClipRunnerDepsStub(),
    readSkillMd: async () => 'SKILL.md content for study-notes',
    readMarkdown: async (path) => {
      const v = fsStore.get(path)
      if (v === undefined) throw new Error(`fake fs: missing ${path}`)
      return v
    },
    writeMarkdown: async (path, content) => {
      fsStore.set(path, content)
    },
    pathExists: async (path) => fsStore.has(path),
    joinPath: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    dirnameOf: (path) => {
      const idx = path.lastIndexOf('/')
      return idx < 0 ? path : path.slice(0, idx)
    },
    getActiveAIConfig: () => fakeAIConfig,
    requestHeadlessOneShot: async ({ user }) => ({
      ok: true,
      text: `# 学习笔记\n\n用户消息长度：${user.length}`,
    }),
    generateTaskId: () => 'unused',
    ...overrides,
  }
}

test('happy path: clip succeeds → study generates notes → completed event with copiedPath', async () => {
  const { controller, events } = makeRecorderController()
  const deps = buildDeps()

  await runContentStudyBackground(
    'cs-clip-1',
    'cs-study-1',
    { url: 'https://example.com/article', title: 'Hello World', target_dir: '/workspace/notes' },
    controller,
    deps,
  )

  const studyEvents = pickStudyEvents(events)
  assert.deepEqual(
    studyEvents.map((e) => e.status),
    ['waiting_for_clip', 'running', 'completed'],
  )
  const completed = studyEvents[studyEvents.length - 1]
  assert.equal(completed.status, 'completed')
  assert.match(completed.copiedPath ?? '', /学习笔记\.md$/)
  // The completed event's copiedPath should be in the same dir as clip output.
  assert.match(completed.copiedPath ?? '', /^\/workspace\/notes\//)
})

test('clip fails → study placeholder is skipped, LLM never called', async () => {
  let llmCallCount = 0
  const { controller, events } = makeRecorderController()
  const deps = buildDeps({
    runClipBackground: async (clipTaskId, _args, controller) => {
      controller.sendToRenderer('clip:backgroundUpdate', {
        taskId: clipTaskId,
        status: 'failed',
        url: 'https://example.com/article',
        errorKind: 'clip_fetch_failed',
        recoverable: true,
        errorDetail: { message: 'network down' },
      } satisfies ClipBackgroundUpdate)
    },
    requestHeadlessOneShot: async () => {
      llmCallCount += 1
      return { ok: true, text: 'should not happen' }
    },
  })

  await runContentStudyBackground(
    'cs-clip-2',
    'cs-study-2',
    { url: 'https://example.com/article', target_dir: '/workspace/notes' },
    controller,
    deps,
  )

  assert.equal(llmCallCount, 0)
  const studyEvents = pickStudyEvents(events)
  const final = studyEvents[studyEvents.length - 1]
  assert.equal(final.status, 'skipped')
  assert.equal(final.errorKind, 'clip_failed')
  assert.match(final.errorMessage ?? '', /剪藏未完成/)
})

test('no AI config → study fails fast with errorKind=no_ai_config', async () => {
  const { controller, events } = makeRecorderController()
  const deps = buildDeps({ getActiveAIConfig: () => null })

  await runContentStudyBackground(
    'cs-clip-3',
    'cs-study-3',
    { url: 'https://example.com/article', target_dir: '/workspace/notes' },
    controller,
    deps,
  )

  const studyEvents = pickStudyEvents(events)
  const final = studyEvents[studyEvents.length - 1]
  assert.equal(final.status, 'failed')
  assert.equal(final.errorKind, 'no_ai_config')
})

test('clip completed with copyError + target_dir → study fails with clip_target_dir_failed (regression for silent-sandbox-write bug)', async () => {
  // The clip runner emits `status: 'completed'` even when its
  // materialize-to-target-dir step failed — it leaves `copyError` set and
  // `copiedPath` undefined while `savedPath` points to the sandbox. Without
  // an explicit check, the study runner would write notes to the sandbox
  // dir and report `completed`, falsely looking successful while the user's
  // chosen folder receives neither file.
  let llmCallCount = 0
  let studyWriteCount = 0
  const { controller, events } = makeRecorderController()
  const deps = buildDeps({
    runClipBackground: async (clipTaskId, _args, controller) => {
      // Realistic clip behavior on materialize failure: completed status,
      // copyError populated, copiedPath empty.
      controller.sendToRenderer('clip:backgroundUpdate', {
        taskId: clipTaskId,
        status: 'completed',
        url: 'https://example.com/article',
        title: 'Hello World',
        targetHint: '/workspace/notes',
        savedPath: '/fake/outputs/sandbox/clip-xyz.md',
        savedPathRelative: 'clip-xyz.md',
        suggestedVaultRelativePath: 'Hello World.md',
        copiedPath: undefined,
        copyError: { kind: 'target_write_failed', message: 'EACCES: permission denied' },
        preset: { id: 'auto', name: 'auto' },
        frontmatter: {},
        warnings: [],
      })
    },
    requestHeadlessOneShot: async () => {
      llmCallCount += 1
      return { ok: true, text: 'should not happen' }
    },
    writeMarkdown: async () => {
      studyWriteCount += 1
    },
  })

  await runContentStudyBackground(
    'cs-clip-fail',
    'cs-study-fail',
    {
      url: 'https://example.com/article',
      title: 'Hello World',
      target_dir: '/workspace/notes',
    },
    controller,
    deps,
  )

  // LLM and write both must be short-circuited.
  assert.equal(llmCallCount, 0, 'LLM call must not happen when clip target_dir failed')
  assert.equal(studyWriteCount, 0, 'study notes must not be written when target_dir failed')

  const studyEvents = pickStudyEvents(events)
  const final = studyEvents[studyEvents.length - 1]
  assert.equal(final.status, 'failed', 'study must be marked failed, not completed')
  assert.equal(final.errorKind, 'clip_target_dir_failed')
  assert.match(final.errorMessage ?? '', /目标目录/)
  // copiedPath must be absent so the renderer cannot mistakenly highlight a
  // sandbox path that the user does not see in their file tree.
  assert.equal(final.copiedPath, undefined)
})

test('clip completed without target_dir (agent-invoked clip) → study still proceeds against sandbox path', async () => {
  // When the runner is invoked without a target_dir (e.g. by an agent tool
  // call, not from drag-drop), the sandbox path is the only output. Study
  // should still proceed using that path, since the "no folder to write to"
  // case is not a user-visible regression.
  const { controller, events } = makeRecorderController()
  const fsStore = new Map<string, string>()
  fsStore.set('/fake/outputs/sandbox/clip-xyz.md', '# body')
  const deps = buildDeps({
    runClipBackground: async (clipTaskId, _args, controller) => {
      controller.sendToRenderer('clip:backgroundUpdate', {
        taskId: clipTaskId,
        status: 'completed',
        url: 'https://example.com/article',
        savedPath: '/fake/outputs/sandbox/clip-xyz.md',
        savedPathRelative: 'clip-xyz.md',
        suggestedVaultRelativePath: 'Hello World.md',
        preset: { id: 'auto', name: 'auto' },
        frontmatter: {},
        warnings: [],
      })
    },
    readMarkdown: async (path) => fsStore.get(path) ?? '',
    writeMarkdown: async (path, content) => {
      fsStore.set(path, content)
    },
    pathExists: async (path) => fsStore.has(path),
  })

  await runContentStudyBackground(
    'cs-clip-no-dir',
    'cs-study-no-dir',
    { url: 'https://example.com/article' }, // no target_dir
    controller,
    deps,
  )

  const studyEvents = pickStudyEvents(events)
  const final = studyEvents[studyEvents.length - 1]
  assert.equal(final.status, 'completed', 'sandbox-only clip should still let study run')
  assert.match(final.copiedPath ?? '', /^\/fake\/outputs\/sandbox\//)
})

test('LLM error → study fails with errorKind=ai_failed', async () => {
  const { controller, events } = makeRecorderController()
  const deps = buildDeps({
    requestHeadlessOneShot: async () => ({
      ok: false,
      errorKind: 'http_error',
      message: 'upstream 500',
    }),
  })

  await runContentStudyBackground(
    'cs-clip-4',
    'cs-study-4',
    { url: 'https://example.com/article', target_dir: '/workspace/notes' },
    controller,
    deps,
  )

  const studyEvents = pickStudyEvents(events)
  const final = studyEvents[studyEvents.length - 1]
  assert.equal(final.status, 'failed')
  assert.equal(final.errorKind, 'ai_failed')
})

test('filename conflict → study writes to <name>-2.md', async () => {
  const { controller, events } = makeRecorderController()
  const baseDeps = buildDeps()
  // Pre-seed both the clip output and a conflicting study notes file.
  const writes: Array<{ path: string; content: string }> = []
  const existing = new Set<string>([
    '/workspace/notes/Hello World.md',
    '/workspace/notes/Hello World-学习笔记.md',
  ])
  const deps: ContentStudyRunnerDeps = {
    ...baseDeps,
    pathExists: async (path) => existing.has(path),
    writeMarkdown: async (path, content) => {
      writes.push({ path, content })
      existing.add(path)
    },
    readMarkdown: async (path) =>
      path === '/workspace/notes/Hello World.md' ? '# body' : '',
  }

  await runContentStudyBackground(
    'cs-clip-5',
    'cs-study-5',
    { url: 'https://example.com/article', title: 'Hello World', target_dir: '/workspace/notes' },
    controller,
    deps,
  )

  const studyEvents = pickStudyEvents(events)
  const final = studyEvents[studyEvents.length - 1]
  assert.equal(final.status, 'completed')
  assert.match(final.copiedPath ?? '', /-2\.md$/)
})

test('sanitizeStudyFilename strips invalid characters and clamps length', () => {
  assert.equal(sanitizeStudyFilename('foo/bar:baz', 'https://x.com'), 'foo bar baz')
  assert.equal(sanitizeStudyFilename('', 'https://example.com/a/b'), 'https example.com a b')
  // length clamp at 80 chars
  const long = 'x'.repeat(200)
  const out = sanitizeStudyFilename(long, 'fallback')
  assert.ok(out.length <= 80, `expected ≤80 chars, got ${out.length}`)
})

test('validateContentStudyArgs rejects non-http URLs', () => {
  const ok = validateContentStudyArgs({ url: 'https://example.com' })
  assert.equal(ok.ok, true)
  const bad = validateContentStudyArgs({ url: 'file:///etc/passwd' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.errorKind, 'invalid_url')
})
