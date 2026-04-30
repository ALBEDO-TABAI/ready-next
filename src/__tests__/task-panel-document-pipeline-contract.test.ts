import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

describe('task panel document pipeline diagnostics', () => {
  it('renders document pipeline chunk and cache hints from execution diagnostics', () => {
    // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: TaskPanel document-pipeline placement is a renderer source-surface contract
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/ready/TaskPanel.tsx'),
      'utf8',
    )

    assert.match(source, /const documentPipelineDiagnostics = activeRun\?\.executionDiagnostics\?\.pipeline\?\.document \|\| null/)
    assert.match(source, /文档深读/)
    assert.match(source, /documentPipelineDiagnostics\.chunkCount/)
    assert.match(source, /documentPipelineDiagnostics\.selectedChunkCount/)
    assert.match(source, /documentPipelineDiagnostics\.cacheHit/)
  })
})
