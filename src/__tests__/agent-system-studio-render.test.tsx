import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { AgentSystemStudioSnapshot } from '../shared/agent-system-studio'
import type { SpecialistAgentBlueprint } from '../shared/agent-specialist-blueprint'

function blueprint(overrides: Partial<SpecialistAgentBlueprint> = {}): SpecialistAgentBlueprint {
  return {
    blueprintId: 'bp-visual-researcher',
    status: 'staged',
    inferredScope: {
      slug: 'visual-researcher',
      displayName: '视觉研究专项 Agent',
      domain: '视觉研究',
      routingTriggers: ['视觉研究'],
    },
    foundationDocs: {
      status: 'staged',
      charter: '负责视觉参考研究。',
      rulesText: '# 视觉研究专项 Agent\n- 保留引用来源。',
      knowledgeSeeds: [{ title: '来源要求', body: '保留引用。', evidenceRefs: ['user:0'] }],
      toolSafetyNotes: '外发前确认。',
      foundationText: '# 视觉研究专项 Agent Foundation',
    },
    provenance: {
      userRequestVerbatim: '我要一个视觉研究类型的专项 agent',
      sourceSessionId: 'session-1',
      sourceRunId: null,
      sourceMessageId: 'message-1',
      createdAt: '2026-06-19T00:00:00.000Z',
    },
    confirmation: {
      tokenId: null,
      confirmedAt: null,
      usedAt: null,
    },
    rolePersona: '以视觉研究员的姿态工作，先界定风格问题，再整理证据和判断边界。',
    taskExamples: {
      suitable: ['整理一组参考图并提炼风格方向'],
      unsuitable: ['直接代表用户发布内容或外发文件'],
    },
    mainVsSpecialistSplit: '主 agent 负责理解用户目标和最终取舍，视觉研究专项 agent 负责重复性的参考整理与风格判断。',
    toolBoundaries: {
      browser: { mode: 'confirm', notes: '需要浏览网页采集参考时先说明目标和来源范围。' },
      write: { mode: 'confirm', notes: '写入文件或长期资产前必须确认路径、内容和用途。' },
      externalSend: { mode: 'deny', notes: '不代表用户外发消息、上传文件或联系第三方。' },
      longMemory: { mode: 'confirm', notes: '长期记忆只记录用户确认过的稳定偏好、规则和证据。' },
    },
    memoryProfilePolicy: '只使用当前任务资料和用户确认的长期偏好，不把临时猜测写入用户画像。',
    lifecycleNotes: '当触发词失效、职责重叠或长期不用时，需要用户确认后更新、合并或退休。',
    specialistId: 'visual-researcher',
    displayName: '视觉研究专项 Agent',
    charter: '负责视觉参考研究。',
    intendedDomain: '视觉研究',
    nonGoals: ['不外发文件', '不替代主 agent 做最终创意决策'],
    recurringTasks: ['整理参考资料', '沉淀视觉规则'],
    requiredInputs: ['用户目标', '参考链接或附件'],
    expectedOutputs: ['研究结论', '可复用知识卡草稿'],
    routingTriggers: ['视觉研究'],
    routingActivateOnCreate: false,
    seedRulesText: '# 视觉研究专项 Agent\n- 保留引用来源。',
    knowledgeSeeds: [{ title: '来源要求', body: '保留引用。', evidenceRefs: ['user:0'] }],
    migrationCandidates: [],
    toolSafetyNotes: '外发、下载、写文件和长期记忆更新都必须等待用户确认。',
    source: 'conversation',
    userRequestVerbatim: '我要一个视觉研究类型的专项 agent',
    clarificationAnswers: [],
    admissionVerdict: { kind: 'admit' },
    qualityChecks: [{ check: 'has_non_goals', pass: true }],
    semanticReview: {
      status: 'passed',
      contentHash: 'hash-visual-researcher',
      reviewedAt: '2026-06-19T00:01:00.000Z',
      issues: [],
      source: 'semantic_judge',
    },
    ...overrides,
  }
}

