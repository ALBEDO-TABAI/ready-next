export type BrowserTaskDecisionMode = 'free_tool_loop' | 'browser_workflow' | 'browser_upload_workflow' | 'clarify_first'

export type BrowserWorkflowStage =
  | 'resolve_target_page'
  | 'resolve_attachment'
  | 'navigate_target'
  | 'ensure_upload'
  | 'ensure_prompt'
  | 'submit'
  | 'final_reconcile'
  | 'recover'

export interface BrowserTaskAttachmentResource {
  attachmentId: string
  name: string
  type: string
  mimeType?: string
  path?: string
  createdAt?: string
}

export interface BrowserTaskLinkResource {
  url: string
  order: number
  source: 'markdown' | 'raw'
}

export interface BrowserPlanStep {
  id: BrowserWorkflowStage
  goal: string
  action: string
  verify: string[]
  skipIf: string[]
  failIf: string[]
  retryLimit: number
  recoverWith: string[]
}

export interface BrowserTaskPlanContinuity {
  canReuseCurrentPage: boolean
  reuseReason: string
  activePage?: {
    url: string
    title: string
    heading: string
    selection: string
    excerpt: string
    capturedAt: number
    domain: string
  }
  rememberedWorkflow?: {
    workflowKind: string
    stage: string
    url: string
    title?: string
    domain?: string
    uploadMounted?: boolean
    promptFilled?: boolean
    running?: boolean
  } | null
  recentSkill?: {
    toolName: string
    action: string
    success: boolean
    summary: string
  } | null
  recentActions: Array<{
    kind: string
    value: string
    normalizedValue: string
    updatedAt: number
  }>
  forcedRules: string[]
}

export interface BrowserTaskPlan {
  taskKind: 'upload_generate' | 'upload_edit' | 'pure_web_action' | 'multi_page_sequence' | 'clarify'
  taskGoal: string
  expectedOutcome: string
  resources: {
    attachments: BrowserTaskAttachmentResource[]
    links: BrowserTaskLinkResource[]
  }
  attachmentIntent: {
    mode: 'latest' | 'specific' | 'none'
    attachmentId?: string
    latestName?: string
  }
  targetUrl?: string
  targetSiteHint?: string
  targetSearchQuery?: string
  promptIntent: {
    raw: string
    refined: string
    confidence: 'high' | 'medium' | 'low'
    mustUse?: string
    source?: string
  }
  continuity?: BrowserTaskPlanContinuity
  steps: BrowserPlanStep[]
  requiredStages: BrowserWorkflowStage[]
  completionCriteria: string[]
  skipRules: string[]
  successCriteria: string[]
  failureCriteria?: string[]
  retryPolicy?: string
  finalCheck?: {
    expectedOutcome: string
    successCriteria: string[]
  }
}

export interface BrowserTaskDecision {
  mode: BrowserTaskDecisionMode
  reason: string
  attachmentSelection?: {
    count: number
    latestName?: string
  }
  promptIntent?: {
    raw: string
    refined: string
    confidence: 'high' | 'medium' | 'low'
    source: 'quoted' | 'keyword' | 'descriptive_clause' | 'model_refiner' | 'none'
    mustUse?: string
  }
  plan?: BrowserTaskPlan
}

export interface BrowserActionTarget {
  kind?: string
  label?: string
  selectorHint?: string
  x?: number
  y?: number
  confidence?: number
  evidence?: string[]
  focused?: boolean
  textLength?: number
  valuePreview?: string
  nearActiveInput?: boolean
  distanceToActiveInput?: number
}

export interface BrowserPageState {
  page: {
    url: string
    title: string
    domain: string
    activeElement: string
  }
  promptCandidate: string
  attachmentName?: string
  upload: {
    complete: boolean
    evidence: string[]
    inputHasFiles: boolean
    previewVisible: boolean
    attachmentNameMatched: boolean
    removeActionVisible: boolean
  }
  prompt: {
    promptMatched: boolean
    promptFilled: boolean
    promptText: string
    generating: boolean
    submitEvidence: string[]
    sendButtonCount: number
    sendButtonDisabled: boolean
    uploadChipVisible: boolean
  }
  dom: {
    inputCandidateCount: number
    sendCandidateCount: number
    uploadCandidateCount: number
    modalVisible: boolean
    bodyStateText: string
  }
  candidates: {
    uploadTargets: BrowserActionTarget[]
    inputTargets: BrowserActionTarget[]
    activeInputTarget: BrowserActionTarget | null
    nearbySendTargets: BrowserActionTarget[]
    sendTargets: BrowserActionTarget[]
  }
}

export interface BrowserTaskProjectionPayload {
  module: 'browser'
  taskTitle: string
  taskSummary: string
  steps: Array<{
    id: string
    title: string
    status: 'pending' | 'running' | 'blocked' | 'done' | 'error'
    detail?: string | null
    updatedAt: string
  }>
  currentStepId: string | null
  waitingFor: 'none' | 'input' | 'confirmation' | 'agent_result' | 'background'
  resumableActions: Array<'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none'>
  recentArtifacts: Array<{
    id: string
    module: 'browser'
    kind: string
    label: string
    path?: string | null
    url?: string | null
    createdAt: string
  }>
  message: string
}
