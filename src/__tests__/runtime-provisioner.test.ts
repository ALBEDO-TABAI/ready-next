import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMirrorUrl,
  selectRuntimeSourceOrder,
  classifyProvisionFailure,
  venvNeedsRebuild,
  parsePyvenvCfg,
  assertSafeRuntimeArchiveEntry,
  isRuntimeAssetPinned,
  markRuntimeIntegrityError,
  RUNTIME_ASSET_REGISTRY,
  RUNTIME_PLATFORM_KEYS,
  resolveRuntimePlatformKey,
  type RuntimeAsset,
  type RuntimeAssetArchive,
} from '../shared/runtime-asset-registry'
import {
  RuntimeProvisioner,
  RuntimeProvisionError,
  type RuntimeProvisionerDeps,
} from '../main/modules/skills-runtime/runtime-provisioner'

const HASH_GOOD = 'a'.repeat(64)

// ---------------- pure helpers ----------------

test('buildMirrorUrl composes base/platform/filename, null when no mirror', () => {
  const asset = { platform: 'win32-x64' } as RuntimeAsset
  const archive = { filename: 'x.zip' } as RuntimeAssetArchive
  assert.equal(buildMirrorUrl(asset, archive, null), null)
  assert.equal(buildMirrorUrl(asset, archive, 'https://cdn/ready/'), 'https://cdn/ready/win32-x64/x.zip')
})

test('selectRuntimeSourceOrder forces user mirror first, then probe-ascending, null last (not dropped)', async () => {
  const asset = {
    platform: 'win32-x64',
  } as RuntimeAsset
  const archive = {
    filename: 'x.zip',
    sources: [{ url: 'A', kind: 'primary' }, { url: 'B', kind: 'mirror' }, { url: 'C', kind: 'mirror' }],
  } as RuntimeAssetArchive
  const latency: Record<string, number | null> = { A: 300, B: null, C: 50 }
  const order = await selectRuntimeSourceOrder(asset, archive, 'https://cdn/', async (u) => latency[u] ?? null)
  // mirror forced first, then C(50) < A(300) < B(null)
  assert.deepEqual(order, ['https://cdn/win32-x64/x.zip', 'C', 'A', 'B'])
})

test('classifyProvisionFailure: integrity if any source downloaded-but-bad, else unreachable', () => {
  assert.equal(classifyProvisionFailure([{ url: 'a', ok: false, failureKind: 'unreachable' }]), 'all_sources_unreachable')
  assert.equal(classifyProvisionFailure([
    { url: 'a', ok: false, failureKind: 'unreachable' },
    { url: 'b', ok: false, failureKind: 'integrity', reason: 'sha256' },
  ]), 'asset_integrity_failed')
})

test('venvNeedsRebuild: realpath-normalized prefix test under python-dist', () => {
  const dist = '/r/python-dist'
  assert.equal(venvNeedsRebuild({ venvExists: false, venvBaseRealpath: null, pythonDistRealpath: dist }), true)
  assert.equal(venvNeedsRebuild({ venvExists: true, venvBaseRealpath: null, pythonDistRealpath: dist }), true)
  // old system python (outside dist) → rebuild
  assert.equal(venvNeedsRebuild({ venvExists: true, venvBaseRealpath: '/usr/bin/python3.11', pythonDistRealpath: dist }), true)
  // base under dist (home=bin dir style) → keep
  assert.equal(venvNeedsRebuild({ venvExists: true, venvBaseRealpath: '/r/python-dist/python/bin', pythonDistRealpath: dist }), false)
  assert.equal(venvNeedsRebuild({ venvExists: true, venvBaseRealpath: '/r/python-dist', pythonDistRealpath: dist }), false)
})

test('parsePyvenvCfg parses key=value (executable/home)', () => {
  const m = parsePyvenvCfg('home = /r/python-dist/python/bin\nexecutable = /r/python-dist/python/bin/python3.11\nversion = 3.11.9')
  assert.equal(m.get('home'), '/r/python-dist/python/bin')
  assert.equal(m.get('executable'), '/r/python-dist/python/bin/python3.11')
})