function snapshot(): AgentSystemStudioSnapshot {
  return {
    generatedAt: '2026-06-19T00:00:00.000Z',
    agents: [
      {
        id: 'butler',
        name: '主 agent',
        charter: '总协调',
        status: 'active',
        kind: 'main',
        parentAgentId: null,
        derivationReason: null,
        mergedIntoAgentId: null,
        createdAt: '2026-06-19T00:00:00.000Z',
        rules: { relPath: 'agents/butler/RULES.md', exists: false, preview: null, content: null, contentHash: null },
        foundation: { relPath: 'agents/butler/FOUNDATION.md', exists: false, preview: null, content: null, contentHash: null },
        knowledgeCards: [],
        routingCards: [],
        ownedTasks: [],
        contentSummary: { knowledgeCards: 0, routingCards: 0, ownedTasks: 0, stagedContentEdits: 0 },
        contentEditProposals: [],
      },
      {
        id: 'writer',
        name: '写作专项',
        charter: '处理写作任务',
        status: 'active',
        kind: 'specialist',
        parentAgentId: 'butler',
        derivationReason: null,
        mergedIntoAgentId: null,
        createdAt: '2026-06-19T00:00:00.000Z',
        rules: {
          relPath: 'agents/writer/RULES.md',
          exists: true,
          preview: '只处理写作任务。',
          content: '# Writer\n\n- 只处理写作任务。\n',
          contentHash: 'hash-rules',
        },
        foundation: {
          relPath: 'agents/writer/FOUNDATION.md',
          exists: true,
          preview: '写作专项基础文档。',
          content: '# Writer Foundation\n\n写作专项基础文档。\n',
          contentHash: 'hash-foundation',
        },
        knowledgeCards: [{
          relPath: 'agents/writer/knowledge/style.md',
          title: '写作知识',
          description: '短句优先',
          status: 'active',
          tag: 'knowledge',
          scopeId: 'agent:writer',
          body: '短句优先。',
          contentHash: 'hash-card',
        }],
        routingCards: [{
          relPath: 'knowledge/routing-writer.md',
          title: '路由：写作',
          description: '写作请求',
          status: 'active',
          targetAgentId: 'writer',
          targetStatus: 'active',
          triggers: ['写作'],
          disabledReason: null,
        }],
        ownedTasks: [{
          taskId: 'task-1',
          scopeId: 'scope-1',
          title: '写一版大纲',
          summary: '写作任务',
          status: 'blocked',
          interactionState: null,
          ownerAgentId: 'writer',
          updatedAt: '2026-06-19T00:01:00.000Z',
        }],
        contentSummary: { knowledgeCards: 1, routingCards: 1, ownedTasks: 1, stagedContentEdits: 1 },
        contentEditProposals: [{
          proposalId: 'sce-task-1',
          agentId: 'writer',
          targetKind: 'knowledge_card',
          targetRelPath: 'agents/writer/knowledge/task-evolution-task-1.md',
          baseHash: 'hash-empty',
          baseContent: '',
          proposedContent: '同类任务先列清楚边界。',
          status: 'staged',
          provenance: {
            source: 'task_evolution',
            sessionId: 'scope-1',
            note: 'done',
            taskId: 'task-1',
            runId: 'run-1',
            scopeId: 'scope-1',
            taskTitle: '写一版大纲',
            taskSummary: '写作任务',
          },
          createdAt: '2026-06-20T00:00:00.000Z',
          updatedAt: '2026-06-20T00:00:00.000Z',
          appliedAt: null,
        }],
      },
    ],
    routingCards: [{
      relPath: 'knowledge/routing-writer.md',
      title: '路由：写作',
      description: '写作请求',
      status: 'active',
      targetAgentId: 'writer',
      targetStatus: 'active',
      triggers: ['写作'],
      disabledReason: null,
    }, {
      relPath: 'knowledge/routing-ghost.md',
      title: '路由：幽灵',
      description: '目标不存在',
      status: 'active',
      targetAgentId: 'ghost',
      targetStatus: 'missing',
      triggers: null,
      disabledReason: 'target_inactive',
    }],
    derivationCandidates: [{
      candidateRelPath: 'knowledge/agent-candidate-editor.md',
      title: '专项 agent 候选：编辑',
      description: '编辑重复出现',
      defaultSpecialistId: 'editor',
      defaultName: '编辑专项 Agent',
      defaultRoutingTriggers: ['编辑'],
    }],
    stagedBlueprints: [
      blueprint(),
      blueprint({
        blueprintId: 'bp-xhs-collector',
        status: 'needs_clarification',
        displayName: '小红书采集员',
        specialistId: 'xhs-collector',
        intendedDomain: '小红书行情采集',
        admissionVerdict: {
          kind: 'clarify',
          missing: ['nonGoals', 'requiredInputs'],
        },
      }),
      blueprint({
        blueprintId: 'bp-confirmed-researcher',
        status: 'confirmed',
        displayName: '已确认研究员',
        specialistId: 'confirmed-researcher',
      }),
    ],
    recentPrerouteTraces: [{
      id: 'trace-1',
      createdAt: '2026-06-19T00:02:00.000Z',
      firstMessagePreview: '写作大纲',
      mode: 'suggest',
      effect: 'suggest',
      decisionTier: 'precedent',
      targetAgentId: 'writer',
      reasons: ['suggest_only'],
    }],
  }
}

function installDom(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement,
    SVGElement: (globalThis as { SVGElement?: typeof SVGElement }).SVGElement,
    Node: (globalThis as { Node?: typeof Node }).Node,
    Element: (globalThis as { Element?: typeof Element }).Element,
    Event: (globalThis as { Event?: typeof Event }).Event,
    MouseEvent: (globalThis as { MouseEvent?: typeof MouseEvent }).MouseEvent,
    navigator: (globalThis as { navigator?: Navigator }).navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  }
  function setGlobal(key: string, value: unknown): void {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('SVGElement', dom.window.SVGElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Element', dom.window.Element)
  setGlobal('Event', dom.window.Event)
  setGlobal('MouseEvent', dom.window.MouseEvent)
  setGlobal('navigator', dom.window.navigator)
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return {
    dom,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete (globalThis as unknown as Record<string, unknown>)[key]
        else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      }
      try { dom.window.close() } catch { /* best-effort */ }
    },
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')
    descriptor?.set?.call(control, value)
    const EventCtor = control.ownerDocument.defaultView?.Event ?? Event
    control.dispatchEvent(new EventCtor('input', { bubbles: true }))
    control.dispatchEvent(new EventCtor('change', { bubbles: true }))
  })
  await flush()
}

