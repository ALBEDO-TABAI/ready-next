import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'
import {
  MODEL_PACK_DONE_MARKER,
  buildModelPackDownloadScript,
  getModelPackDescriptor,
  listModelPackDescriptors,
  probeFastestModelProvider,
  resolveExplicitModelProvider,
  resolveModelProvider,
} from '../main/modules/skills-runtime/model-pack-registry'
import { MODEL_PACK_IDS } from '../shared/model-pack-types'
import type { ModelPackDownloadStatus, ModelPackId, ModelPackStatus } from '../shared/model-pack-types'

function makeManager(): { manager: SkillsRuntimeManager; runtimeRoot: string; cleanup: () => void } {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'model-pack-manager-'))
  return {
    manager: new SkillsRuntimeManager({ runtimeRoot, startBackgroundTasks: false }),
    runtimeRoot,
    cleanup: () => rmSync(runtimeRoot, { recursive: true, force: true }),
  }
}

function writeRequiredFiles(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'model.pt'), 'weights')
  writeFileSync(join(dir, 'config.yaml'), 'cfg')
}

// ---------------------------------------------------------------------------
// Source auto-switch resolver (国内/国外 + auto) — registry pure functions.
// ---------------------------------------------------------------------------

test('registry covers every declared model pack id with required files', () => {
  assert.deepEqual(listModelPackDescriptors().map((d) => d.id).sort(), [...MODEL_PACK_IDS].sort())
  for (const id of MODEL_PACK_IDS) {
    const descriptor = getModelPackDescriptor(id)
    assert.deepEqual(descriptor.requiredFiles, ['model.pt', 'config.yaml'], id)
    assert.ok(descriptor.providers.length > 0, `${id} must declare a provider`)
  }
})

test('explicit source resolution routes HF-only and MS-only packs correctly', () => {
  const nano = getModelPackDescriptor('funasr-nano')
  const paraformer = getModelPackDescriptor('funasr-fallback-asr')

  // Nano is HF-native: domestic routes through the mirror, overseas goes direct.
  const nanoDomestic = resolveExplicitModelProvider(nano, 'domestic')
  assert.equal(nanoDomestic.provider, 'huggingface')
  assert.equal(nanoDomestic.mirrorEndpoint, 'https://hf-mirror.com')
  const nanoOverseas = resolveExplicitModelProvider(nano, 'overseas')
  assert.equal(nanoOverseas.provider, 'huggingface')
  assert.equal(nanoOverseas.mirrorEndpoint, null)

  // Paraformer is MS-native: both sources resolve to ModelScope (reachable globally).
  assert.equal(resolveExplicitModelProvider(paraformer, 'domestic').provider, 'modelscope')
  assert.equal(resolveExplicitModelProvider(paraformer, 'overseas').provider, 'modelscope')
})

test('auto source picks the fastest reachable provider and falls back when all are down', async () => {
  const nano = getModelPackDescriptor('funasr-nano')

  // Mirror endpoint is fastest -> auto resolves to the mirror route.
  const fastMirror = await resolveModelProvider(nano, 'auto', async (url) =>
    url.includes('hf-mirror') ? 10 : 500,
  )
  assert.equal(fastMirror.provider, 'huggingface')
  assert.equal(fastMirror.mirrorEndpoint, 'https://hf-mirror.com')

  // Direct HF is fastest -> auto resolves to the direct route (no mirror).
  const fastDirect = await resolveModelProvider(nano, 'auto', async (url) =>
    url.includes('hf-mirror') ? 500 : 10,
  )
  assert.equal(fastDirect.mirrorEndpoint, null)

  // Nothing reachable -> still returns a concrete provider so the download
  // attempt surfaces a real network error instead of doing nothing.
  const allDown = await probeFastestModelProvider(nano, async () => null)
  assert.equal(allDown.provider, 'huggingface')
})

