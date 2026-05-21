import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildPipelinePhaseOrder } from '../main/modules/agent-control/document-pipeline/document-task-pipeline'

describe('buildPipelinePhaseOrder', () => {
  it('keeps the 5-phase path for create', () => {
    assert.deepEqual(buildPipelinePhaseOrder('document_read_then_widget_create'), [
      'loading_document',
      'building_insight',
      'generating_widget_spec',
      'writing_widget',
      'saving_document',
    ])
  })

  it('inserts locating/updating phases for update', () => {
    assert.deepEqual(buildPipelinePhaseOrder('document_read_then_widget_update'), [
      'loading_document',
      'building_insight',
      'generating_widget_spec',
      'locating_target_widget',
      'updating_widget',
      'saving_document',
    ])
  })

  it('returns a 2-step path for list', () => {
    assert.deepEqual(buildPipelinePhaseOrder('document_list_widgets'), [
      'loading_document',
      'listing_widgets',
    ])
  })

  it('threads locate → remove → save for remove', () => {
    assert.deepEqual(buildPipelinePhaseOrder('document_remove_widget'), [
      'loading_document',
      'locating_target_widget',
      'removing_widget',
      'saving_document',
    ])
  })
})
