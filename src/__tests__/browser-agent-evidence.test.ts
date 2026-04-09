import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BrowserEvidenceService } from '../main/modules/browser-engine/evidence-service'
import type { BrowserPageState } from '../shared/browser-agent-task'

function createState(overrides?: Partial<BrowserPageState>): BrowserPageState {
  return {
    page: {
      url: 'https://jimeng.example.com/workspace',
      title: '即梦工作台',
      domain: 'jimeng.example.com',
      activeElement: 'textarea:prompt',
    },
    promptCandidate: '做一张温暖的美食海报',
    attachmentName: 'poster.png',
    upload: {
      complete: false,
      evidence: [],
      inputHasFiles: false,
      previewVisible: false,
      attachmentNameMatched: false,
      removeActionVisible: false,
    },
    prompt: {
      promptMatched: false,
      promptFilled: false,
      promptText: '',
      generating: false,
      submitEvidence: [],
      sendButtonCount: 0,
      sendButtonDisabled: false,
      uploadChipVisible: false,
    },
    dom: {
      inputCandidateCount: 0,
      sendCandidateCount: 0,
      uploadCandidateCount: 0,
      modalVisible: false,
      bodyStateText: '',
    },
    candidates: {
      uploadTargets: [],
      inputTargets: [],
      activeInputTarget: null,
      nearbySendTargets: [],
      sendTargets: [],
    },
    ...overrides,
  }
}

describe('BrowserEvidenceService', () => {
  it('recognizes target page matches by same domain and path', () => {
    const service = new BrowserEvidenceService()
    const state = createState()

    assert.equal(service.isTargetPageMatched(state, 'https://jimeng.example.com/workspace'), true)
    assert.equal(service.isTargetPageMatched(state, 'https://jimeng.example.com/workspace?mode=image'), true)
    assert.equal(service.isTargetPageMatched(state, 'https://other.example.com/workspace'), false)
  })

  it('requires page-level upload evidence before considering upload complete', () => {
    const service = new BrowserEvidenceService()
    const incomplete = createState({
      upload: {
        complete: false,
        evidence: ['input_has_files'],
        inputHasFiles: true,
        previewVisible: false,
        attachmentNameMatched: false,
        removeActionVisible: false,
      },
    })
    const complete = createState({
      upload: {
        complete: true,
        evidence: ['preview_visible', 'attachment_name_matched'],
        inputHasFiles: true,
        previewVisible: true,
        attachmentNameMatched: true,
        removeActionVisible: true,
      },
    })

    assert.equal(service.isUploadComplete(incomplete), false)
    assert.equal(service.isUploadComplete(complete), true)
  })

  it('requires prompt match or filled confirmation before considering prompt complete', () => {
    const service = new BrowserEvidenceService()
    const incomplete = createState({
      prompt: {
        promptMatched: false,
        promptFilled: false,
        promptText: '',
        generating: false,
        submitEvidence: [],
        sendButtonCount: 1,
        sendButtonDisabled: false,
        uploadChipVisible: false,
      },
    })
    const complete = createState({
      prompt: {
        promptMatched: true,
        promptFilled: true,
        promptText: '做一张温暖的美食海报',
        generating: false,
        submitEvidence: [],
        sendButtonCount: 1,
        sendButtonDisabled: false,
        uploadChipVisible: true,
      },
    })

    assert.equal(service.isPromptComplete(incomplete, '做一张温暖的美食海报'), false)
    assert.equal(service.isPromptComplete(complete, '做一张温暖的美食海报'), true)
  })

  it('detects running state from generating flag or submit evidence', () => {
    const service = new BrowserEvidenceService()
    const generating = createState({
      prompt: {
        promptMatched: true,
        promptFilled: true,
        promptText: '做一张温暖的美食海报',
        generating: true,
        submitEvidence: [],
        sendButtonCount: 1,
        sendButtonDisabled: true,
        uploadChipVisible: true,
      },
    })
    const evidenceDriven = createState({
      prompt: {
        promptMatched: true,
        promptFilled: true,
        promptText: '做一张温暖的美食海报',
        generating: false,
        submitEvidence: ['running_state'],
        sendButtonCount: 1,
        sendButtonDisabled: true,
        uploadChipVisible: true,
      },
    })

    assert.equal(service.isRunningState(generating), true)
    assert.equal(service.isRunningState(evidenceDriven), true)
  })

  it('detects ambiguous creative mode selection pages', () => {
    const service = new BrowserEvidenceService()
    const modeSelection = createState({
      dom: {
        inputCandidateCount: 0,
        sendCandidateCount: 2,
        uploadCandidateCount: 0,
        modalVisible: false,
        bodyStateText: 'AI 创作 图片生成 视频生成 立即开始 选择模式',
      },
    })
    const normalWorkspace = createState({
      dom: {
        inputCandidateCount: 1,
        sendCandidateCount: 1,
        uploadCandidateCount: 1,
        modalVisible: false,
        bodyStateText: '提示词 输入框 立即生成 上传图片',
      },
    })

    assert.equal(service.looksLikeModeSelectionPage(modeSelection), true)
    assert.equal(service.looksLikeModeSelectionPage(normalWorkspace), false)
  })
})