async function mount(element: ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const host = globalThis.document.getElementById('root')
  assert.ok(host)
  host.innerHTML = ''
  const container = globalThis.document.createElement('div')
  host.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  await flush()
  return { root, container }
}

test('AgentSystemStudio renders read-only snapshot and specialist detail', async () => {
  const handle = installDom()
  try {
    const { default: AgentSystemStudio } = await import('../renderer/components/agent-system/AgentSystemStudio')
    const calls: string[] = []
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => {
          calls.push('snapshot')
          return { success: true, data: snapshot() }
        },
        requestSpecialistBlueprintConfirmation: async () => {
          calls.push('request-token')
          return { success: true, data: { blueprint: blueprint(), tokenId: 'token-1' } }
        },
	        confirmSpecialistDraftCreate: async () => {
	          calls.push('confirm-create')
	          return { success: true, data: { blueprint: blueprint(), result: { agent: { id: 'visual-researcher' }, rulesRelPath: 'agents/visual-researcher/RULES.md', foundationRelPath: 'agents/visual-researcher/FOUNDATION.md', seedRelPaths: ['agents/visual-researcher/knowledge/seed-01.md'], routingCardRelPath: 'knowledge/routing-visual-researcher.md', migratedCards: [] } } }
	        },
        rejectSpecialistBlueprint: async () => ({ success: true, data: blueprint({ status: 'rejected' }) }),
      },
    }
    const mounted = await mount(createElement(AgentSystemStudio))
    try {
      assert.match(mounted.container.textContent || '', /Agent System Studio/)
      assert.match(mounted.container.textContent || '', /写作专项/)
      const writerButton = Array.from(mounted.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('writer')) as HTMLButtonElement | undefined
      assert.ok(writerButton)
      await act(async () => {
        writerButton.click()
      })
      await flush()
      const text = mounted.container.textContent || ''
      assert.match(text, /只处理写作任务/)
      assert.match(text, /路由：写作/)
      assert.match(text, /路由：幽灵/)
      assert.match(text, /目标不可用/)
      assert.match(text, /写一版大纲/)
      assert.match(text, /任务演进/)
      assert.match(text, /来源任务 task-1/)
      assert.match(text, /同类任务先列清楚边界/)
      assert.match(text, /suggest_only/)
      assert.match(text, /视觉研究专项 Agent/)
      assert.match(text, /待补齐：nonGoals \/ requiredInputs/)
      assert.match(text, /需补齐信息/)
      assert.match(text, /这个专项 agent 明确不该做哪些事/)
      assert.match(text, /先补齐信息/)
      assert.match(text, /语义已校验/)
      assert.match(text, /FOUNDATION 预览/)
      assert.match(text, /# 视觉研究专项 Agent Foundation/)
      assert.match(text, /确认创建/)
      const confirmButtons = Array.from(mounted.container.querySelectorAll('button'))
        .filter((button) => button.textContent?.includes('确认创建')) as HTMLButtonElement[]
      assert.equal(confirmButtons.length, 1)
      const confirmButton = confirmButtons[0]
      assert.ok(confirmButton)
      await act(async () => {
        confirmButton.click()
      })
      await flush()
      assert.deepEqual(calls.slice(-3), ['request-token', 'confirm-create', 'snapshot'])
    } finally {
      await act(async () => {
        mounted.root.unmount()
      })
    }
  } finally {
    handle.restore()
  }
})

test('AgentSystemStudio simulates routing without creating or activating routes', async () => {
  const handle = installDom()
  try {
    const { default: AgentSystemStudio } = await import('../renderer/components/agent-system/AgentSystemStudio')
    const calls: string[] = []
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => ({ success: true, data: snapshot() }),
        simulateSystemStudioRouting: async (firstMessage: string) => {
          calls.push(firstMessage)
          return {
            success: true,
            data: {
              sample: firstMessage,
              mode: 'suggest',
              effect: 'suggest',
              decisionTier: 'precedent',
              targetAgentId: 'writer',
              targetAgentName: '写作专项',
              targetStatus: 'active',
              matchedKeywords: ['写作'],
              cardRelPath: 'knowledge/routing-writer.md',
              fallbackReason: null,
              conflicts: [],
              reasons: ['suggest_only'],
              actions: [{
                kind: 'use_once',
                label: '本次用 写作专项',
                description: '只把这次请求交给该专项 agent，不改变路由卡。',
                enabled: true,
              }, {
                kind: 'always_route',
                label: '总是路由这类',
                description: '需要用户确认后才会让这类触发词长期生效。',
                enabled: true,
              }, {
                kind: 'keep_main',
                label: '留在主 agent',
                description: '保持主 agent 处理这次请求，不启用专项分派。',
                enabled: true,
              }],
            },
          }
        },
      },
    }
    const mounted = await mount(createElement(AgentSystemStudio))
    try {
      const input = mounted.container.querySelector('input[aria-label="样例请求"]') as HTMLInputElement | null
      assert.ok(input)
      await setControlValue(input, '我要写作专项帮我写一版大纲')
      const probeButton = Array.from(mounted.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('试算路由')) as HTMLButtonElement | undefined
      assert.ok(probeButton)
      await act(async () => {
        probeButton.click()
      })
      await flush()

      assert.deepEqual(calls, ['我要写作专项帮我写一版大纲'])
      const text = mounted.container.textContent || ''
      assert.match(text, /建议选择/)
      assert.match(text, /命中路由/)
      assert.match(text, /写作专项/)
      assert.match(text, /建议模式/)
      assert.match(text, /本次用 写作专项/)
      assert.match(text, /总是路由这类/)
      assert.match(text, /留在主 agent/)
      assert.match(text, /不改变路由卡/)
    } finally {
      await act(async () => {
        mounted.root.unmount()
      })
    }
  } finally {
    handle.restore()
  }
})

