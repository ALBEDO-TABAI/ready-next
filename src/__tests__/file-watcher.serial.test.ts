/**
 * perf-rescue B7 — chokidar file-watcher tests. This file stays on the
 * serial lane because its final case observes real macOS FSEvents timing.
 *
 * The real chokidar event timing is flaky on CI (macOS FSEvents has a 30-50ms
 * coalescing window, Linux inotify can fire under heavy load), so these tests
 * inject a fake chokidar factory and drive the events directly. This keeps
 * the suite fast (sub-100ms total) and lets us assert the parts that the
 * watcher actually owns: debounce, blocklist, idempotent close.
 *
 * The blocklist test is the one place we exercise the real
 * `validateWorkspaceRoot` import — it uses no chokidar instance at all
 * because the validation runs before the factory is invoked.
 *
 * Coverage map:
 *   1. add/change/unlink emit through the debounce window with the right kind
 *   2. rapid identical changes collapse to a single callback (debounce)
 *   3. forbidden roots ('/Users', '~', '/Volumes/Drive', '/var') are rejected
 *      with structured error before the chokidar factory is ever invoked
 *   4. close() is idempotent and releases the chokidar handle exactly once
 *   5. AbortSignal aborts the watcher attach
 *   6. ENOSPC during factory call surfaces as `kind: 'enospc'`
 *   7. ignored path filter blocks events for node_modules / .git etc.
 *   8. registry stop / stopAll work correctly
 *   9. fatal errors after ready close and unregister the dead watcher
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createFileWatcher,
  FileWatcherRegistry,
  isPathIgnored,
  isInotifyExhaustionError,
  type ChokidarFactory,
  type ChokidarLike,
  type FileWatcherChange,
  type FileWatcherStartError,
} from '../main/modules/search-engine/file-watcher'

// Path that passes validateWorkspaceRoot: 4+ segments, not personal/system.
// We pick a synthetic path so we never depend on actual fs state.
const SAFE_ROOT = '/Users/alice/Documents/projects/sample'

interface FakeChokidar extends ChokidarLike {
  /** Direct event firers. The watcher attaches handlers via on(); we cache. */
  emit(event: 'add' | 'change' | 'unlink' | 'error' | 'ready', payload: unknown): void
  closed: boolean
  closeCallCount: number
}

function makeFakeChokidar(): FakeChokidar {
  const handlers: Record<string, Array<(payload: unknown) => void>> = {}
  const fake: FakeChokidar = {
    closed: false,
    closeCallCount: 0,
    on(event: string, listener: (payload: unknown) => void) {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(listener)
      return fake as unknown as ChokidarLike
    },
    emit(event: string, payload: unknown) {
      const list = handlers[event] ?? []
      for (const fn of list) fn(payload)
    },
    close(): Promise<void> {
      fake.closeCallCount += 1
      fake.closed = true
      return Promise.resolve()
    },
  }
  return fake
}

function captureFactory(): {
  factory: ChokidarFactory
  fake: FakeChokidar
  paths: Array<string | string[]>
  callCount: number
} {
  const fake = makeFakeChokidar()
  const paths: Array<string | string[]> = []
  let callCount = 0
  const factory: ChokidarFactory = (p) => {
    callCount += 1
    paths.push(p)
    return fake
  }
  return {
    factory,
    fake,
    paths,
    get callCount() { return callCount },
  }
}

// ----- 1. Forwards add/change/unlink ----------------------------------------

test('createFileWatcher forwards add/change/unlink with correct kind', async () => {
  const cap = captureFactory()
  const events: FileWatcherChange[] = []

  const handle = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    debounceMs: 10,
    chokidarFactory: cap.factory,
    onChange: (change) => { events.push(change) },
  })

  assert.ok(!('kind' in handle), 'expected handle, got error')

  const filePath = `${SAFE_ROOT}/notes/a.md`
  cap.fake.emit('add', filePath)
  cap.fake.emit('change', filePath)
  cap.fake.emit('unlink', filePath)

  // Wait for debounce window (10ms) plus small buffer.
  await new Promise<void>((resolve) => setTimeout(resolve, 50))

  assert.equal(events.length, 3, `expected 3 events, got ${events.length}`)
  assert.deepEqual(events.map((e) => e.kind), ['add', 'change', 'unlink'])
  for (const e of events) {
    assert.equal(e.filePath, filePath)
    assert.equal(e.workspaceRoot, SAFE_ROOT)
  }

  await ('close' in handle ? handle.close() : Promise.resolve())
})

// ----- 2. Debounce collapses rapid same-kind events -------------------------