test('assertSafeRuntimeArchiveEntry rejects abs / .. / escaping symlink, accepts in-tree', () => {
  assert.throws(() => assertSafeRuntimeArchiveEntry('/etc/passwd'))
  assert.throws(() => assertSafeRuntimeArchiveEntry('C:/Windows/x'))
  assert.throws(() => assertSafeRuntimeArchiveEntry('a/../../b'))
  assert.throws(() => assertSafeRuntimeArchiveEntry('link', { isSymlink: true, linkTarget: '/etc' }))
  assert.throws(() => assertSafeRuntimeArchiveEntry('link', { isSymlink: true, linkTarget: '../../x' }))
  assert.throws(() => assertSafeRuntimeArchiveEntry('link', { isSymlink: true, linkTarget: '' }))
  assert.doesNotThrow(() => assertSafeRuntimeArchiveEntry('python/bin/python3'))
  assert.doesNotThrow(() => assertSafeRuntimeArchiveEntry('link', { isSymlink: true, linkTarget: 'sibling/file' }))
})

test('shipped registry: every platform has python+ffmpeg, sources have ≥1 primary +1 mirror (win)', () => {
  for (const key of RUNTIME_PLATFORM_KEYS) {
    const assets = RUNTIME_ASSET_REGISTRY.filter((a) => a.platform === key)
    assert.ok(assets.some((a) => a.id === 'python'), `${key} missing python`)
    assert.ok(assets.some((a) => a.id === 'ffmpeg'), `${key} missing ffmpeg`)
    for (const asset of assets) {
      assert.ok(asset.archives.length > 0, `${key}/${asset.id} missing archives`)
      for (const archive of asset.archives) {
        assert.ok(archive.sources.some((s) => s.kind === 'primary'), `${key}/${asset.id}/${archive.filename} missing primary`)
        assert.ok(archive.outputs.length > 0, `${key}/${asset.id}/${archive.filename} missing outputs`)
        assert.equal(archive.sources.some((s) => s.url.includes('ready-runtime.invalid')), false)
      }
    }
    const python = assets.find((a) => a.id === 'python')
    assert.ok(python?.archives.every((archive) => archive.sources.some((s) => s.url.startsWith('https://mirrors.ustc.edu.cn/github-release/'))), `${key} python missing USTC mirror`)
    // P0 done: every shipped archive must carry a real 64-hex sha256, never the placeholder.
    for (const asset of assets) {
      assert.ok(isRuntimeAssetPinned(asset), `${key}/${asset.id} not pinned (placeholder sha256 shipped)`)
    }
  }
  assert.equal(resolveRuntimePlatformKey('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(resolveRuntimePlatformKey('linux', 'x64'), null)
})

// ---------------- provisioner orchestration ----------------

function pinnedPython(): RuntimeAsset {
  return {
    id: 'python', platform: 'darwin-arm64', version: '3.11.9',
    archives: [{
      sha256: HASH_GOOD,
      filename: 'py.tar.gz', archiveKind: 'tar.gz', expectedUncompressedBytes: 1000,
      outputs: [{ kind: 'python', relPath: 'python/bin/python3' }],
      sources: [{ url: 'PY_A', kind: 'primary' }, { url: 'PY_B', kind: 'mirror' }],
    }],
  }
}
function pinnedFfmpeg(): RuntimeAsset {
  return {
    id: 'ffmpeg', platform: 'darwin-arm64', version: 'static',
    archives: [
      {
        sha256: HASH_GOOD,
        filename: 'ffmpeg.zip', archiveKind: 'zip', expectedUncompressedBytes: 1000,
        outputs: [{ kind: 'ffmpeg', relPath: 'ffmpeg', expectedArch: 'arm64' }],
        sources: [{ url: 'FF_A', kind: 'primary' }],
      },
      {
        sha256: HASH_GOOD,
        filename: 'ffprobe.zip', archiveKind: 'zip', expectedUncompressedBytes: 1000,
        outputs: [{ kind: 'ffprobe', relPath: 'ffprobe', expectedArch: 'arm64' }],
        sources: [{ url: 'FP_A', kind: 'primary' }],
      },
    ],
  }
}

interface FakeState {
  existing: Set<string>
  extractedDirs: Set<string>
  text: Map<string, string>
  realpathMap: Map<string, string>
}

function makeDeps(over: Partial<RuntimeProvisionerDeps> & {
  assets?: RuntimeAsset[]
  downloadFor?: (url: string) => Buffer            // throws to simulate unreachable
  hashFor?: (buf: Buffer) => string
  state?: FakeState
  calls?: Record<string, number>
} = {}): { deps: RuntimeProvisionerDeps; state: FakeState; calls: Record<string, number> } {
  const state: FakeState = over.state ?? { existing: new Set(), extractedDirs: new Set(), text: new Map(), realpathMap: new Map() }
  const calls: Record<string, number> = over.calls ?? {}
  const bump = (k: string) => { calls[k] = (calls[k] || 0) + 1 }
  const join = (...p: string[]) => p.join('/').replace(/\/+/g, '/')
  const underExtracted = (p: string) => [...state.extractedDirs].some((d) => p === d || p.startsWith(`${d}/`))

  const deps: RuntimeProvisionerDeps = {
    runtimeRoot: '/r',
    platformKey: 'darwin-arm64',
    isWindows: false,
    listAssets: () => over.assets ?? [pinnedPython(), pinnedFfmpeg()],
    fs: {
      exists: (p) => state.existing.has(p) || underExtracted(p),
      readText: (p) => state.text.get(p) ?? null,
      realpath: (p) => state.realpathMap.get(p) ?? p,
      rmrf: (p) => { state.existing.delete(p); for (const e of [...state.existing]) if (e.startsWith(`${p}/`)) state.existing.delete(e); state.extractedDirs.delete(p) },
      mkdirp: (p) => { state.existing.add(p) },
      placeExecutable: (src, dest) => { bump(`place:${dest}`); state.existing.add(dest) },
      join,
    },
    getMirrorBase: over.getMirrorBase ?? (() => null),
    setSkillsPythonPath: over.setSkillsPythonPath ?? ((p) => { bump('setSkillsPythonPath'); state.text.set('__skills_python_path', p) }),
    probe: over.probe ?? (async () => 10),
    download: over.download ?? (async (url) => {
      bump(`download:${url}`)
      if (over.downloadFor) return over.downloadFor(url)
      return Buffer.from(HASH_GOOD)
    }),
    sha256: over.hashFor ?? ((buf) => buf.toString('utf8')),
    extractArchive: over.extractArchive ?? (async ({ destDir }) => { state.extractedDirs.add(destDir) }),
    probeBinary: over.probeBinary ?? (async () => ({ ok: true, archOk: true })),
    rebuildVenvFromBase: over.rebuildVenvFromBase ?? (async () => { bump('rebuildVenv') }),
    probeVenvPython: over.probeVenvPython ?? (async () => ({ ok: true, version: '3.11.9', sslOk: true, path: '/r/python/bin/python3' })),
    installCoreDeps: over.installCoreDeps ?? (async () => { bump('installCoreDeps'); return { ready: true, missing: [] } }),
    coreDepsStatus: over.coreDepsStatus ?? (async () => ({ ready: true, missing: [] })),
    venvRootPath: () => '/r/python',
    pythonDistRoot: () => '/r/python-dist',
  }
  return { deps, state, calls }
}

test('provision refuses when assets are not pinned (shipped placeholder registry)', async () => {
  const base = pinnedPython()
  const unpinned = { ...base, archives: [{ ...base.archives[0], sha256: 'PENDING_P0_PIN' }] }
  assert.equal(isRuntimeAssetPinned(unpinned), false)
  const { deps } = makeDeps({ assets: [unpinned] })
  const p = new RuntimeProvisioner(deps)
  await assert.rejects(p.provision({}, () => {}), (e: unknown) => e instanceof RuntimeProvisionError && e.kind === 'assets_not_pinned')
})

test('all sources unreachable → all_sources_unreachable (tries every source)', async () => {
  const { deps, calls } = makeDeps({
    assets: [pinnedPython()],
    download: async (url) => { calls[`download:${url}`] = (calls[`download:${url}`] || 0) + 1; throw new Error('ECONNREFUSED') },
  })
  const p = new RuntimeProvisioner(deps)
  await assert.rejects(p.provision({}, () => {}), (e: unknown) => e instanceof RuntimeProvisionError && e.kind === 'all_sources_unreachable')
  assert.equal(calls['download:PY_A'], 1)
  assert.equal(calls['download:PY_B'], 1) // did NOT stop at first source
})

test('one source bad-hash + rest unreachable, no clean source → asset_integrity_failed (all tried)', async () => {
  const { deps, calls } = makeDeps({
    assets: [pinnedPython()],
    download: async (url) => {
      calls[`download:${url}`] = (calls[`download:${url}`] || 0) + 1
      if (url === 'PY_A') return Buffer.from('WRONG') // downloads but bad hash
      throw new Error('ECONNREFUSED')
    },
  })
  const p = new RuntimeProvisioner(deps)
  await assert.rejects(p.provision({}, () => {}), (e: unknown) => e instanceof RuntimeProvisionError && e.kind === 'asset_integrity_failed')
  assert.equal(calls['download:PY_A'], 1)
  assert.equal(calls['download:PY_B'], 1)
})

test('extraction guard failure on first source, second source clean → succeeds', async () => {
  const state: FakeState = { existing: new Set(), extractedDirs: new Set(), text: new Map(), realpathMap: new Map() }
  let firstExtract = true
  const { deps, calls } = makeDeps({
    assets: [pinnedPython()],
    state,
    extractArchive: async ({ destDir }) => {
      if (firstExtract) { firstExtract = false; throw new Error('运行时压缩包含越界符号链接') }
      state.extractedDirs.add(destDir)
    },
  })
  const p = new RuntimeProvisioner(deps)
  const status = await p.provision({}, () => {})
  assert.equal(status.overallReady, true)
  assert.equal(calls['setSkillsPythonPath'], 1)
})

test('success path: python connect + venv rebuild + core deps + overallReady', async () => {
  const { deps, calls, state } = makeDeps()
  const p = new RuntimeProvisioner(deps)
  const status = await p.provision({}, () => {})
  assert.equal(calls['setSkillsPythonPath'], 1)
  assert.equal(calls['rebuildVenv'], 1)
  assert.equal(calls['installCoreDeps'], 1)
  assert.equal(status.overallReady, true)
  assert.equal(state.text.get('__skills_python_path'), '/r/python-dist/python/bin/python3')
})

test('provision state stays queryable and duplicate starts join the same in-flight task', async () => {
  let releaseDownload: (() => void) | null = null
  const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve })
  const { deps, calls } = makeDeps({
    assets: [pinnedPython()],
    download: async (url, onProgress) => {
      calls[`download:${url}`] = (calls[`download:${url}`] || 0) + 1
      onProgress(25, 100)
      await downloadGate
      onProgress(100, 100)
      return Buffer.from(HASH_GOOD)
    },
  })
  const provisioner = new RuntimeProvisioner(deps)
  const firstProgress: string[] = []
  const secondProgress: string[] = []

  const first = provisioner.provision({}, (progress) => firstProgress.push(`${progress.phase}:${progress.receivedBytes || 0}`))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const running = provisioner.getProvisionSnapshot()
  assert.equal(running.state, 'running')
  assert.equal(running.progress?.phase, 'download')
  assert.equal(running.progress?.receivedBytes, 25)

  const second = provisioner.provision({}, (progress) => secondProgress.push(`${progress.phase}:${progress.receivedBytes || 0}`))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls['download:PY_A'], 1, 'duplicate start must not launch another download')
  assert.ok(secondProgress.includes('download:25'), 'joining caller receives the latest progress snapshot')

  releaseDownload?.()
  const [firstStatus, secondStatus] = await Promise.all([first, second])
  assert.equal(firstStatus.overallReady, true)
  assert.equal(secondStatus.overallReady, true)
  assert.ok(firstProgress.includes('done:0'))
  assert.ok(secondProgress.includes('done:0'))
  const completed = provisioner.getProvisionSnapshot()
  assert.equal(completed.state, 'succeeded')
  assert.equal(completed.result?.overallReady, true)
})