test('AgentSystemStudio stages and confirms specialist content edits', async () => {
  const handle = installDom()
  try {
    const { default: AgentSystemStudio } = await import('../renderer/components/agent-system/AgentSystemStudio')
    const calls: string[] = []
    let stagePayload: unknown = null
    let snapshotData = snapshot()
    const proposal = {
      proposalId: 'sce-1',
      agentId: 'writer',
      targetKind: 'rules' as const,
      targetRelPath: 'agents/writer/RULES.md',
      baseHash: 'hash-rules',
      baseContent: '# Writer\n\n- 只处理写作任务。\n',
      proposedContent: '# Writer\n\n- 只处理写作任务。\n- 每次输出前先列边界。\n',
      status: 'staged' as const,
      provenance: { source: 'studio' as const, sessionId: 'agent-system-studio:writer', note: null },
      createdAt: '2026-06-20T00:00:00.000Z',
      updatedAt: '2026-06-20T00:00:00.000Z',
      appliedAt: null,
    }
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => {
          calls.push('snapshot')
          return { success: true, data: snapshotData }
        },
        stageSystemStudioContentEdit: async (payload: unknown) => {
          calls.push('stage-content')
          stagePayload = payload
          snapshotData = {
            ...snapshotData,
            agents: snapshotData.agents.map((agent) => agent.id === 'writer'
              ? {
                  ...agent,
                  contentSummary: { ...agent.contentSummary, stagedContentEdits: 1 },
                  contentEditProposals: [proposal],
                }
              : agent),
          }
          return { success: true, data: proposal }
        },
        confirmSystemStudioContentEdit: async (proposalId: string) => {
          calls.push(`confirm-content:${proposalId}`)
          const applied = { ...proposal, status: 'applied' as const, appliedAt: '2026-06-20T00:01:00.000Z' }
          snapshotData = {
            ...snapshotData,
            agents: snapshotData.agents.map((agent) => agent.id === 'writer'
              ? {
                  ...agent,
                  rules: {
                    ...agent.rules,
                    content: proposal.proposedContent,
                    preview: '只处理写作任务。 每次输出前先列边界。',
                    contentHash: 'hash-rules-next',
                  },
                  contentSummary: { ...agent.contentSummary, stagedContentEdits: 0 },
                  contentEditProposals: [applied],
                }
              : agent),
          }
          return { success: true, data: applied }
        },
      },
    }
    const mounted = await mount(createElement(AgentSystemStudio))
    try {
      const writerButton = Array.from(mounted.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('writer')) as HTMLButtonElement | undefined
      assert.ok(writerButton)
      await act(async () => {
        writerButton.click()
      })
      await flush()

      const rulesSection = Array.from(mounted.container.querySelectorAll('section'))
        .find((section) => section.textContent?.includes('RULES') && section.textContent.includes('只处理写作任务')) as HTMLElement | undefined
      assert.ok(rulesSection)
      const editButton = Array.from(rulesSection.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('编辑')) as HTMLButtonElement | undefined
      assert.ok(editButton)
      await act(async () => {
        editButton.click()
      })
      await flush()

      const textarea = mounted.container.querySelector('textarea[aria-label="修改内容：RULES"]') as HTMLTextAreaElement | null
      assert.ok(textarea)
      await setControlValue(textarea, proposal.proposedContent)
      const saveButton = Array.from(mounted.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('保存为提案')) as HTMLButtonElement | undefined
      assert.ok(saveButton)
      await act(async () => {
        saveButton.click()
      })
      await flush()

      assert.deepEqual(stagePayload, {
        agentId: 'writer',
        targetKind: 'rules',
        targetRelPath: 'agents/writer/RULES.md',
        proposedContent: proposal.proposedContent,
        sessionId: 'agent-system-studio:writer',
      })
      assert.match(mounted.container.textContent || '', /内容修改提案/)
      assert.match(mounted.container.textContent || '', /确认应用/)

      const confirmButton = Array.from(mounted.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('确认应用')) as HTMLButtonElement | undefined
      assert.ok(confirmButton)
      await act(async () => {
        confirmButton.click()
      })
      await flush()

      assert.ok(calls.includes('stage-content'))
      assert.ok(calls.includes('confirm-content:sce-1'))
      assert.match(mounted.container.textContent || '', /applied/)
    } finally {
      await act(async () => {
        mounted.root.unmount()
      })
    }
  } finally {
    handle.restore()
  }
})

