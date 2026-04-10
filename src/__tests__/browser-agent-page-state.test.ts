import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BrowserPageStateService } from '../main/modules/browser-engine/page-state-service'
import type { BrowserAgentRuntime } from '../main/modules/browser-engine/agent-runtime-adapter'

function createRuntime(): BrowserAgentRuntime {
  return {
    getActiveTab: () => ({ id: 'tab-1', url: 'https://jimeng.example.com/workspace', title: '即梦工作台', domain: 'jimeng.example.com', active: true }),
    getTabContext: async () => ({
      url: 'https://jimeng.example.com/workspace',
      title: '即梦工作台',
      heading: 'AI 创作',
      selection: '',
      excerpt: '图片生成工作区',
      capturedAt: Date.now(),
      domain: 'jimeng.example.com',
    }),
    executeJS: async (_tabId, code) => {
      const source = String(code)
      if (source.includes('__READY_PAGE_IDENTITY__')) {
        return {
          url: 'https://jimeng.example.com/workspace',
          title: '即梦工作台',
          activeElement: 'textarea:prompt',
        }
      }
      if (source.includes('__READY_UPLOAD_STATE__')) {
        return {
          complete: true,
          evidence: ['preview_visible', 'attachment_name_matched'],
          inputHasFiles: true,
          previewVisible: true,
          attachmentNameMatched: true,
          removeActionVisible: true,
        }
      }
      if (source.includes('__READY_PROMPT_STATE__')) {
        return {
          promptMatched: true,
          promptFilled: true,
          promptText: '做一张温暖的美食海报',
          generating: false,
          submitEvidence: ['prompt_matched'],
          sendButtonCount: 1,
          sendButtonDisabled: false,
          uploadChipVisible: true,
        }
      }
      if (source.includes('__READY_DOM_STATE__')) {
        return {
          inputCandidateCount: 1,
          sendCandidateCount: 1,
          uploadCandidateCount: 1,
          modalVisible: false,
          bodyStateText: '提示词 输入框 上传图片 立即生成',
        }
      }
      return null
    },
    navigate: async () => ({ success: true }),
    normalizedToCss: async () => ({ x: 100, y: 200, width: 1200, height: 900 }),
    dispatchMouse: async () => undefined,
    dispatchKey: async () => undefined,
    typeTextDirectly: async () => undefined,
    screenshotAdvanced: async () => 'base64-image',
    findUploadTargets: async () => [],
    setFileInputFiles: async () => ({ ok: true, targetDescription: 'input[type=file]', inputFound: true, filesAssigned: true, assignedFileNames: ['poster.png'] }),
    startTask: async () => ({ taskId: 'task-1', kind: 'research', status: 'running', progress: { total: 1, completed: 0, failed: 0, currentLabel: 'step-1' } }),
    getTask: async () => null,
    resumeTask: async () => null,
    cancelTask: async () => null,
    extractStructured: async () => ({ items: [], template: 'card_list' }),
    aggregateResults: () => [],
  }
}

describe('BrowserPageStateService', () => {
  it('builds a normalized browser page state snapshot', async () => {
    const service = new BrowserPageStateService(createRuntime())
    const state = await service.capturePageState({
      promptCandidate: '做一张温暖的美食海报',
      attachmentName: 'poster.png',
      targetUrl: 'https://jimeng.example.com/workspace?mode=image',
      continuity: {
        canReuseCurrentPage: true,
        source: 'remembered_workflow',
        lastStableStage: 'ensure_prompt',
        lastFailureReason: null,
      },
    })

    assert.equal(state.page.domain, 'jimeng.example.com')
    assert.equal(state.upload.complete, true)
    assert.equal(state.prompt.promptMatched, true)
    assert.equal(state.dom.inputCandidateCount, 1)
    assert.equal(state.evidence.targetMatched, true)
    assert.equal(state.evidence.uploadComplete, true)
    assert.equal(state.evidence.promptComplete, true)
    assert.equal(state.risks.modeSelection, false)
    assert.equal(state.continuity.canReuseCurrentPage, true)
    assert.equal(state.continuity.source, 'remembered_workflow')
  })
})
