import assert from 'node:assert/strict'
import test from 'node:test'

import { envelopeHasLocalDocumentResource } from '../main/modules/agent-control/contracts/request-envelope'
import { hasLocalDocumentResource } from '../main/modules/agent-control/runtime-core/agent-sdk-execution-utils'

const envelope = {
  rawUserText: '用 @[tag-forge] 给 @[工作内容] 打标',
  pureUserText: '用 @[tag-forge] 给 @[工作内容] 打标',
  primaryInstruction: '用 @[tag-forge] 给 @[工作内容] 打标',
  chunks: [],
  resources: [{
    id: 'folder',
    kind: 'folder_reference' as const,
    source: 'folder_reference' as const,
    name: '工作内容',
    path: '/tmp/工作内容',
    text: '',
    summary: null,
    order: 0,
    canRead: true,
    canWrite: false,
  }],
  referencedResources: [],
  environmentHints: { hasDocumentContext: false, hasWidgetTargetContext: false, hasAttachments: true },
  provenanceSummary: { countsBySource: {} as never, userControllableSourcesOnly: true },
}

test('a typed folder reference is a local document resource on both capability paths', () => {
  assert.equal(envelopeHasLocalDocumentResource(envelope), true)
  assert.equal(hasLocalDocumentResource('用 @[tag-forge] 给 @[工作内容] 打标', envelope), true)
})