test('AgentSystemStudio requires explicit unverified semantic ack before confirming', async () => {
  const handle = installDom()
  try {
    const { default: AgentSystemStudio } = await import('../renderer/components/agent-system/AgentSystemStudio')
    const calls: string[] = []
    let requestPayload: unknown = null
    const snapshotData = {
      ...snapshot(),
      stagedBlueprints: [blueprint({
        semanticReview: {
          status: 'unavailable',
          contentHash: 'hash-unavailable',
          reviewedAt: '2026-06-20T00:00:00.000Z',
          issues: [],
          source: 'not_available',
          unavailableReason: 'judge_unavailable',
        },
      })],
    }
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => ({ success: true, data: snapshotData }),
        requestSpecialistBlueprintConfirmation: async (payload: unknown) => {
          calls.push('request-token')
          requestPayload = payload
          return { success: true, data: { blueprint: blueprint(), tokenId: 'token-1', contentHash: 'hash-unavailable' } }
        },
        confirmSpecialistDraftCreate: async () => {
          calls.push('confirm-create')
          return { success: true, data: { blueprint: blueprint(), result: { agent: { id: 'visual-researcher' }, rulesRelPath: 'agents/visual-researcher/RULES.md', foundationRelPath: 'agents/visual-researcher/FOUNDATION.md', seedRelPaths: [], routingCardRelPath: 'knowledge/routing-visual-researcher.md', migratedCards: [] } } }
        },
      },
    }
    const mounted = await mount(createElement(AgentSystemStudio))
    try {
      let text = mounted.container.textContent || ''
      assert.match(text, /语义未校验/)
      assert.match(text, /FOUNDATION 尚未完成语义校验/)
      assert.match(text, /我已阅读完整 FOUNDATION/)
      assert.match(text, /先确认未校验/)
      assert.equal(Array.from(mounted.container.querySelectorAll('button')).some((button) => button.textContent?.includes('确认创建')), false)

      const ack = Array.from(mounted.container.querySelectorAll('input[type="checkbox"]'))
        .find((input) => input.parentElement?.textContent?.includes('我已阅读完整 FOUNDATION')) as HTMLInputElement | undefined
      assert.ok(ack)
      await act(async () => {
        ack.click()
      })
      await flush()

      const confirmButton = Array.from(mounted.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('确认创建')) as HTMLButtonElement | undefined
      assert.ok(confirmButton)
      await act(async () => {
        confirmButton.click()
      })
      await flush()
      assert.deepEqual(calls, ['request-token', 'confirm-create'])
      assert.deepEqual((requestPayload as {
        unverifiedSemanticReviewAck?: { kind: string; contentHash: string }
      }).unverifiedSemanticReviewAck, {
        kind: 'unverified_semantic_review',
        contentHash: 'hash-unavailable',
      })
      text = mounted.container.textContent || ''
      assert.match(text, /# 视觉研究专项 Agent Foundation/)
    } finally {
      await act(async () => {
        mounted.root.unmount()
      })
    }
  } finally {
    handle.restore()
  }
})

test('AgentSystemStudio offers semantic refresh when a staged blueprint has no review record', async () => {
  const handle = installDom()
  try {
    const { default: AgentSystemStudio } = await import('../renderer/components/agent-system/AgentSystemStudio')
    const calls: string[] = []
    let admissionPayload: unknown = null
    const reviewed = blueprint({
      semanticReview: {
        status: 'unavailable',
        contentHash: 'hash-refreshed',
        reviewedAt: '2026-06-20T00:00:00.000Z',
        issues: [],
        source: 'not_available',
        unavailableReason: 'judge_unavailable',
      },
    })
    let snapshotData = {
      ...snapshot(),
      stagedBlueprints: [blueprint({ semanticReview: undefined })],
    }
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => {
          calls.push('snapshot')
          return { success: true, data: snapshotData }
        },
        runSpecialistBlueprintAdmission: async (payload: unknown) => {
          calls.push('run-admission')
          admissionPayload = payload
          snapshotData = { ...snapshotData, stagedBlueprints: [reviewed] }
          return { success: true, data: { blueprint: reviewed, verdict: reviewed.admissionVerdict, missing: [] } }
        },
        requestSpecialistBlueprintConfirmation: async () => {
          calls.push('request-token')
          return { success: true, data: { blueprint: reviewed, tokenId: 'token-1', contentHash: 'hash-refreshed' } }
        },
        confirmSpecialistDraftCreate: async () => {
          calls.push('confirm-create')
          return { success: true, data: { blueprint: reviewed, result: { agent: { id: 'visual-researcher' }, rulesRelPath: 'agents/visual-researcher/RULES.md', foundationRelPath: 'agents/visual-researcher/FOUNDATION.md', seedRelPaths: [], routingCardRelPath: 'knowledge/routing-visual-researcher.md', migratedCards: [] } } }
        },
      },
    }
    const mounted = await mount(createElement(AgentSystemStudio))
    try {
      assert.match(mounted.container.textContent || '', /FOUNDATION 还没有语义校验记录/)
      assert.match(mounted.container.textContent || '', /先刷新语义/)
      const refreshButton = Array.from(mounted.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('刷新语义校验')) as HTMLButtonElement | undefined
      assert.ok(refreshButton)
      await act(async () => {
        refreshButton.click()
      })
      await flush()

      assert.deepEqual(admissionPayload, { blueprintId: 'bp-visual-researcher' })
      assert.deepEqual(calls.slice(0, 3), ['snapshot', 'run-admission', 'snapshot'])
      assert.match(mounted.container.textContent || '', /我已阅读完整 FOUNDATION/)
      assert.equal(Array.from(mounted.container.querySelectorAll('button')).some((button) => button.textContent?.includes('确认创建')), false)
    } finally {
      await act(async () => {
        mounted.root.unmount()
      })
    }
  } finally {
    handle.restore()
  }
})

