import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createToolExecutionOutput,
  serializeToolExecutionOutput,
} from '../main/modules/agent-control/tools-runtime/tool-result-types'
import {
  buildModelVisibleToolResultPayload,
  serializeToolExecutionOutputForModel,
} from '../main/modules/agent-control/tools-runtime/model-visible-tool-output'
import { executeReadArtifact } from '../main/modules/tools/skill-primitives/read-artifact'
import { executeWriteArtifact } from '../main/modules/tools/skill-primitives/write-artifact'
import { executeInspectRunState } from '../main/modules/tools/skill-primitives/inspect-run-state'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'

function makeSkillPrimitiveFixture(prefix: string) {
  const artifactRoot = realpathSync.native(mkdtempSync(join(tmpdir(), `${prefix}-artifact-`)))
  const assetRoot = realpathSync.native(mkdtempSync(join(tmpdir(), `${prefix}-asset-`)))
  const lookup = (id: string): SkillRootSet | null =>
    id === 'test-skill' ? { skillId: 'test-skill', assetRoot, artifactRoot } : null
  return {
    artifactRoot,
    assetRoot,
    lookup,
    cleanup: () => {
      rmSync(artifactRoot, { recursive: true, force: true })
      rmSync(assetRoot, { recursive: true, force: true })
    },
  }
}

function assertModelCopyOmitsRawPath(modelText: string, rawPath: string) {
  assert.ok(rawPath.length > 0, 'test fixture must provide a raw path')
  assert.equal(
    modelText.includes(rawPath),
    false,
    `model-visible copy must not include raw path ${rawPath}`,
  )
}

test('serializeToolExecutionOutput sends tool text to the model even when a projection patch exists', () => {
  const output = createToolExecutionOutput('exitCode=0\nSTDOUT:\nreport ready', {
    projectionPatch: {
      module: 'skill',
      taskSummary: '执行技能脚本',
    },
  })

  assert.equal(
    serializeToolExecutionOutput(output),
    'exitCode=0\nSTDOUT:\nreport ready',
  )
})

test('model-visible JSON results keep one copy when text and data are equivalent', () => {
  const data = {
    ok: true,
    pageMap: { text: '- row "ivory signal": READY-123' },
  }
  const output = createToolExecutionOutput(JSON.stringify(data, null, 2), {
    shape: 'json',
    data,
  })

  assert.deepEqual(buildModelVisibleToolResultPayload(output), { data })
})

test('model-visible JSON results preserve distinct explanatory text', () => {
  const data = { ok: true, count: 1 }
  const output = createToolExecutionOutput('Found one result.', {
    shape: 'json',
    data,
  })

  assert.deepEqual(buildModelVisibleToolResultPayload(output), {
    text: 'Found one result.',
    data,
  })
})

test('serializeToolExecutionOutput falls back to projection JSON only when there is no tool text', () => {
  const output = createToolExecutionOutput('', {
    projectionPatch: {
      module: 'skill',
      taskSummary: '执行技能脚本',
    },
  })

  assert.equal(
    serializeToolExecutionOutput(output),
    JSON.stringify({ module: 'skill', taskSummary: '执行技能脚本' }),
  )
})

test('serializeToolExecutionOutputForModel redacts host paths without mutating raw handles', () => {
  const output = createToolExecutionOutput('Wrote to /Users/alice/Ready/out.txt', {
    shape: 'json',
    data: {
      absolutePath: '/Users/alice/Ready/out.txt',
      linuxPath: '/home/bob/ready/out.txt',
      windowsPath: 'C:\\Users\\carol\\Ready\\out.txt',
      escapedWindowsPath: 'C:\\\\Users\\\\dana\\\\Ready\\\\out.txt',
      profilePath: '%USERPROFILE%\\Ready\\out.txt',
    },
    projectionPatch: {
      taskContinuation: {
        runStatePath: '/Users/alice/Ready/run_state.json',
      },
    },
    framePatch: {
      activeArtifactRoots: ['/Users/alice/Ready'],
      runContract: {
        outputDir: '/Users/alice/Ready',
        runStatePath: '/Users/alice/Ready/run_state.json',
      },
    },
    contextModifier: {
      activeFrame: {
        activeArtifactRoots: ['/Users/alice/Ready'],
      },
    },
  })

  const payload = buildModelVisibleToolResultPayload(output)
  const modelText = JSON.stringify(payload)

  assert.doesNotMatch(modelText, /\/Users\/alice/)
  assert.doesNotMatch(modelText, /\/home\/bob/)
  assert.doesNotMatch(modelText, /C:\\Users\\carol/)
  assert.doesNotMatch(modelText, /C:\\\\Users\\\\dana/)
  assert.doesNotMatch(modelText, /%USERPROFILE%/)
  assert.match(modelText, /\/Users\/<redacted>\/Ready/)
  assert.match(modelText, /\/home\/<redacted>\/ready/)
  assert.match(modelText, /C:\\\\Users\\\\<redacted>\\\\Ready/)
  assert.match(modelText, /<userprofile>\\\\Ready/)

  assert.equal((output.data as { absolutePath: string }).absolutePath, '/Users/alice/Ready/out.txt')
  assert.deepEqual(output.framePatch?.activeArtifactRoots, ['/Users/alice/Ready'])
  assert.deepEqual(output.contextModifier?.activeFrame?.activeArtifactRoots, ['/Users/alice/Ready'])
})