test('download script is selected per provider and prints the done marker', () => {
  const ms = buildModelPackDownloadScript('modelscope', 'iic/some-model')
  assert.match(ms, /from modelscope import snapshot_download/)
  assert.match(ms, /local_dir=str\(target\)/)
  assert.match(ms, new RegExp(MODEL_PACK_DONE_MARKER))

  const hf = buildModelPackDownloadScript('huggingface', 'org/model')
  assert.match(hf, /from huggingface_hub import snapshot_download/)
  assert.match(hf, /max_workers=4/)
})

// ---------------------------------------------------------------------------
// Manager: status, close-verify, atomic install, cancel.
// ---------------------------------------------------------------------------

test('listModelPacks reports every pack unavailable under a fresh runtime root', () => {
  const { manager, runtimeRoot, cleanup } = makeManager()
  try {
    const packs = manager.listModelPacks()
    assert.deepEqual(packs.map((p) => p.id).sort(), [...MODEL_PACK_IDS].sort())
    for (const pack of packs) {
      assert.equal(pack.available, false, `${pack.id} should be unavailable initially`)
      assert.deepEqual(pack.missingFiles.sort(), ['config.yaml', 'model.pt'])
      // Downloads install under the writable runtime root, never the .app bundle.
      assert.ok(
        pack.targetDir.startsWith(join(runtimeRoot, 'models')),
        `${pack.id} target must live under runtimeRoot/models`,
      )
    }
  } finally {
    cleanup()
  }
})

test('finalizeModelPackDownload atomically installs a complete partial and rejects an incomplete one', () => {
  const { manager, cleanup } = makeManager()
  const id: ModelPackId = 'funasr-punc-ctc'
  try {
    const status = manager.getModelPackStatus(id)
    const targetDir = status.targetDir
    const partialDir = `${targetDir}.partial`
    const finalize = (manager as unknown as {
      finalizeModelPackDownload: (id: ModelPackId, code: number | null) => string | null
    }).finalizeModelPackDownload.bind(manager)

    // Non-zero exit keeps the partial for resume and reports a resumable error.
    writeRequiredFiles(partialDir)
    const nonZero = finalize(id, 1)
    assert.ok(nonZero && /退出码/.test(nonZero))
    assert.ok(existsSync(partialDir), 'partial dir must be kept for resume')
    assert.equal(existsSync(targetDir), false, 'target must not be installed on failure')

    // Clean exit but missing a required file -> rejected, not installed.
    rmSync(partialDir, { recursive: true, force: true })
    mkdirSync(partialDir, { recursive: true })
    writeFileSync(join(partialDir, 'model.pt'), 'weights') // no config.yaml
    const incomplete = finalize(id, 0)
    assert.ok(incomplete && /缺少必要文件/.test(incomplete))
    assert.equal(existsSync(targetDir), false)

    // Clean exit with all required files -> atomic rename into place.
    rmSync(partialDir, { recursive: true, force: true })
    writeRequiredFiles(partialDir)
    const ok = finalize(id, 0)
    assert.equal(ok, null)
    assert.equal(existsSync(partialDir), false, 'partial dir must be consumed by the rename')
    assert.ok(statSync(join(targetDir, 'model.pt')).isFile())
    assert.ok(statSync(join(targetDir, 'config.yaml')).isFile())
    assert.equal(manager.getModelPackStatus(id).available, true)
  } finally {
    cleanup()
  }
})

test('startModelPackDownload short-circuits when the pack is already installed', async () => {
  const { manager, cleanup } = makeManager()
  const id: ModelPackId = 'funasr-punc-ctc'
  try {
    writeRequiredFiles(manager.getModelPackStatus(id).targetDir)
    const status = await manager.startModelPackDownload({ id })
    assert.equal(status.available, true)
    assert.equal(status.download.running, false)
    assert.equal(status.download.progressPercent, 100)
    assert.equal(status.download.lastMessage, '模型已存在')
  } finally {
    cleanup()
  }
})

