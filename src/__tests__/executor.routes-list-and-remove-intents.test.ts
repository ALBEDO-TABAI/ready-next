import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import { buildPipelinePhaseOrder } from '../main/modules/agent-control/document-pipeline/document-task-pipeline'

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/document-pipeline/document-task-pipeline-executor.ts',
)

describe('executor routes list/remove structured intents (P3 T3)', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')

  it('tryExecute branches include both document_list_widgets and document_remove_widget', () => {
    const startIdx = source.indexOf('async tryExecute(params: DocumentTaskPipelineExecutionParams)')
    assert.ok(startIdx > -1, 'tryExecute not found')
    const endIdx = source.indexOf('\n  private buildDispatchResult(', startIdx)
    assert.ok(endIdx > startIdx, 'tryExecute end marker not found')
    const body = source.slice(startIdx, endIdx)
    assert.match(
      body,
      /structuredDocumentIntent === 'document_read_then_widget_create'[\s\S]*?structuredDocumentIntent === 'document_read_then_widget_update'[\s\S]*?structuredDocumentIntent === 'document_list_widgets'[\s\S]*?structuredDocumentIntent === 'document_remove_widget'/,
      'tryExecute must branch on all four structured intents before routing to runDocumentWidgetPipeline',
    )
  })

  it('both list and remove intents reach runDocumentWidgetPipeline with structuredIntent passthrough', () => {
    assert.match(
      source,
      /const pipelineResult = await this\.runDocumentWidgetPipeline\(\{\s*structuredIntent: params\.executionIntentContext\.structuredDocumentIntent,/,
    )
  })

  it('pipeline exposes listing_widgets and removing_widget as concrete phases', () => {
    const listOrder = buildPipelinePhaseOrder('document_list_widgets')
    assert.ok(
      listOrder.includes('listing_widgets'),
      'list task must surface a listing_widgets phase instead of falling through to generic tools',
    )
    const removeOrder = buildPipelinePhaseOrder('document_remove_widget')
    assert.ok(
      removeOrder.includes('removing_widget'),
      'remove task must surface a removing_widget phase',
    )
    assert.ok(
      removeOrder.includes('locating_target_widget'),
      'remove task must locate before removing (safety: never blind-delete)',
    )
  })

  it('list/remove phase orders do NOT include create/update-only phases', () => {
    const listOrder = buildPipelinePhaseOrder('document_list_widgets')
    assert.ok(!listOrder.includes('generating_widget_spec'))
    assert.ok(!listOrder.includes('writing_widget'))

    const removeOrder = buildPipelinePhaseOrder('document_remove_widget')
    assert.ok(!removeOrder.includes('generating_widget_spec'))
    assert.ok(!removeOrder.includes('writing_widget'))
    assert.ok(!removeOrder.includes('updating_widget'))
  })
})