test('AgentSystemStudio blocks confirm-create when semantic review has blocking issues', async () => {
  const handle = installDom()
  try {
    const { default: AgentSystemStudio } = await import('../renderer/components/agent-system/AgentSystemStudio')
    const calls: string[] = []
    const snapshotData = {
      ...snapshot(),
      stagedBlueprints: [
        blueprint({
          semanticReview: {
            status: 'blocked',
            contentHash: 'hash-blocked',
            reviewedAt: '2026-06-20T00:00:00.000Z',
            source: 'semantic_judge',
            issues: [{
              id: 'scope_too_generic',
              message: '职责范围仍然过泛。',
            }],
          },
        }),
      ],
    }
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => {
          calls.push('snapshot')
          return { success: true, data: snapshotData }
        },
        requestSpecialistBlueprintConfirmation: async () => {
          calls.push('request-token')
          throw new Error('blocked semantic review should not request confirmation')
        },
        confirmSpecialistDraftCreate: async () => {
          calls.push('confirm-create')
          throw new Error('blocked semantic review should not create')
        },
      },
    }
    const mounted = await mount(createElement(AgentSystemStudio))
    try {
      const text = mounted.container.textContent || ''
      assert.match(text, /语义需修正/)
      assert.match(text, /语义缺口/)
      assert.match(text, /职责范围仍然过泛/)
      assert.match(text, /先修语义/)
      assert.equal(Array.from(mounted.container.querySelectorAll('button')).some((button) => button.textContent?.includes('确认创建')), false)
      assert.deepEqual(calls, ['snapshot'])
    } finally {
      await act(async () => {
        mounted.root.unmount()
      })
    }
  } finally {
    handle.restore()
  }
})

test('AgentSystemStudio saves blueprint edits through admission without confirm-create', async () => {
  const handle = installDom()
  try {
    const { default: AgentSystemStudio } = await import('../renderer/components/agent-system/AgentSystemStudio')
    const calls: string[] = []
    let snapshotData = snapshot()
    let admissionPayload: { blueprint: SpecialistAgentBlueprint } | null = null
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => {
          calls.push('snapshot')
          return { success: true, data: snapshotData }
        },
        runSpecialistBlueprintAdmission: async (payload: { blueprint: SpecialistAgentBlueprint }) => {
          calls.push('run-admission')
          admissionPayload = payload
          const saved = {
            ...payload.blueprint,
            status: 'staged' as const,
            admissionVerdict: { kind: 'admit' as const },
          }
          snapshotData = {
            ...snapshotData,
            stagedBlueprints: snapshotData.stagedBlueprints.map((item) => (
              item.blueprintId === saved.blueprintId ? saved : item
            )),
          }
          return { success: true, data: { blueprint: saved, verdict: saved.admissionVerdict, missing: [] } }
        },
        requestSpecialistBlueprintConfirmation: async () => {
          calls.push('request-token')
          return { success: true, data: { blueprint: blueprint(), tokenId: 'token-1' } }
        },
	        confirmSpecialistDraftCreate: async () => {
	          calls.push('confirm-create')
	          return { success: true, data: { blueprint: blueprint(), result: { agent: { id: 'visual-researcher' }, rulesRelPath: 'agents/visual-researcher/RULES.md', foundationRelPath: 'agents/visual-researcher/FOUNDATION.md', seedRelPaths: ['agents/visual-researcher/knowledge/seed-01.md'], routingCardRelPath: 'knowledge/routing-visual-researcher.md', migratedCards: [] } } }
	        },
        rejectSpecialistBlueprint: async () => ({ success: true, data: blueprint({ status: 'rejected' }) }),
      },
    }
    const mounted = await mount(createElement(AgentSystemStudio))
    try {
      const charter = mounted.container.querySelector('textarea[aria-label="职责范围"]') as HTMLTextAreaElement | null
      const nonGoals = mounted.container.querySelector('textarea[aria-label="不做事项"]') as HTMLTextAreaElement | null
      const rules = mounted.container.querySelector('textarea[aria-label="RULES"]') as HTMLTextAreaElement | null
      assert.ok(charter)
      assert.ok(nonGoals)
      assert.ok(rules)

      await setControlValue(charter, '负责视觉参考研究，并输出带来源的判断。')
      await setControlValue(nonGoals, [
        '不外发文件',
        '不代替用户登录',
        '不做账号托管',
        '不发布内容',
        '不删除来源',
        '不改写证据',
        '不绕过确认',
        '不处理付款',
        '不做法律结论',
      ].join('\n'))
      await setControlValue(rules, '# 视觉研究专项 Agent\n- 每条结论保留来源。')
      assert.match(mounted.container.textContent || '', /先保存/)

      const saveButton = Array.from(mounted.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('保存蓝图')) as HTMLButtonElement | undefined
      assert.ok(saveButton)
      await act(async () => {
        saveButton.click()
      })
      await flush()

      assert.ok(admissionPayload)
      assert.equal(admissionPayload.blueprint.charter, '负责视觉参考研究，并输出带来源的判断。')
      assert.equal(admissionPayload.blueprint.foundationDocs.charter, '负责视觉参考研究，并输出带来源的判断。')
      assert.equal(admissionPayload.blueprint.nonGoals.length, 9)
      assert.deepEqual(admissionPayload.blueprint.nonGoals.slice(0, 2), ['不外发文件', '不代替用户登录'])
      assert.equal(admissionPayload.blueprint.seedRulesText, '# 视觉研究专项 Agent\n- 每条结论保留来源。')
      assert.equal(admissionPayload.blueprint.foundationDocs.rulesText, '# 视觉研究专项 Agent\n- 每条结论保留来源。')
      assert.equal(admissionPayload.blueprint.userRequestVerbatim, '我要一个视觉研究类型的专项 agent')
      assert.ok(calls.includes('run-admission'))
      assert.equal(calls.includes('confirm-create'), false)
    } finally {
      await act(async () => {
        mounted.root.unmount()
      })
    }
  } finally {
    handle.restore()
  }
})