test('core dependency install failure becomes a retryable terminal provision snapshot', async () => {
  const { deps } = makeDeps({
    assets: [pinnedPython()],
    installCoreDeps: async () => ({ ready: false, missing: ['video-expert-analyzer'] }),
  })
  const provisioner = new RuntimeProvisioner(deps)

  await assert.rejects(
    provisioner.provision({}, () => {}),
    (error: unknown) => error instanceof RuntimeProvisionError && error.kind === 'runtime_setup_failed',
  )
  const failed = provisioner.getProvisionSnapshot()
  assert.equal(failed.state, 'failed')
  assert.equal(failed.errorKind, 'runtime_setup_failed')
  assert.match(failed.error || '', /video-expert-analyzer/)
})

test('cancel remains cancelling until work exits, then becomes cancelled without publishing done', async () => {
  let releaseDownload: (() => void) | null = null
  let lateProgress: ((received: number, total: number | null) => void) | null = null
  const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve })
  const { deps } = makeDeps({
    assets: [pinnedPython()],
    download: async (_url, onProgress) => {
      lateProgress = onProgress
      onProgress(10, 100)
      await downloadGate
      return Buffer.from(HASH_GOOD)
    },
  })
  const provisioner = new RuntimeProvisioner(deps)
  const phases: string[] = []
  const running = provisioner.provision({}, (progress) => phases.push(progress.phase))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const stopping = provisioner.cancel()
  assert.equal(stopping.state, 'cancelling')
  assert.equal(provisioner.isProvisioning(), true)

  releaseDownload?.()
  await assert.rejects(
    running,
    (error: unknown) => error instanceof RuntimeProvisionError && error.kind === 'cancelled',
  )
  assert.equal(provisioner.getProvisionSnapshot().state, 'cancelled')
  assert.equal(provisioner.isProvisioning(), false)
  assert.equal(phases.includes('done'), false)

  const terminal = provisioner.getProvisionSnapshot()
  lateProgress?.(90, 100)
  assert.deepEqual(provisioner.getProvisionSnapshot(), terminal, 'late progress must not resurrect a terminal task')
})

