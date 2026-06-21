import assert from 'node:assert/strict'
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
