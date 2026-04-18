import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildPipelinePhaseOrder } from '../main/modules/agent-control/document-task-pipeline'

describe('buildPipelinePhaseOrder matches task type (P3 T4)', () => {
  it('create task: 5-phase insert path', () => {
    assert.deepStrictEqual(
      buildPipelinePhaseOrder('document_read_then_widget_create'),
      ['loading_document', 'building_insight', 'generating_widget_spec', 'writing_widget', 'saving_document'],
    )
  })

  it('update task: splits write into locate + update, 6 phases', () => {
    assert.deepStrictEqual(
      buildPipelinePhaseOrder('document_read_then_widget_update'),
      [
        'loading_document',
        'building_insight',
        'generating_widget_spec',
        'locating_target_widget',
        'updating_widget',
        'saving_document',
      ],
    )
  })

  it('list task: 2-phase minimal path (no insight, no save)', () => {
    assert.deepStrictEqual(
      buildPipelinePhaseOrder('document_list_widgets'),
      ['loading_document', 'listing_widgets'],
    )
  })

  it('remove task: 4-phase locate-then-remove path ending with save', () => {
    assert.deepStrictEqual(
      buildPipelinePhaseOrder('document_remove_widget'),
      ['loading_document', 'locating_target_widget', 'removing_widget', 'saving_document'],
    )
  })

  it('every task type starts with loading_document', () => {
    const types = [
      'document_read_then_widget_create',
      'document_read_then_widget_update',
      'document_list_widgets',
      'document_remove_widget',
    ] as const
    for (const type of types) {
      assert.equal(
        buildPipelinePhaseOrder(type)[0],
        'loading_document',
        `${type} must start by loading the document before any widget work`,
      )
    }
  })
})
