import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

// Mirrors document-task-pipeline-host-contract.test.ts: the executor pulls
// `electron` via document-engine/ipc-handler so we assert routing by
// static-source inspection. A future extraction of electron-free helpers can
// upgrade these to runtime assertions.

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/document-engine/pipeline/document-task-pipeline-executor.ts',
)

describe('document task pipeline executor · list/remove routing contract', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- document-task-pipeline-executor.ts transitively imports `electron` via ../ipc-handler; all five assertions in this file are structural routing contracts with no electron-free seam (mirrors W1.1 ledger for this executor).
  const executor = readFileSync(EXECUTOR_PATH, 'utf8')

  it('routes document_list_widgets intent into the widget pipeline', () => {
    assert.match(executor, /structuredDocumentIntent === 'document_list_widgets'/)
  })

  it('routes document_remove_widget intent into the widget pipeline', () => {
    assert.match(executor, /structuredDocumentIntent === 'document_remove_widget'/)
  })

  it('injects a listWidgets dep that bridges to document.listWidgets IPC', () => {
    assert.match(executor, /listWidgets:\s*async[\s\S]*?document\.listWidgets/)
  })

  it('injects a removeWidget dep that guards the locate stage from deleting', () => {
    assert.match(executor, /removeWidget:\s*async[\s\S]*?stage === 'locate'[\s\S]*?document\.removeWidget/)
  })

  it('derives pipelinePhaseOrder from buildPipelinePhaseOrder(structuredIntent)', () => {
    assert.match(executor, /buildPipelinePhaseOrder\(params\.structuredIntent\)/)
  })
})