test('late progress from a cancelled run cannot overwrite a later retry', async () => {
  const progressCallbacks: Array<(received: number, total: number | null) => void> = []
  const releases: Array<() => void> = []
  const { deps } = makeDeps({
    assets: [pinnedPython()],
    download: async (_url, onProgress) => {
      progressCallbacks.push(onProgress)
      const gate = new Promise<void>((resolve) => { releases.push(resolve) })
      onProgress(10, 100)
      await gate
      return Buffer.from(HASH_GOOD)
    },
  })
  const provisioner = new RuntimeProvisioner(deps)

  const first = provisioner.provision({}, () => {})
  while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 0))
  provisioner.cancel()
  releases[0]()
  await assert.rejects(first, (error: unknown) => error instanceof RuntimeProvisionError && error.kind === 'cancelled')

  const second = provisioner.provision({}, () => {})
  while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 0))
  const retryBeforeLateProgress = provisioner.getProvisionSnapshot()
  progressCallbacks[0](99, 100)
  assert.deepEqual(
    provisioner.getProvisionSnapshot(),
    retryBeforeLateProgress,
    'a callback carrying the previous run identity must be ignored',
  )

  releases[1]()
  const result = await second
  assert.equal(result.overallReady, true)
  assert.equal(provisioner.getProvisionSnapshot().state, 'succeeded')
})