test('debounce collapses rapid same-kind same-path events to one callback', async () => {
  const cap = captureFactory()
  const events: FileWatcherChange[] = []

  const handle = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    debounceMs: 30,
    chokidarFactory: cap.factory,
    onChange: (change) => { events.push(change) },
  })
  assert.ok(!('kind' in handle), 'expected handle, got error')

  const filePath = `${SAFE_ROOT}/foo.md`
  for (let i = 0; i < 10; i += 1) cap.fake.emit('change', filePath)

  await new Promise<void>((resolve) => setTimeout(resolve, 80))

  assert.equal(events.length, 1, `expected 1 collapsed event, got ${events.length}`)
  assert.equal(events[0].kind, 'change')

  await ('close' in handle ? handle.close() : Promise.resolve())
})

// ----- 3. Blocklist enforcement (real validateWorkspaceRoot) ----------------

test('blocklist rejects /Users without ever invoking chokidar factory', async () => {
  let factoryCalled = 0
  const factory: ChokidarFactory = () => {
    factoryCalled += 1
    return makeFakeChokidar()
  }
  const result = await createFileWatcher({
    workspaceRoot: '/Users',
    onChange: () => {},
    chokidarFactory: factory,
  })
  assert.equal(factoryCalled, 0, 'factory must not be invoked on rejected root')
  assert.ok('kind' in result, 'expected error result')
  const err = result as FileWatcherStartError
  assert.equal(err.kind, 'invalid_root')
  assert.match(err.reason ?? '', /forbidden_system_root|forbidden_user_root/)
})

test('blocklist rejects literal ~ and ~/', async () => {
  for (const root of ['~', '~/']) {
    const result = await createFileWatcher({
      workspaceRoot: root,
      onChange: () => {},
      chokidarFactory: () => makeFakeChokidar(),
    })
    assert.ok('kind' in result, `expected error for ${root}`)
    assert.equal((result as FileWatcherStartError).kind, 'invalid_root')
  }
})

test('blocklist rejects whole-drive /Volumes/<x>', async () => {
  const result = await createFileWatcher({
    workspaceRoot: '/Volumes/MyExternalDrive',
    onChange: () => {},
    chokidarFactory: () => makeFakeChokidar(),
  })
  assert.ok('kind' in result, 'expected error')
  assert.equal((result as FileWatcherStartError).kind, 'invalid_root')
})

test('blocklist rejects too-short paths (< 4 segments)', async () => {
  const result = await createFileWatcher({
    workspaceRoot: '/opt/foo',
    onChange: () => {},
    chokidarFactory: () => makeFakeChokidar(),
  })
  assert.ok('kind' in result, 'expected error')
  assert.equal((result as FileWatcherStartError).kind, 'invalid_root')
})

// ----- 4. close() is idempotent + releases chokidar resource ----------------

test('close releases chokidar resource exactly once across multiple calls', async () => {
  const cap = captureFactory()
  const handle = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    onChange: () => {},
    chokidarFactory: cap.factory,
  })
  assert.ok(!('kind' in handle), 'expected handle')
  if ('kind' in handle) return

  await handle.close()
  await handle.close() // double-close
  await handle.close() // triple-close

  assert.equal(cap.fake.closeCallCount, 1, 'chokidar.close should fire exactly once')
  assert.equal(cap.fake.closed, true, 'fake must be in closed state')
})

test('close drains pending debounce timers without firing them', async () => {
  const cap = captureFactory()
  const events: FileWatcherChange[] = []

  const handle = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    debounceMs: 100, // long enough to outlive close()
    chokidarFactory: cap.factory,
    onChange: (change) => { events.push(change) },
  })
  assert.ok(!('kind' in handle), 'expected handle')
  if ('kind' in handle) return

  cap.fake.emit('change', `${SAFE_ROOT}/x.md`)
  // Close while the debounce timer is still pending.
  await handle.close()
  // Wait past the debounce window.
  await new Promise<void>((resolve) => setTimeout(resolve, 150))

  assert.equal(events.length, 0, 'pending debounced events must not fire after close')
})

// ----- 5. AbortSignal aborts attach -----------------------------------------

test('pre-aborted signal returns failed result and closes immediately', async () => {
  const cap = captureFactory()
  const controller = new AbortController()
  controller.abort()

  const result = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    onChange: () => {},
    signal: controller.signal,
    chokidarFactory: cap.factory,
  })
  assert.ok('kind' in result, 'expected error result')
  assert.equal((result as FileWatcherStartError).kind, 'failed')
  assert.equal(cap.fake.closeCallCount, 1, 'chokidar must be closed even on abort')
})