test('serializeToolExecutionOutputForModel redacts fallback projection JSON', () => {
  const output = createToolExecutionOutput('', {
    projectionPatch: {
      taskContinuation: {
        runStatePath: '/Users/alice/Ready/run_state.json',
      },
    },
  })

  const modelText = serializeToolExecutionOutputForModel(output)

  assert.doesNotMatch(modelText, /\/Users\/alice/)
  assert.match(modelText, /\/Users\/<redacted>\/Ready\/run_state\.json/)
  assert.equal(
    ((output.projectionPatch as { taskContinuation: { runStatePath: string } }).taskContinuation.runStatePath),
    '/Users/alice/Ready/run_state.json',
  )
})

test('serializeToolExecutionOutputForModel redacts tmp-root paths without mutating raw handles', () => {
  const outputDir = join(tmpdir(), 'ready-skill-model-visible-output')
  const runStatePath = join(outputDir, 'run_state.json')
  const output = createToolExecutionOutput(`Inspected run_state at ${runStatePath}.`, {
    shape: 'json',
    data: {
      outputDir,
      runStatePath,
    },
    framePatch: {
      activeArtifactRoots: [outputDir],
      runContract: {
        outputDir,
        runStatePath,
      },
    },
  })

  const payload = buildModelVisibleToolResultPayload(output)
  const modelText = JSON.stringify(payload)

  assert.equal(modelText.includes(tmpdir()), false)
  assert.match(modelText, /<tmp>/)
  assert.equal((output.data as { outputDir: string }).outputDir, outputDir)
  assert.deepEqual(output.framePatch?.activeArtifactRoots, [outputDir])
  assert.equal(output.framePatch?.runContract?.runStatePath, runStatePath)
})

test('model-visible payload redacts real write/read artifact primitive paths without mutating raw handles', async () => {
  const fx = makeSkillPrimitiveFixture('model-visible-primitive')
  try {
    const written = await executeWriteArtifact(
      { relativePath: 'output/result.txt', content: 'hello model' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    const writtenPath = (written.data as { absolutePath: string }).absolutePath
    const writeModelText = JSON.stringify(buildModelVisibleToolResultPayload(written))

    assertModelCopyOmitsRawPath(writeModelText, writtenPath)
    assertModelCopyOmitsRawPath(writeModelText, fx.artifactRoot)
    assert.equal((written.data as { absolutePath: string }).absolutePath, writtenPath)
    assert.equal((written.data as { artifactRoot: string }).artifactRoot, fx.artifactRoot)

    const read = await executeReadArtifact(
      { relativePath: 'output/result.txt' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    const readPath = (read.data as { absolutePath: string }).absolutePath
    const readModelText = JSON.stringify(buildModelVisibleToolResultPayload(read))

    assertModelCopyOmitsRawPath(readModelText, readPath)
    assert.equal((read.data as { absolutePath: string }).absolutePath, readPath)
    assert.equal(read.text, 'hello model')
  } finally {
    fx.cleanup()
  }
})

test('model-visible payload redacts real inspect_run_state primitive paths while keeping contextModifier internal', async () => {
  const outputDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'model-visible-inspect-')))
  try {
    const runStatePath = join(outputDir, 'run_state.json')
    writeFileSync(runStatePath, JSON.stringify({
      taskId: 'task-model-visible',
      currentStage: 'score_batches',
      totalScenes: 3,
      completedScenes: 1,
      status: 'recoverable_paused',
    }), 'utf8')

    const result = await executeInspectRunState({
      outputDir,
      runStatePath,
      skillId: 'video-expert-analyzer',
    })
    const payload = buildModelVisibleToolResultPayload(result)
    const modelText = JSON.stringify(payload)

    assertModelCopyOmitsRawPath(modelText, outputDir)
    assertModelCopyOmitsRawPath(modelText, runStatePath)
    assert.equal((result.data as { outputDir: string }).outputDir, outputDir)
    assert.equal((result.data as { runStatePath: string }).runStatePath, runStatePath)
    assert.deepEqual(result.framePatch?.activeArtifactRoots, [outputDir])
    assert.equal(result.framePatch?.runContract?.outputDir, outputDir)
    assert.equal(result.framePatch?.runContract?.runStatePath, runStatePath)
    assert.deepEqual(result.contextModifier?.activeFrame?.activeArtifactRoots, [outputDir])
    assert.equal(result.contextModifier?.activeFrame?.runContract?.outputDir, outputDir)
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'contextModifier'), false)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('serializeToolExecutionOutputForModel redacts resourcesPath plain and JSON-escaped roots without mutating raw handles', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  const resourcesPath = 'C:\\Program Files\\Ready\\resources'
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath,
  })
  try {
    const escapedResourcesPath = resourcesPath.replace(/\\/g, '\\\\')
    const plainAssetPath = `${resourcesPath}\\app.asar`
    const escapedAssetPath = `${escapedResourcesPath}\\\\app.asar`
    const output = createToolExecutionOutput(`Assets: ${plainAssetPath} ${escapedAssetPath}`, {
      shape: 'json',
      data: {
        plainAssetPath,
        escapedAssetPath,
      },
    })

    const payload = buildModelVisibleToolResultPayload(output)
    const modelText = JSON.stringify(payload)

    assert.equal(modelText.includes(resourcesPath), false)
    assert.equal(modelText.includes(escapedResourcesPath), false)
    assert.match(modelText, /<app>/)
    assert.equal((output.data as { plainAssetPath: string }).plainAssetPath, plainAssetPath)
    assert.equal((output.data as { escapedAssetPath: string }).escapedAssetPath, escapedAssetPath)
  } finally {
    if (descriptor) {
      Object.defineProperty(process, 'resourcesPath', descriptor)
    } else {
      Reflect.deleteProperty(process, 'resourcesPath')
    }
  }
})