test('cancelModelPackDownload kills the in-flight child and keeps the partial for resume', () => {
  const { manager, cleanup } = makeManager()
  const id: ModelPackId = 'funasr-fallback-asr'
  try {
    let killed = false
    const downloads = (manager as unknown as {
      modelPackDownloads: Map<ModelPackId, { kill: () => void }>
    }).modelPackDownloads
    const statuses = (manager as unknown as {
      modelPackDownloadStatuses: Map<ModelPackId, ModelPackDownloadStatus>
    }).modelPackDownloadStatuses
    downloads.set(id, { kill: () => { killed = true } })
    statuses.set(id, {
      running: true, source: 'auto', resolvedProvider: 'modelscope',
      targetDir: manager.getModelPackStatus(id).targetDir,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: null, error: null, lastMessage: '下载中', progressPercent: 30,
    })

    const status: ModelPackStatus = manager.cancelModelPackDownload(id)
    assert.equal(killed, true, 'cancel must kill the child process')
    assert.equal(downloads.has(id), false, 'cancel must drop the in-flight handle')
    assert.equal(status.download.running, false)
    assert.match(status.download.lastMessage || '', /断点|取消/)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Env bridge: model ids always exported; absolute dirs only when installed;
// REQUIRE_LOCAL_MODELS only in packaged mode.
// ---------------------------------------------------------------------------

test('fallback model env exports ids always, dirs only when installed, gates only when packaged', () => {
  const { manager, cleanup } = makeManager()
  try {
    const buildEnv = (manager as unknown as {
      buildFunasrFallbackModelEnv: (o: { packaged: boolean }) => Record<string, string>
    }).buildFunasrFallbackModelEnv.bind(manager)

    const asrId = getModelPackDescriptor('funasr-fallback-asr').providers[0].repoId
    const puncId = getModelPackDescriptor('funasr-punc-ctc').providers[0].repoId

    // Packs absent: ids exported, no absolute dirs, no REQUIRE flag in dev mode.
    const dev = buildEnv({ packaged: false })
    assert.equal(dev.READY_FUNASR_ASR_MODEL_ID, asrId)
    assert.equal(dev.READY_FUNASR_PUNC_MODEL_ID, puncId)
    assert.equal(dev.READY_FUNASR_ASR_MODEL_DIR, undefined)
    assert.equal(dev.READY_FUNASR_PUNC_MODEL_DIR, undefined)
    assert.equal(dev.READY_FUNASR_REQUIRE_LOCAL_MODELS, undefined)

    // Packaged mode gates offline behavior even with packs absent.
    const packagedMissing = buildEnv({ packaged: true })
    assert.equal(packagedMissing.READY_FUNASR_REQUIRE_LOCAL_MODELS, '1')
    assert.equal(packagedMissing.READY_FUNASR_PUNC_MODEL_DIR, undefined)

    // Install the punc pack -> its absolute dir is now injected.
    const puncDir = manager.getModelPackStatus('funasr-punc-ctc').targetDir
    writeRequiredFiles(puncDir)
    const packagedInstalled = buildEnv({ packaged: true })
    assert.equal(packagedInstalled.READY_FUNASR_PUNC_MODEL_DIR, puncDir)
    assert.equal(packagedInstalled.READY_FUNASR_ASR_MODEL_DIR, undefined, 'asr still absent')
  } finally {
    cleanup()
  }
})

test('getBaseEnv (dev path) merges the fallback model ids without the offline gate', () => {
  const { manager, cleanup } = makeManager()
  try {
    const env = (manager as unknown as {
      getBaseEnv: (o?: { allowPackaged?: boolean }) => NodeJS.ProcessEnv
    }).getBaseEnv.bind(manager)()
    assert.equal(env.READY_FUNASR_ASR_MODEL_ID, getModelPackDescriptor('funasr-fallback-asr').providers[0].repoId)
    assert.equal(env.READY_FUNASR_PUNC_MODEL_ID, getModelPackDescriptor('funasr-punc-ctc').providers[0].repoId)
    assert.equal(env.READY_FUNASR_NANO_MODEL_ID, getModelPackDescriptor('funasr-nano').providers[0].repoId)
    // No packaged runtime root in tests -> dev path -> no offline gate.
    assert.equal(env.READY_FUNASR_REQUIRE_LOCAL_MODELS, undefined)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Download self-test: per pack × per source reachability + coordinate
// resolution + integrity, network-free via an injected probe.
// ---------------------------------------------------------------------------

test('selfTestModelPacks probes each source, dedupes endpoints, and verifies integrity', async () => {
  const { manager, cleanup } = makeManager()
  try {
    const probed: string[] = []
    // ModelScope + the HF mirror are reachable; direct HF is down.
    const probe = async (url: string): Promise<number | null> => {
      probed.push(url)
      if (url.includes('modelscope.cn')) return 12
      if (url.includes('hf-mirror.com')) return 34
      return null
    }

    const report = await manager.selfTestModelPacks(probe)

    assert.deepEqual(report.entries.map((e) => e.id).sort(), [...MODEL_PACK_IDS].sort())

    // Distinct endpoints (modelscope.cn, hf-mirror.com, huggingface.co) are each
    // probed once even though six source rows resolve across them.
    assert.deepEqual([...new Set(probed)].sort(), probed.sort())
    assert.equal(probed.length, 3)

    const nano = report.entries.find((e) => e.id === 'funasr-nano')
    assert.ok(nano)
    const nanoDomestic = nano.probes.find((p) => p.source === 'domestic')
    const nanoOverseas = nano.probes.find((p) => p.source === 'overseas')
    // Domestic Nano routes through the reachable mirror; overseas direct HF is down.
    assert.match(nanoDomestic!.endpoint, /hf-mirror\.com/)
    assert.equal(nanoDomestic!.reachable, true)
    assert.equal(nanoDomestic!.latencyMs, 34)
    assert.equal(nanoDomestic!.coordinatesOk, true)
    assert.match(nanoOverseas!.endpoint, /huggingface\.co/)
    assert.equal(nanoOverseas!.reachable, false)
    assert.equal(nanoOverseas!.latencyMs, null)
    assert.equal(nano.anyReachable, true)

    // Paraformer is ModelScope-native: both sources hit the reachable MS endpoint.
    const paraformer = report.entries.find((e) => e.id === 'funasr-fallback-asr')
    assert.ok(paraformer)
    for (const p of paraformer.probes) {
      assert.equal(p.provider, 'modelscope')
      assert.match(p.endpoint, /modelscope\.cn/)
      assert.equal(p.reachable, true)
      assert.equal(p.coordinatesOk, true)
    }

    // The scratch integrity/atomic-install path passes for every pack.
    for (const entry of report.entries) {
      assert.equal(entry.integrityOk, true, `${entry.id} integrity must pass`)
    }
  } finally {
    cleanup()
  }
})

test('selfTestModelPacks integrity check never touches real packs or leaks scratch dirs', async () => {
  const { manager, runtimeRoot, cleanup } = makeManager()
  try {
    // Pre-install a real pack; the self-test must leave it intact.
    const puncDir = manager.getModelPackStatus('funasr-punc-ctc').targetDir
    writeRequiredFiles(puncDir)
    assert.equal(manager.getModelPackStatus('funasr-punc-ctc').available, true)

    await manager.selfTestModelPacks(async () => 5)

    assert.equal(manager.getModelPackStatus('funasr-punc-ctc').available, true, 'installed pack must survive')
    // No scratch dirs left behind under models/.
    const modelsDir = join(runtimeRoot, 'models')
    const leaked = existsSync(modelsDir)
      ? readdirSync(modelsDir).filter((name) => name.startsWith('.selftest-'))
      : []
    assert.deepEqual(leaked, [], 'self-test scratch dirs must be cleaned up')
  } finally {
    cleanup()
  }
})