test('signal abort after start triggers close', async () => {
  const cap = captureFactory()
  const controller = new AbortController()
  const handle = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    onChange: () => {},
    signal: controller.signal,
    chokidarFactory: cap.factory,
  })
  assert.ok(!('kind' in handle), 'expected handle')

  controller.abort()
  // Wait for the once-listener to fire.
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  assert.equal(cap.fake.closeCallCount, 1, 'abort must close watcher')
})

// ----- 6. ENOSPC surfaces as kind:'enospc' ----------------------------------

test('ENOSPC during factory call returns kind:enospc', async () => {
  const factory: ChokidarFactory = () => {
    const err = new Error('ENOSPC: System limit for number of file watchers reached')
    ;(err as NodeJS.ErrnoException).code = 'ENOSPC'
    throw err
  }
  const result = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    onChange: () => {},
    chokidarFactory: factory,
  })
  assert.ok('kind' in result, 'expected error')
  const err = result as FileWatcherStartError
  assert.equal(err.kind, 'enospc')
  assert.match(err.message, /ENOSPC|inotify/i)
})

test('asynchronous native watcher startup failure is returned instead of a dead handle', async () => {
  const fake = Object.assign(makeFakeChokidar(), { startupConfirmationRequired: true as const })
  let ghostChanges = 0
  const factory: ChokidarFactory = () => {
    queueMicrotask(() => {
      fake.emit('add', `${SAFE_ROOT}/ghost.md`)
      fake.emit('error', Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' }))
    })
    return fake
  }
  const result = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    debounceMs: 5,
    onChange: () => { ghostChanges += 1 },
    chokidarFactory: factory,
  })
  assert.ok('kind' in result, 'expected startup error instead of a watcher handle')
  assert.equal((result as FileWatcherStartError).kind, 'failed')
  assert.match((result as FileWatcherStartError).message, /EMFILE/)
  assert.equal(fake.closeCallCount, 1)
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  assert.equal(ghostChanges, 0)
})

test('pre-ready native events are delivered once after startup succeeds', async () => {
  const fake = Object.assign(makeFakeChokidar(), { startupConfirmationRequired: true as const })
  let changes = 0
  const factory: ChokidarFactory = () => {
    queueMicrotask(() => {
      fake.emit('add', `${SAFE_ROOT}/during-startup.md`)
      fake.emit('add', `${SAFE_ROOT}/during-startup.md`)
      fake.emit('ready', undefined)
    })
    return fake
  }
  const result = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    debounceMs: 5,
    onChange: () => { changes += 1 },
    chokidarFactory: factory,
  })
  assert.ok(!('kind' in result), 'expected a confirmed watcher handle')
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  assert.equal(changes, 1)
  if (!('kind' in result)) await result.close()
  assert.equal(fake.closeCallCount, 1)
})

test('native watcher startup timeout closes once without delivering pre-ready events', async () => {
  const fake = Object.assign(makeFakeChokidar(), { startupConfirmationRequired: true as const })
  let ghostChanges = 0
  const factory: ChokidarFactory = () => {
    queueMicrotask(() => fake.emit('change', `${SAFE_ROOT}/ghost.md`))
    return fake
  }
  const result = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    debounceMs: 5,
    onChange: () => { ghostChanges += 1 },
    chokidarFactory: factory,
  })
  assert.ok('kind' in result, 'expected startup timeout instead of a watcher handle')
  assert.equal((result as FileWatcherStartError).kind, 'failed')
  assert.match((result as FileWatcherStartError).message, /timed out/)
  assert.equal(fake.closeCallCount, 1)
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  assert.equal(ghostChanges, 0)
})

test('abort during native startup closes promptly without delivering pre-ready events', async () => {
  const fake = Object.assign(makeFakeChokidar(), { startupConfirmationRequired: true as const })
  const controller = new AbortController()
  let ghostChanges = 0
  const factory: ChokidarFactory = () => {
    queueMicrotask(() => fake.emit('change', `${SAFE_ROOT}/ghost.md`))
    setTimeout(() => controller.abort(), 10)
    return fake
  }
  const startedAt = Date.now()
  const result = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    debounceMs: 5,
    onChange: () => { ghostChanges += 1 },
    signal: controller.signal,
    chokidarFactory: factory,
  })
  assert.ok('kind' in result, 'expected abort instead of a watcher handle')
  assert.equal((result as FileWatcherStartError).kind, 'failed')
  assert.match((result as FileWatcherStartError).message, /aborted/)
  assert.ok(Date.now() - startedAt < 250, 'abort must win over the one-second startup timeout')
  assert.equal(fake.closeCallCount, 1)
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  assert.equal(ghostChanges, 0)
})