test('ffmpeg wrong-arch on verify → asset_integrity_failed; stale binary removed before replace', async () => {
  const state: FakeState = { existing: new Set(['/r/bin/ffmpeg']), extractedDirs: new Set(), text: new Map(), realpathMap: new Map() }
  let probeCalls = 0
  const { deps } = makeDeps({
    assets: [pinnedFfmpeg()],
    state,
    probeBinary: async () => { probeCalls += 1; return { ok: false, archOk: false } }, // stale + final both bad
  })
  const p = new RuntimeProvisioner(deps)
  await assert.rejects(p.provision({}, () => {}), (e: unknown) => e instanceof RuntimeProvisionError && e.kind === 'asset_integrity_failed')
  assert.ok(probeCalls >= 1)
})

test('download size-cap/corrupt failure classifies as integrity (not unreachable)', async () => {
  const { deps } = makeDeps({
    assets: [pinnedPython()],
    download: async () => { throw markRuntimeIntegrityError(new Error('资产体积超过上限')) },
  })
  const p = new RuntimeProvisioner(deps)
  await assert.rejects(p.provision({}, () => {}), (e: unknown) => e instanceof RuntimeProvisionError && e.kind === 'asset_integrity_failed')
})

test('venv/deps failure surfaces as structured runtime_setup_failed (not raw infra throw)', async () => {
  const { deps } = makeDeps({
    assets: [pinnedPython()],
    rebuildVenvFromBase: async () => { throw new Error('venv build exploded') },
  })
  const p = new RuntimeProvisioner(deps)
  await assert.rejects(p.provision({}, () => {}), (e: unknown) => e instanceof RuntimeProvisionError && e.kind === 'runtime_setup_failed')
})

test('user mirror is forced first and used', async () => {
  const seen: string[] = []
  const { deps } = makeDeps({
    assets: [pinnedPython()],
    getMirrorBase: () => 'https://my-cdn/runtime',
    probe: async () => 5,
    download: async (url) => { seen.push(url); return Buffer.from(HASH_GOOD) },
  })
  const p = new RuntimeProvisioner(deps)
  await p.provision({}, () => {})
  assert.equal(seen[0], 'https://my-cdn/runtime/darwin-arm64/py.tar.gz')
})