test('AgentSystemStudio passes selected blueprint migration cards into confirm-create', async () => {
  const handle = installDom()
  try {
    const { default: AgentSystemStudio } = await import('../renderer/components/agent-system/AgentSystemStudio')
    const calls: string[] = []
    let confirmPayload: { migrateCardRelPaths?: string[] } | null = null
    const snapshotData = {
      ...snapshot(),
      stagedBlueprints: [
        blueprint({ migrationCandidates: ['knowledge/xhs-note.md', 'knowledge/unused-note.md'] }),
      ],
    }
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => {
          calls.push('snapshot')
          return { success: true, data: snapshotData }
        },
        requestSpecialistBlueprintConfirmation: async () => {
          calls.push('request-token')
          return { success: true, data: { blueprint: blueprint(), tokenId: 'token-1' } }
        },
        confirmSpecialistDraftCreate: async (payload: { migrateCardRelPaths?: string[] }) => {
          calls.push('confirm-create')
          confirmPayload = payload
          return {
            success: true,
            data: {
              blueprint: blueprint(),
              result: {
                agent: { id: 'visual-researcher' },
                rulesRelPath: 'agents/visual-researcher/RULES.md',
                foundationRelPath: 'agents/visual-researcher/FOUNDATION.md',
                seedRelPaths: ['agents/visual-researcher/knowledge/seed-01.md'],
                routingCardRelPath: 'knowledge/routing-visual-researcher.md',
                migratedCards: [{ from: 'knowledge/xhs-note.md', to: 'agents/visual-researcher/knowledge/xhs-note.md' }],
              },
            },
          }
        },
        rejectSpecialistBlueprint: async () => ({ success: true, data: blueprint({ status: 'rejected' }) }),
      },
    }
    const mounted = await mount(createElement(AgentSystemStudio))
    try {
      assert.match(mounted.container.textContent || '', /采用时迁移的知识/)
      const checkbox = mounted.container.querySelector('input[type="checkbox"]') as HTMLInputElement | null
      assert.ok(checkbox)
      await act(async () => {
        checkbox.click()
      })
      await flush()

      const confirmButton = Array.from(mounted.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('确认创建')) as HTMLButtonElement | undefined
      assert.ok(confirmButton)
      await act(async () => {
        confirmButton.click()
      })
      await flush()

      assert.deepEqual(calls.slice(-3), ['request-token', 'confirm-create', 'snapshot'])
      assert.deepEqual(confirmPayload?.migrateCardRelPaths, ['knowledge/xhs-note.md'])
    } finally {
      await act(async () => {
        mounted.root.unmount()
      })
    }
  } finally {
    handle.restore()
  }
})

test('AgentSystemStudio blocks confirm-create when blueprint quality has blocking failures', async () => {
  const handle = installDom()
  try {
    const { default: AgentSystemStudio } = await import('../renderer/components/agent-system/AgentSystemStudio')
    const calls: string[] = []
    const snapshotData = {
      ...snapshot(),
      stagedBlueprints: [
        blueprint({
          qualityChecks: [{
            check: 'charter',
            pass: false,
            blocking: true,
            message: '职责范围需要比用户原话更具体。',
          }],
        }),
      ],
    }
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => {
          calls.push('snapshot')
          return { success: true, data: snapshotData }
        },
        requestSpecialistBlueprintConfirmation: async () => {
          calls.push('request-token')
          throw new Error('quality failure should not request confirmation')
        },
        confirmSpecialistDraftCreate: async () => {
          calls.push('confirm-create')
          throw new Error('quality failure should not create')
        },
      },
    }
    const mounted = await mount(createElement(AgentSystemStudio))
    try {
      assert.match(mounted.container.textContent || '', /质量缺口/)
      assert.match(mounted.container.textContent || '', /职责范围需要比用户原话更具体/)
      assert.match(mounted.container.textContent || '', /先修质量/)
      assert.equal(Array.from(mounted.container.querySelectorAll('button')).some((button) => button.textContent?.includes('确认创建')), false)
      assert.deepEqual(calls, ['snapshot'])
    } finally {
      await act(async () => {
        mounted.root.unmount()
      })
    }
  } finally {
    handle.restore()
  }
})