test('fatal error after ready closes and unregisters the dead watcher', async () => {
  const fake = Object.assign(makeFakeChokidar(), { startupConfirmationRequired: true as const })
  const factory: ChokidarFactory = () => {
    queueMicrotask(() => fake.emit('ready', undefined))
    return fake
  }
  const result = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    debounceMs: 5,
    onChange: () => {},
    chokidarFactory: factory,
  })
  assert.ok(!('kind' in result), 'expected a confirmed watcher handle')
  if ('kind' in result) return

  const failures: Array<{ watcherId: string; message: string }> = []
  const registry = new FileWatcherRegistry()
  assert.equal(registry.add(result, (event) => failures.push(event)), true)
  assert.equal(registry.has(result.id), true)

  fake.emit('error', Object.assign(new Error('EMFILE: runtime watcher died'), { code: 'EMFILE' }))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  assert.equal(fake.closeCallCount, 1, 'fatal runtime error must close the native handle')
  assert.equal(registry.has(result.id), false, 'fatal runtime error must remove the registry entry')
  assert.equal(failures.length, 1)
  assert.equal(failures[0].watcherId, result.id)
  assert.equal(failures[0].message, 'EMFILE: runtime watcher died')
})

test('isInotifyExhaustionError detects ENOSPC by code or text', () => {
  const byCode: NodeJS.ErrnoException = Object.assign(new Error('boom'), { code: 'ENOSPC' as const })
  assert.equal(isInotifyExhaustionError(byCode), true)
  assert.equal(isInotifyExhaustionError(new Error('ENOSPC')), true)
  assert.equal(isInotifyExhaustionError(new Error('unrelated failure')), false)
  assert.equal(isInotifyExhaustionError(undefined), false)
  assert.equal(isInotifyExhaustionError('not an error'), false)
})

// ----- 7. isPathIgnored applies dir blocklist -------------------------------

test('isPathIgnored matches blocked dir names anywhere in the path', () => {
  for (const p of [
    '/proj/node_modules/foo/bar.js',
    '/proj/.git/HEAD',
    '/proj/.next/cache.js',
    '/proj/.venv/bin/activate',
    '/proj/dist/bundle.js',
    '/proj/build/out.o',
    '/proj/coverage/index.html',
    '/proj/__pycache__/x.pyc',
  ]) {
    assert.equal(isPathIgnored(p), true, `expected ${p} to be ignored`)
  }
  for (const p of [
    '/proj/src/index.ts',
    '/proj/notes/note.md',
    '',
  ]) {
    assert.equal(isPathIgnored(p), false, `expected ${p} NOT to be ignored`)
  }
})

test('isPathIgnored treats macOS app/framework bundles as ignored', () => {
  assert.equal(isPathIgnored('/Applications/Xcode.app/Contents/Info.plist'), true)
  assert.equal(isPathIgnored('/proj/MyKit.framework/Versions/A/Foo'), true)
})

// Defense-in-depth: even if chokidar's own ignored filter let something
// through, the watcher rechecks before forwarding.
test('events for ignored paths are dropped at the JS layer', async () => {
  const cap = captureFactory()
  const events: FileWatcherChange[] = []
  const handle = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    debounceMs: 5,
    chokidarFactory: cap.factory,
    onChange: (change) => { events.push(change) },
  })
  assert.ok(!('kind' in handle), 'expected handle')

  cap.fake.emit('add', `${SAFE_ROOT}/node_modules/lib/index.js`)
  cap.fake.emit('change', `${SAFE_ROOT}/.git/HEAD`)
  cap.fake.emit('add', `${SAFE_ROOT}/src/legit.ts`)

  await new Promise<void>((resolve) => setTimeout(resolve, 30))

  assert.equal(events.length, 1, `expected 1 legit event, got ${events.length}`)
  assert.equal(events[0].filePath, `${SAFE_ROOT}/src/legit.ts`)

  if (!('kind' in handle)) await handle.close()
})

// ----- 8. FileWatcherRegistry contract --------------------------------------