test('AgentSystemStudio can retry a confirmed blueprint that has not been adopted', async () => {
  const handle = installDom()
  try {
    const { default: AgentSystemStudio } = await import('../renderer/components/agent-system/AgentSystemStudio')
    const calls: string[] = []
    let confirmPayload: { tokenId?: string } | null = null
    const pendingAdoption = blueprint({
      status: 'confirmed',
      confirmation: {
        tokenId: 'token-1',
        confirmedAt: '2026-06-19T00:01:00.000Z',
        usedAt: null,
      },
    })
    const snapshotData = {
      ...snapshot(),
      stagedBlueprints: [pendingAdoption],
    }
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => {
          calls.push('snapshot')
          return { success: true, data: snapshotData }
        },
        requestSpecialistBlueprintConfirmation: async () => {
          calls.push('request-token')
          return { success: true, data: { blueprint: pendingAdoption, tokenId: 'new-token' } }
        },
        confirmSpecialistDraftCreate: async (payload: { tokenId?: string }) => {
          calls.push('confirm-create')
          confirmPayload = payload
          return {
            success: true,
            data: {
              blueprint: pendingAdoption,
              result: {
                agent: { id: 'visual-researcher' },
                rulesRelPath: 'agents/visual-researcher/RULES.md',
                foundationRelPath: 'agents/visual-researcher/FOUNDATION.md',
                seedRelPaths: ['agents/visual-researcher/knowledge/seed-01.md'],
                routingCardRelPath: 'knowledge/routing-visual-researcher.md',
                migratedCards: [],
              },
            },
          }
        },
      },
    }
    const mounted = await mount(createElement(AgentSystemStudio))
    try {
      const continueButton = Array.from(mounted.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('继续创建')) as HTMLButtonElement | undefined
      assert.ok(continueButton)
      await act(async () => {
        continueButton.click()
      })
      await flush()

      assert.equal(calls.includes('request-token'), false)
      assert.equal(calls.includes('confirm-create'), true)
      assert.equal(confirmPayload?.tokenId, 'token-1')
    } finally {
      await act(async () => {
        mounted.root.unmount()
      })
    }
  } finally {
    handle.restore()
  }
})

test('AgentSystemStudio renders confirmed blueprints as read-only in the editor', async () => {
  const handle = installDom()
  try {
    const { default: AgentSystemStudio } = await import('../renderer/components/agent-system/AgentSystemStudio')
    const snapshotData = {
      ...snapshot(),
      stagedBlueprints: snapshot().stagedBlueprints.map((item) => (
        item.blueprintId === 'bp-confirmed-researcher'
          ? blueprint({
            blueprintId: 'bp-confirmed-researcher',
            status: 'confirmed',
            displayName: '已确认研究员',
            specialistId: 'confirmed-researcher',
            adoption: {
              blueprintId: 'bp-confirmed-researcher',
              createdAgentId: 'confirmed-researcher',
              confirmationTokenId: 'token-1',
              migratedCards: [{ from: 'knowledge/xhs-note.md', to: 'agents/confirmed-researcher/knowledge/xhs-note.md' }],
              seedRelPaths: ['agents/confirmed-researcher/knowledge/seed-01.md'],
              foundationRelPath: 'agents/confirmed-researcher/FOUNDATION.md',
              routingCardRelPath: 'knowledge/routing-confirmed-researcher.md',
              adoptedAt: '2026-06-19T00:02:00.000Z',
            },
          })
          : item
      )),
    }
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        getSystemStudioSnapshot: async () => ({ success: true, data: snapshotData }),
        runSpecialistBlueprintAdmission: async () => {
          throw new Error('confirmed blueprint should not save')
        },
      },
    }
    const mounted = await mount(createElement(AgentSystemStudio))
    try {
      const confirmedButton = Array.from(mounted.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('已确认研究员')) as HTMLButtonElement | undefined
      assert.ok(confirmedButton)
      await act(async () => {
        confirmedButton.click()
      })
      await flush()
      assert.equal(mounted.container.querySelector('button')?.textContent?.includes('保存蓝图'), false)
      assert.equal(Array.from(mounted.container.querySelectorAll('button')).some((button) => button.textContent?.includes('保存蓝图')), false)
      assert.match(mounted.container.textContent || '', /已确认/)
      assert.match(mounted.container.textContent || '', /已采用为 confirmed-researcher/)
      assert.match(mounted.container.textContent || '', /迁移知识：1/)
    } finally {
      await act(async () => {
        mounted.root.unmount()
      })
    }
  } finally {
    handle.restore()
  }
})