test('FileWatcherRegistry.add + stop + stopAll are correct', async () => {
  const cap1 = captureFactory()
  const cap2 = captureFactory()
  const h1 = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    onChange: () => {},
    chokidarFactory: cap1.factory,
  })
  const h2 = await createFileWatcher({
    workspaceRoot: '/Users/bob/Documents/projects/another',
    onChange: () => {},
    chokidarFactory: cap2.factory,
  })
  assert.ok(!('kind' in h1) && !('kind' in h2), 'expected handles')
  if ('kind' in h1 || 'kind' in h2) return

  const registry = new FileWatcherRegistry()
  registry.add(h1)
  registry.add(h2)
  assert.equal(registry.size(), 2)
  assert.equal(registry.has(h1.id), true)

  // Stop one.
  const ok = await registry.stop(h1.id)
  assert.equal(ok, true)
  assert.equal(registry.size(), 1)
  assert.equal(cap1.fake.closeCallCount, 1)

  // Stop unknown id is a no-op.
  const noop = await registry.stop('wch-00000000')
  assert.equal(noop, false)

  // stopAll.
  const remaining = await registry.stopAll()
  assert.equal(remaining, 1, 'stopAll returns count of remaining watchers')
  assert.equal(registry.size(), 0)
  assert.equal(cap2.fake.closeCallCount, 1)
})

test('createFileWatcher gives each handle a unique id', async () => {
  const ids = new Set<string>()
  for (let i = 0; i < 8; i += 1) {
    const cap = captureFactory()
    const handle = await createFileWatcher({
      workspaceRoot: SAFE_ROOT,
      onChange: () => {},
      chokidarFactory: cap.factory,
    })
    assert.ok(!('kind' in handle), 'expected handle')
    if ('kind' in handle) return
    assert.match(handle.id, /^wch-[0-9a-f]{8}$/)
    ids.add(handle.id)
    await handle.close()
  }
  assert.equal(ids.size, 8, 'all 8 ids must be unique')
})

// ----- 9. callback exceptions don't crash the watcher -----------------------

test('onChange throw is swallowed and watcher keeps running', async () => {
  const cap = captureFactory()
  let count = 0
  const handle = await createFileWatcher({
    workspaceRoot: SAFE_ROOT,
    debounceMs: 5,
    chokidarFactory: cap.factory,
    onChange: () => {
      count += 1
      if (count === 1) throw new Error('boom')
    },
  })
  assert.ok(!('kind' in handle), 'expected handle')

  cap.fake.emit('add', `${SAFE_ROOT}/a.md`)
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
  cap.fake.emit('add', `${SAFE_ROOT}/b.md`)
  await new Promise<void>((resolve) => setTimeout(resolve, 30))

  assert.equal(count, 2, 'second event must still fire after first throws')

  if (!('kind' in handle)) await handle.close()
})

// D15：darwin 原生 recursive watcher（每根 1 个 FSEvents fd，替代 chokidar
// v5 的 kqueue 每文件一 fd——后者把主进程 fd 表灌满后所有子进程 spawn 必死）。
// 真实 fs 行为测试：add/change/unlink 全链 + 目录事件被过滤。
test('darwin native recursive watcher emits add/change/unlink from real fs events', { skip: process.platform !== 'darwin' }, async () => {
  const { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath, basename } = await import('node:path')
  const { createDarwinRecursiveWatcher } = await import('../main/modules/search-engine/file-watcher')

  const root = mkdtempSync(joinPath(tmpdir(), 'fw-darwin-'))
  const events: string[] = []
  const watcher = createDarwinRecursiveWatcher(root)
  try {
    watcher.on('add', (p) => events.push(`add:${basename(p)}`))
    watcher.on('change', (p) => events.push(`change:${basename(p)}`))
    watcher.on('unlink', (p) => events.push(`unlink:${basename(p)}`))

    const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
      }
      assert.fail(`timeout waiting for ${label}; events=${JSON.stringify(events)}`)
    }

    // FSEvents 需要短暂预热，先让 watcher 挂稳。
    await new Promise<void>((resolve) => setTimeout(resolve, 250))

    mkdirSync(joinPath(root, 'sub'))
    writeFileSync(joinPath(root, 'sub', 'a.md'), 'x')
    await waitFor(() => events.includes('add:a.md'), 'add:a.md')
    assert.ok(!events.includes('add:sub'), 'directory events must be filtered')

    const beforeAppend = events.length
    appendFileSync(joinPath(root, 'sub', 'a.md'), 'y')
    await waitFor(
      () => events.slice(beforeAppend).some((e) => e === 'change:a.md' || e === 'add:a.md'),
      'post-append change:a.md',
    )

    rmSync(joinPath(root, 'sub', 'a.md'))
    await waitFor(() => events.includes('unlink:a.md'), 'unlink:a.md')
  } finally {
    await watcher.close()
    rmSync(root, { recursive: true, force: true })
  }
})
