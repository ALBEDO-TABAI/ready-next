import { domainsLikelyMatch, getBrowserWorkflowState, getLatestSkillRun, getRecentBrowserActions } from './session-continuity'
import type { BrowserTaskAttachmentResource, BrowserTaskDecision, BrowserTaskPlan, BrowserTaskPlanContinuity } from '../../../shared/browser-agent-task'

interface PlannerTabLike {
  id: string
  url: string
  title: string
  domain: string
  active: boolean
  owner: string
  required: boolean
  activity: string
  lastAuditedAt: number | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  favicon: string | null
}

interface PlannerTabContextLike {
  url: string
  title: string
  heading: string
  selection: string
  excerpt: string
  capturedAt: number
  domain: string
}

interface NamedBrowserSite {
  id: string
  displayName: string
  aliases: string[]
  searchQuery: string
}

const NAMED_BROWSER_SITES: NamedBrowserSite[] = [
  { id: 'jimeng', displayName: '即梦', aliases: ['即梦', 'jimeng'], searchQuery: '即梦 AI 生图 官方网站' },
  { id: 'gemini', displayName: 'Gemini', aliases: ['gemini'], searchQuery: 'Gemini 官方网站' },
  { id: 'kimi', displayName: 'Kimi', aliases: ['kimi'], searchQuery: 'Kimi 官方网站' },
  { id: 'midjourney', displayName: 'Midjourney', aliases: ['midjourney'], searchQuery: 'Midjourney official website' },
  { id: 'pinterest', displayName: 'Pinterest', aliases: ['pinterest'], searchQuery: 'Pinterest official website' },
  { id: 'feishu', displayName: '飞书', aliases: ['飞书', 'feishu'], searchQuery: '飞书 官方网站' },
]

export class BrowserTaskPlanner {
  constructor(private readonly deps: {
    getSessionAttachmentHints: (sessionId?: string) => { count: number; latestName?: string }
    getSessionAttachmentResources?: (sessionId?: string) => BrowserTaskAttachmentResource[]
    getIncomingAttachmentHints: (userText: string) => { count: number; latestName?: string }
    getActiveTab: () => PlannerTabLike | undefined
    getTabContext: (tabId?: string | null) => Promise<PlannerTabContextLike | null>
    extractPrimaryUserInstruction?: (raw: string) => string
  }) {}

  private looksLikeBrowserPromptNoise(value: string): boolean {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    if (!text) return false
    if (/^[，。；;、,\s]+/.test(text)) return true
    if (/https?:\/\//i.test(text)) return true
    if (/(然后|接着|随后|再去|继续).{0,12}(即梦|jimeng|gemini|kimi|pinterest|网页|页面|网站|浏览器)/i.test(text)) return true
    if (/(^|[，。,；;\s])(上传|点击|打开|进入|搜索|跳转|发送|提交|浏览器|网页|页面|网站|登录|去即梦|去jimeng|继续生图)([，。,；;\s]|$)/i.test(text)) return true
    return false
  }

  private resolveUsableBrowserPrompt(promptIntent?: BrowserTaskDecision['promptIntent']): string {
    const refined = String(promptIntent?.refined || '').trim()
    if (refined && !this.looksLikeBrowserPromptNoise(refined)) return refined
    const raw = String(promptIntent?.raw || '').trim()
    if (raw && !this.looksLikeBrowserPromptNoise(raw)) return raw
    return ''
  }

  private extractLinks(text: string): Array<{ url: string; order: number; source: 'markdown' | 'raw' }> {
    const primary = (this.deps.extractPrimaryUserInstruction || ((raw: string) => raw))(text).trim()
    if (!primary) return []
    const links: Array<{ url: string; order: number; source: 'markdown' | 'raw' }> = []
    const seen = new Set<string>()
    for (const match of primary.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/ig)) {
      const url = String(match[1] || '').trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      links.push({ url, order: links.length, source: 'markdown' })
    }
    for (const match of primary.matchAll(/https?:\/\/[^\s)]+/ig)) {
      const url = String(match[0] || '').trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      links.push({ url, order: links.length, source: 'raw' })
    }
    return links
  }

  private extractPromptIntent(userText: string): BrowserTaskDecision['promptIntent'] {
    const primary = (this.deps.extractPrimaryUserInstruction || ((raw: string) => raw))(userText).replace(/\s+/g, ' ').trim()
    const quoted = primary.match(/[“"]([^“”"]{4,280})[”"]/)
    if (quoted?.[1]) {
      return { raw: primary, refined: quoted[1].trim(), confidence: 'high', source: 'quoted' }
    }
    const pairedPromptMatch =
      primary.match(/(?:配合|结合|搭配|按照|根据)\s*[：:]\s*(.+?)(?=\s*(?:这个|用这个|按这个)?\s*(?:prompt|提示词)\s*(?:去|在|到|打开|进入)|$)/i) ||
      primary.match(/(?:配合|结合|搭配|按照|根据)\s*[：:]\s*(.+?)(?=\s*(?:去|在|到)\s*(?:\[|https?:\/\/|即梦|jimeng|gemini|kimi|pinterest)|$)/i)
    if (pairedPromptMatch?.[1]) {
      const refined = pairedPromptMatch[1].replace(/[，。；;]+$/g, '').trim()
      if (refined.length >= 6 && !this.looksLikeBrowserPromptNoise(refined)) {
        return { raw: primary, refined, confidence: refined.length <= 240 ? 'high' : 'medium', source: 'keyword' }
      }
    }
    const keywordMatch = primary.match(/(?:提示词|prompt|文案|描述|内容)\s*(?:是|为|：|:)?\s*(.+)$/i)
    if (keywordMatch?.[1]) {
      return { raw: primary, refined: keywordMatch[1].replace(/[，。；;]+$/g, '').trim(), confidence: 'high', source: 'keyword' }
    }
    const clauses = primary
      .split(/(?:然后|接着|随后|并且|并|再|,|，|。|；|;)/)
      .map((item) => item.trim())
      .filter(Boolean)
    const descriptiveSelected = clauses
      .map((clause, index) => {
        const normalized = clause
          .replace(/^(帮我|请你|请|麻烦你)\s*/g, '')
          .replace(/(把|将)?(刚发的图|这张图|上一张图|附件|这张附件|图片附件|飞书里的图|会话里的图片)/g, '')
          .replace(/(上传|放进|放到|塞进|导入|点击|打开|进入|提交|发送|处理|网页|页面|网站|浏览器|聊天框|输入框|按钮|附件上传|开始|继续|完成)/g, '')
          .replace(/\b(即梦|gemini|kimi|pinterest|telegram|feishu)\b/ig, '')
          .replace(/\s+/g, ' ')
          .replace(/^[，、；:：\-\s]+|[，、；:：\-\s]+$/g, '')
          .trim()
        const score =
          (/(风格|画面|主体|场景|构图|光线|色调|材质|海报|插画|照片|写实|卡通|极简|未来感|氛围|设计|封面|电影感|镜头|角色|背景|配色|质感|动作|服装|表情|比例|排版|标题|字体|效果)/.test(normalized) ? 4 : 0) +
          (normalized.length >= 8 && normalized.length <= 160 ? 2 : 0) +
          (!/(上传|附件|点击|发送|提交|网页|页面|浏览器|登录|搜索)/.test(normalized) ? 1 : 0)
        return { normalized, score, index }
      })
      .filter((item) => item.normalized.length >= 4 && item.score >= 3)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.normalized)
      .filter((item, index, arr) => arr.indexOf(item) === index)
    if (descriptiveSelected.length > 0) {
      const refined = descriptiveSelected.join('，').slice(0, 240).trim()
      if (!this.looksLikeBrowserPromptNoise(refined)) {
        return { raw: primary, refined, confidence: descriptiveSelected.length >= 2 ? 'medium' : 'low', source: 'descriptive_clause' }
      }
    }
    return { raw: primary, refined: '', confidence: 'low', source: 'none' }
  }

  private extractSessionPromptIntent(messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>): BrowserTaskDecision['promptIntent'] | undefined {
    const recentUserMessages = [...messages].reverse().filter((message) => message.role === 'user').slice(0, 6)
    for (const message of recentUserMessages) {
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
            .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
            .map((block) => String(block.text || ''))
            .join('\n')
          : ''
      const promptIntent = this.extractPromptIntent(text)
      if (promptIntent?.refined && promptIntent.confidence !== 'low') {
        return promptIntent
      }
    }
    return undefined
  }

  private resolveRequestedBrowserSite(userText: string): NamedBrowserSite | null {
    const primary = (this.deps.extractPrimaryUserInstruction || ((raw: string) => raw))(userText).toLowerCase()
    if (!primary) return null
    return NAMED_BROWSER_SITES.find((site) => site.aliases.some((alias) => primary.includes(alias.toLowerCase()))) || null
  }

  private extractRequestedSiteHints(userText: string): string[] {
    const hints = new Set<string>()
    const primary = (this.deps.extractPrimaryUserInstruction || ((raw: string) => raw))(userText)
    const text = String(primary || userText || '').toLowerCase()
    for (const site of NAMED_BROWSER_SITES) {
      if (site.aliases.some((alias) => text.includes(alias.toLowerCase()))) {
        hints.add(site.id)
        site.aliases.forEach((alias) => hints.add(alias.toLowerCase()))
      }
    }
    for (const link of this.extractLinks(text)) {
      try {
        hints.add(new URL(link.url).hostname.toLowerCase())
      } catch {
        // ignore malformed links
      }
    }
    return Array.from(hints)
  }

  private pageMatchesSiteHints(pageText: string, hints: string[]): boolean {
    const normalizedPage = String(pageText || '').toLowerCase()
    if (!normalizedPage || hints.length === 0) return false
    return hints.some((hint) => normalizedPage.includes(hint.toLowerCase()))
  }

  private isLikelyCreativeModeSelectionPage(pageText: string): boolean {
    const normalized = String(pageText || '').toLowerCase()
    if (!normalized) return false
    const modeSignals = /(agent\s*模式|agent mode|图片生成|视频生成|灵感|画布|资产|即刻造梦|开启你的agent|创作入口|模式切换)/i
    const actionableSignals = /(上传|拖拽|提示词|prompt|输入框|textarea|参考图|上传图片|上传文件|立即生成|开始生成|发送|描述你想生成|生成中|处理中|排队)/i
    return modeSignals.test(normalized) && !actionableSignals.test(normalized)
  }

  rebuildPlan(decision: BrowserTaskDecision, context?: { sessionId?: string; userText?: string }): BrowserTaskPlan {
    const links = this.extractLinks(String(context?.userText || decision.promptIntent?.raw || ''))
    const persistedAttachments = (this.deps.getSessionAttachmentResources || (() => []))(context?.sessionId)
    const attachmentResources = persistedAttachments.length > 0
      ? persistedAttachments
      : decision.attachmentSelection?.latestName
        ? [{ attachmentId: 'latest', name: decision.attachmentSelection.latestName, type: 'image' }]
        : []
    const taskKind =
      decision.mode === 'browser_upload_workflow'
        ? 'upload_generate'
        : links.length > 1
          ? 'multi_page_sequence'
          : decision.mode === 'clarify_first'
            ? 'clarify'
            : 'pure_web_action'
    const steps: BrowserTaskPlan['steps'] =
      decision.mode === 'browser_upload_workflow'
        ? [
          { id: 'resolve_target_page', goal: '确认本轮真正要操作的目标页面', action: '从用户消息中的链接资源里选择当前应处理的第一个页面，不立即执行导航。', verify: ['得到唯一 targetUrl，或确认继续使用当前页面'], skipIf: ['任务图已经锁定 targetUrl'], failIf: ['既没有可用链接，也没有明确当前目标页面'], retryLimit: 0, recoverWith: [] },
          { id: 'resolve_attachment', goal: '确认本轮使用哪一个附件', action: '优先选择当前会话中最近且最相关的附件，并锁定 attachmentId。', verify: ['得到唯一 attachmentId'], skipIf: ['任务图已锁定 attachmentId'], failIf: ['当前会话没有可用附件，或多附件歧义无法消解'], retryLimit: 0, recoverWith: [] },
          { id: 'navigate_target', goal: '进入目标页面', action: '仅在确认目标页后才执行导航，避免看到链接就立即跳转。', verify: ['当前 URL 或页面标题与目标页匹配'], skipIf: ['当前页面已是目标页'], failIf: ['导航后仍无法确认目标页'], retryLimit: 1, recoverWith: ['若偏航则返回目标页'] },
          { id: 'ensure_upload', goal: '让附件真实挂载到页面', action: '定位上传入口，必要时打开上传路径，再上传锁定附件。', verify: ['页面出现附件缩略图、附件 chip、文件名或素材卡片'], skipIf: ['页面已存在同一附件的上传证据'], failIf: ['多次上传后仍未拿到页面级附件证据'], retryLimit: 2, recoverWith: ['恢复弹层或错误页面后重试上传'] },
          { id: 'ensure_prompt', goal: '将最终 prompt 放入正确输入区', action: '先确认当前焦点或最高置信输入区确实是 prompt 输入区，再写入 mustUsePrompt。', verify: ['输入区文本与 mustUsePrompt 高相似'], skipIf: ['页面输入框里已存在同语义 prompt'], failIf: ['无法定位稳定输入区或文本未能进入输入框'], retryLimit: 2, recoverWith: ['重新定位输入区、恢复焦点并复核页面状态'] },
          { id: 'submit', goal: '触发生成或提交', action: '优先使用与当前输入区相邻的发送/生成控件；若缺少输入锚点，先重新定位或改走键盘提交。', verify: ['页面进入生成中、处理中、排队中或按钮进入 loading/disabled'], skipIf: ['页面已经处于运行态'], failIf: ['找不到稳定发送控件或提交后没有运行证据'], retryLimit: 3, recoverWith: ['重新定位发送控件，必要时恢复页面状态并重新确认输入锚点'] },
          { id: 'final_reconcile', goal: '复核当前结果是否满足原始任务目标', action: '检查附件、prompt、运行态是否与预期一致，并给出 done/partial/failed 结论。', verify: ['满足最终成功标准'], skipIf: [], failIf: ['关键证据缺失或当前页面状态与目标明显不符'], retryLimit: 1, recoverWith: ['必要时建议重试或人工接管'] },
        ] as BrowserTaskPlan['steps']
        : decision.mode === 'browser_workflow'
          ? [
            { id: 'resolve_target_page', goal: '确认目标页面', action: '从链接中选择目标页，不立即导航。', verify: ['得到 targetUrl'], skipIf: ['目标页已锁定'], failIf: ['没有可用链接'], retryLimit: 0, recoverWith: [] },
            { id: 'navigate_target', goal: '导航到目标页', action: '确认目标后才导航。', verify: ['URL 匹配目标'], skipIf: ['已在目标页'], failIf: ['导航失败'], retryLimit: 1, recoverWith: [] },
            { id: 'final_reconcile', goal: '验证到达目标', action: '确认页面已加载。', verify: ['页面加载完成'], skipIf: [], failIf: [], retryLimit: 0, recoverWith: [] },
          ] as BrowserTaskPlan['steps']
          : [{ id: 'resolve_target_page', goal: '确认当前要处理的网页上下文', action: '读取当前任务里的页面资源，确定下一步目标。', verify: ['已得到当前目标页或确认使用当前页'], skipIf: ['当前页面状态已满足目标'], failIf: ['页面资源不明确'], retryLimit: 0, recoverWith: [] }] as BrowserTaskPlan['steps']

    const activeTab = this.deps.getActiveTab()
    const rememberedWorkflow = getBrowserWorkflowState(context?.sessionId)
    const activeTabContext = `${activeTab?.title || ''} ${activeTab?.url || ''}`.toLowerCase()
    const rememberedContext = `${rememberedWorkflow?.workflowKind || ''} ${rememberedWorkflow?.domain || ''} ${rememberedWorkflow?.url || ''}`.toLowerCase()
    const requestedSiteHints = this.extractRequestedSiteHints(String(context?.userText || decision.promptIntent?.raw || ''))
    const requestedSite = this.resolveRequestedBrowserSite(String(context?.userText || decision.promptIntent?.raw || ''))
    const activeTabLooksCreative = /(jimeng|即梦|创作|生成|midjourney|designer|canvas|图像|image|stability|openart|playground)/.test(activeTabContext)
    const rememberedWorkflowLooksCreative = /(jimeng|即梦|创作|生成|midjourney|designer|canvas|图像|image|stability|openart|playground)/.test(rememberedContext)
    const activeTabMatchesRequestedSite = requestedSiteHints.length > 0 && this.pageMatchesSiteHints(activeTabContext, requestedSiteHints)
    const rememberedWorkflowMatchesRequestedSite = requestedSiteHints.length > 0 && this.pageMatchesSiteHints(rememberedContext, requestedSiteHints)
    const targetUrl = links[0]?.url || (
      activeTab?.url && activeTabMatchesRequestedSite
        ? activeTab.url
        : rememberedWorkflow?.url && rememberedWorkflowMatchesRequestedSite
          ? rememberedWorkflow.url
          : decision.mode === 'browser_upload_workflow' && requestedSiteHints.length === 0 && activeTabLooksCreative && activeTab?.url
            ? activeTab.url
            : decision.mode === 'browser_upload_workflow' && requestedSiteHints.length === 0 && rememberedWorkflowLooksCreative && rememberedWorkflow?.url
              ? rememberedWorkflow.url
              : undefined
    )
    const targetSiteHint = !targetUrl && requestedSite ? requestedSite.displayName : undefined
    const targetSearchQuery = !targetUrl && requestedSite ? requestedSite.searchQuery : undefined
    const siteMayNeedModeSelection = requestedSite?.id === 'jimeng' || requestedSiteHints.includes('jimeng')

    if (!targetUrl && targetSearchQuery) {
      const resolveStep = steps.find((step) => step.id === 'resolve_target_page')
      const navigateStep = steps.find((step) => step.id === 'navigate_target')
      if (resolveStep) {
        resolveStep.action = `用户只给了站点名 ${targetSiteHint}，未提供 URL；先搜索“${targetSearchQuery}”并锁定官方入口，若当前页已是该站点则优先复用当前页。`
        resolveStep.failIf = Array.from(new Set([...resolveStep.failIf, '无法通过站点搜索锁定唯一官方入口']))
      }
      if (navigateStep) {
        navigateStep.action = '确认官方入口或当前页可复用后再导航，不要在搜索结果和无关页面之间来回跳转。'
      }
    }

    if (siteMayNeedModeSelection) {
      const resolveStep = steps.find((step) => step.id === 'resolve_target_page')
      const navigateStep = steps.find((step) => step.id === 'navigate_target')
      if (resolveStep) {
        resolveStep.action = `${resolveStep.action} 若到达的是即梦落地页、模式选择页或创作导航页，先定位 Agent 模式 / 图片生成 / 视频生成 等候选控件；遇到疑似下拉或模式切换按钮时，先点击一次，再 browser_read_page 复核展开后的选项。`
        resolveStep.verify = Array.from(new Set(['已确认当前页是否只是模式选择页', ...resolveStep.verify]))
        resolveStep.failIf = Array.from(new Set([...resolveStep.failIf, '点击 1-2 个疑似模式按钮后仍无法判断正确入口']))
        resolveStep.recoverWith = Array.from(new Set(['若模式入口仍不明确，立即向用户确认要进入哪个模式', ...resolveStep.recoverWith]))
      }
      if (navigateStep) {
        navigateStep.action = `${navigateStep.action} 如果当前页还没有上传区或提示词输入区，不要立刻离开即梦；先把当前页当作候选模式入口页，检查可疑按钮是否会展开合适选项。`
      }
    }

    const expectedOutcome = decision.mode === 'browser_upload_workflow'
      ? '目标页面已挂载指定附件、提示词已进入正确输入区，并且页面已进入生成或处理状态。'
      : '目标页面已完成用户要求的网页操作。'

    return {
      taskKind,
      taskGoal: decision.mode === 'browser_upload_workflow' ? '使用当前会话中的附件，在目标网页中完成上传、填写提示词并提交生成任务。' : '根据用户指令完成网页操作，并按顺序验证结果。',
      expectedOutcome,
      resources: {
        attachments: attachmentResources,
        links,
      },
      attachmentIntent: {
        mode: decision.mode === 'browser_upload_workflow' ? (attachmentResources.length ? 'latest' : 'none') : 'none',
        attachmentId: attachmentResources[0]?.attachmentId,
        latestName: attachmentResources[0]?.name || decision.attachmentSelection?.latestName,
      },
      targetUrl,
      targetSiteHint,
      targetSearchQuery,
      promptIntent: {
        raw: decision.promptIntent?.raw || '',
        refined: decision.promptIntent?.refined || '',
        confidence: decision.promptIntent?.confidence || 'low',
        mustUse: this.resolveUsableBrowserPrompt(decision.promptIntent),
        source: decision.promptIntent?.source || 'raw',
      },
      steps,
      requiredStages: steps.map((step) => step.id),
      completionCriteria: decision.mode === 'browser_upload_workflow'
        ? [targetSearchQuery ? `已先解析目标站点：${targetSiteHint}` : '', '已检测到页面级附件证据，例如缩略图、附件 chip、文件名或素材卡片', '提示词已进入最优输入框，或页面上出现同语义文本', '页面已进入生成中、处理中、思考中或队列等待状态'].filter(Boolean)
        : [targetSearchQuery ? `已先解析目标站点：${targetSiteHint}` : '', '页面已读取并完成目标动作'].filter(Boolean),
      skipRules: decision.mode === 'browser_upload_workflow'
        ? [targetSearchQuery ? '用户只提供站点名时，先搜索官方入口；未确认前不要在无关页面跳转' : '', '检测到页面附件证据时跳过上传阶段', '检测到提示词已在输入框时跳过填写阶段', '检测到页面运行态时跳过提交阶段'].filter(Boolean)
        : [targetSearchQuery ? '用户只提供站点名时，先搜索官方入口；未确认前不要在无关页面跳转' : '', '页面状态已经满足目标时直接结束'].filter(Boolean),
      successCriteria: decision.mode === 'browser_upload_workflow'
        ? [targetSearchQuery ? '已锁定目标站点的唯一官方入口' : '', '任务图已锁定唯一目标页', '任务图已锁定唯一附件', '页面级附件证据已出现', '提示词与 mustUsePrompt 高相似', '页面进入生成中、处理中或排队状态'].filter(Boolean)
        : [targetSearchQuery ? '已锁定目标站点的唯一官方入口' : '', '当前页面状态满足用户请求'].filter(Boolean),
      failureCriteria: decision.mode === 'browser_upload_workflow'
        ? [targetSearchQuery ? '无法将站点名解析为唯一官方入口，且当前页也不可复用' : '', '无法确认目标页或可用附件', '多次上传后仍没有页面级附件证据', '无法确认 prompt 已写入', '无法确认提交已触发运行态'].filter(Boolean)
        : [targetSearchQuery ? '无法将站点名解析为唯一官方入口，且当前页也不可复用' : '', '网页状态与用户目标明显不符'].filter(Boolean),
      retryPolicy: decision.mode === 'browser_upload_workflow'
        ? '每个关键步骤有独立重试上限；只有在页面证据不足或恢复成功时才重试。'
        : '仅在当前页面证据不足时轻量重试。',
      finalCheck: {
        expectedOutcome,
        successCriteria: decision.mode === 'browser_upload_workflow'
          ? ['附件已挂载到页面', '提示词已写入', '页面进入生成或处理态']
          : ['页面已完成目标动作'],
      },
    }
  }

  promptNeedsRefinement(decision: BrowserTaskDecision, options?: { explicitSkillRequested?: boolean }): boolean {
    const promptIntent = decision.promptIntent
    if (!promptIntent?.raw.trim()) return false
    const refined = String(promptIntent.refined || '').trim()
    if (!refined) return true
    if (options?.explicitSkillRequested) return true
    if (refined.length < 8) return true
    if (this.looksLikeBrowserPromptNoise(refined)) return true
    return promptIntent.confidence === 'low'
  }

  shouldInspectAmbiguousCreativeEntry(plan?: BrowserTaskPlan): boolean {
    if (!plan || plan.taskKind !== 'upload_generate') return false
    if (plan.resources.links.length > 0) return false
    const remembered = plan.continuity?.rememberedWorkflow
    if (remembered?.uploadMounted || remembered?.promptFilled || remembered?.running) return false
    const activePage = plan.continuity?.activePage
    if (!activePage) return false
    const pageText = [activePage.title, activePage.url, activePage.heading, activePage.excerpt].filter(Boolean).join(' ')
    return this.isLikelyCreativeModeSelectionPage(pageText)
  }

  decideTask(params: {
    userText: string
    sessionMessages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
    sessionId?: string
  }): BrowserTaskDecision {
    const text = String(params.userText || '').trim()
    if (!text) return { mode: 'free_tool_loop', reason: 'empty_user_text' }

    const persistedAttachments = this.deps.getSessionAttachmentHints(params.sessionId)
    const incomingAttachments = this.deps.getIncomingAttachmentHints(text)
    const attachments = {
      count: Math.max(persistedAttachments.count, incomingAttachments.count),
      latestName: persistedAttachments.latestName || incomingAttachments.latestName,
    }
    const directPromptIntent = this.extractPromptIntent(text)
    const sessionPromptIntent = this.extractSessionPromptIntent(params.sessionMessages)
    const promptIntent = directPromptIntent?.refined
      ? directPromptIntent
      : sessionPromptIntent || { raw: '', refined: '', confidence: 'low' as const, source: 'none' as const }
    const links = this.extractLinks(text)
    const hasUploadIntent = /(上传|附件|刚发的图|这张图|图片附件|用这张图|用刚发的图)/i.test(text)
    const hasGenerationIntent = /(生成图片|生成新图|生图|图生图|文生图|做图|继续生成|开始生成)/i.test(text)
    const hasExplicitBrowserAction = /(打开|访问|进入|网页|网站|页面|浏览器|即梦|jimeng)/i.test(text)
    const hasContinuationIntent = /^(继续|接着|下一步|继续在)/i.test(text)
    const activeTab = this.deps.getActiveTab()
    const activeContext = `${activeTab?.title || ''} ${activeTab?.url || ''}`.toLowerCase()
    const activeTabLooksCreative = /(jimeng|即梦|创作|生成|image|图像)/.test(activeContext)

    if (attachments.count <= 0 && hasUploadIntent) {
      const decision: BrowserTaskDecision = {
        mode: 'clarify_first',
        reason: 'upload_intent_without_available_attachment',
        attachmentSelection: attachments,
        promptIntent,
      }
      decision.plan = this.rebuildPlan(decision, { sessionId: params.sessionId, userText: text })
      return decision
    }

    const effectiveBrowserIntent =
      (hasExplicitBrowserAction && links.length > 0) ||
      (attachments.count > 0 && (hasUploadIntent || hasGenerationIntent)) ||
      (hasContinuationIntent && activeTabLooksCreative)

    if (!effectiveBrowserIntent) return { mode: 'free_tool_loop', reason: 'no_browser_intent' }

    if (attachments.count > 0 && (hasUploadIntent || hasGenerationIntent || hasContinuationIntent)) {
      const decision: BrowserTaskDecision = {
        mode: 'browser_upload_workflow',
        reason: hasUploadIntent ? 'browser_intent_with_attachment_upload' : 'browser_intent_with_attachment_generation_context',
        attachmentSelection: attachments,
        promptIntent,
      }
      decision.plan = this.rebuildPlan(decision, { sessionId: params.sessionId, userText: text })
      return decision
    }

    const decision: BrowserTaskDecision = {
      mode: 'browser_workflow',
      reason: 'generic_browser_workflow',
      attachmentSelection: attachments.count > 0 ? attachments : undefined,
      promptIntent,
    }
    decision.plan = this.rebuildPlan(decision, { sessionId: params.sessionId, userText: text })
    return decision
  }

  async buildContinuityContext(params: {
    userText: string
    sessionId?: string
    decision: BrowserTaskDecision
  }): Promise<BrowserTaskPlanContinuity | null> {
    const activeTab = this.deps.getActiveTab()
    let activePage: BrowserTaskPlanContinuity['activePage'] | undefined
    if (activeTab?.id) {
      const context = await this.deps.getTabContext(activeTab.id)
      if (context) {
        activePage = {
          url: context.url,
          title: context.title,
          heading: context.heading,
          selection: context.selection,
          excerpt: context.excerpt,
          capturedAt: context.capturedAt,
          domain: context.domain || activeTab.domain || '',
        }
      }
    }
    const rememberedWorkflow = getBrowserWorkflowState(params.sessionId)
    const recentSkill = getLatestSkillRun(params.sessionId)
    const recentActions = getRecentBrowserActions(params.sessionId)
    const continuationIntent = /^(继续|接着|下一步|继续在)/i.test(params.userText)
    const canReuseCurrentPage = Boolean(
      activePage &&
      (continuationIntent || rememberedWorkflow?.running || rememberedWorkflow?.uploadMounted || rememberedWorkflow?.promptFilled || rememberedWorkflow?.canResume) &&
      (rememberedWorkflow ? domainsLikelyMatch(activePage.url, rememberedWorkflow.url) : true)
    )
    const forcedRules = canReuseCurrentPage
      ? ['当前活动页已匹配目标站点时，先读取并验证当前页，不要先搜索或重新打开站点。']
      : []
    if (rememberedWorkflow?.canResume && rememberedWorkflow.lastFailureReason) {
      forcedRules.push(`继续任务前先核对上次失败原因：${rememberedWorkflow.lastFailureReason}`)
    }
    return {
      canReuseCurrentPage,
      reuseReason: canReuseCurrentPage ? '当前活动页与最近浏览器任务上下文相符，优先复用当前页。' : '当前活动页与最近任务上下文关联不足。',
      activePage,
      rememberedWorkflow,
      recentSkill,
      recentActions,
      forcedRules,
    }
  }

  applyContinuityToDecision(decision: BrowserTaskDecision, continuity: BrowserTaskPlanContinuity | null): BrowserTaskDecision {
    if (!continuity || !decision.plan) return decision
    const plan = {
      ...decision.plan,
      continuity,
      targetUrl: continuity.canReuseCurrentPage && continuity.activePage ? continuity.activePage.url : decision.plan.targetUrl,
      skipRules: continuity.canReuseCurrentPage
        ? Array.from(new Set(['当前活动页已匹配目标站点时跳过重新搜索或重新打开站点', ...decision.plan.skipRules]))
        : decision.plan.skipRules,
      steps: decision.plan.steps.map((step) =>
        step.id === 'navigate_target'
          ? {
            ...step,
            skipIf: continuity.canReuseCurrentPage
              ? Array.from(new Set(['当前活动页已是目标页', ...step.skipIf]))
              : step.skipIf,
          }
          : step,
      ),
    }
    return {
      ...decision,
      reason: continuity.canReuseCurrentPage ? `${decision.reason}_reuse_current_page` : decision.reason,
      plan,
    }
  }

  buildContinuityInstruction(continuity: BrowserTaskPlanContinuity | null): string | null {
    if (!continuity) return null
    const lines = [
      '## 浏览器连续性上下文',
      continuity.activePage ? `当前活动页: ${continuity.activePage.title || '未命名页面'} | ${continuity.activePage.url}` : '当前活动页: 无',
      continuity.canReuseCurrentPage ? `复用判断: 是 — ${continuity.reuseReason}` : `复用判断: 否 — ${continuity.reuseReason}`,
      continuity.rememberedWorkflow
        ? `最近工作流: ${continuity.rememberedWorkflow.workflowKind} / ${continuity.rememberedWorkflow.stage} / ${continuity.rememberedWorkflow.url}`
        : '最近工作流: 无',
      continuity.recentSkill?.success
        ? `最近成功技能: ${continuity.recentSkill.toolName} (${continuity.recentSkill.action})`
        : '',
      continuity.recentActions.length > 0
        ? `最近高成本动作: ${continuity.recentActions.map((item) => `${item.kind}:${item.value}`).join(' | ')}`
        : '',
      '',
      '执行约束:',
      ...continuity.forcedRules.map((item, index) => `${index + 1}. ${item}`),
    ].filter(Boolean)
    return lines.length > 3 ? lines.join('\n') : null
  }

  shouldUseDeterministicRunner(decision: BrowserTaskDecision): boolean {
    if (decision.mode !== 'browser_upload_workflow') return false
    const plan = decision.plan
    if (!plan) return false
    if (!(plan.targetUrl || plan.continuity?.canReuseCurrentPage)) return false
    if (this.shouldInspectAmbiguousCreativeEntry(plan)) return false
    return true
  }

  buildToolLoopInstruction(decision: BrowserTaskDecision): string | null {
    const plan = decision.plan
    if (!plan) return null

    const stepDescriptions = (plan.steps || []).map((step, i) => {
      const lines = [
        `### 步骤 ${i + 1}: ${step.id}`,
        `目标: ${step.goal}`,
        `动作: ${step.action}`,
        `验证条件: ${step.verify.join('；')}`,
      ]
      if (step.skipIf.length > 0) lines.push(`可跳过条件: ${step.skipIf.join('；')}`)
      if (step.failIf.length > 0) lines.push(`失败条件: ${step.failIf.join('；')}`)
      if (step.retryLimit > 0) lines.push(`重试上限: ${step.retryLimit} 次`)
      return lines.join('\n')
    }).join('\n\n')

    const continuityLines = plan.continuity
      ? [
        '## 连续性上下文',
        plan.continuity.activePage
          ? `当前活动页: ${plan.continuity.activePage.title || '未命名页面'} | ${plan.continuity.activePage.url}`
          : '当前活动页: 无',
        `当前页复用: ${plan.continuity.canReuseCurrentPage ? '是' : '否'}${plan.continuity.reuseReason ? ` — ${plan.continuity.reuseReason}` : ''}`,
        plan.continuity.rememberedWorkflow
          ? `最近工作流: ${plan.continuity.rememberedWorkflow.workflowKind} / ${plan.continuity.rememberedWorkflow.stage} / ${plan.continuity.rememberedWorkflow.url}`
          : '',
        plan.continuity.recentSkill?.success
          ? `最近成功技能: ${plan.continuity.recentSkill.toolName} (${plan.continuity.recentSkill.action})`
          : '',
        ...(plan.continuity.forcedRules || []).map((rule) => `- ${rule}`),
        '',
      ].filter(Boolean)
      : []

    const shouldInspectModeEntry = this.shouldInspectAmbiguousCreativeEntry(plan)
    return [
      `## 浏览器任务执行计划`,
      ``,
      `任务类型: ${plan.taskKind}`,
      `任务目标: ${plan.taskGoal}`,
      `预期结果: ${plan.expectedOutcome}`,
      plan.targetUrl ? `目标页面: ${plan.targetUrl}` : '',
      plan.targetSiteHint ? `目标站点: ${plan.targetSiteHint}` : '',
      plan.targetSearchQuery ? `站点搜索词: ${plan.targetSearchQuery}` : '',
      plan.attachmentIntent?.latestName ? `附件: ${plan.attachmentIntent.latestName}` : '',
      plan.promptIntent?.refined ? `提示词: ${plan.promptIntent.refined}` : '',
      ``,
      ...continuityLines,
      `## 执行步骤（必须严格按顺序执行）`,
      ``,
      stepDescriptions,
      ``,
      `## 完成标准`,
      ...(plan.completionCriteria || []).map((c) => `- ${c}`),
      ``,
      `## 执行规则（强制）`,
      `1. 你必须按步骤编号顺序执行，不允许跳步`,
      `2. 每个步骤执行前，先检查"可跳过条件"——如果满足则跳过该步骤`,
      `3. 每个步骤执行前，先检查"失败条件"——如果满足则立即停止并报告失败`,
      `4. 每个步骤执行后，必须验证"验证条件"——不满足则重试（不超过重试上限）`,
      `5. 执行工具前，先用一句话说明你当前在第几步、准备做什么`,
      `6. 不要看到链接就立即 browser_navigate，必须先确认你在步骤 navigate_target`,
      `7. 如果连续性上下文判断当前页可复用，则先读取当前页，不要先搜索或重新打开站点`,
      `8. 不要在 ensure_upload 完成前执行 ensure_prompt`,
      `9. 在 ensure_prompt 里先确认当前焦点或最高置信输入区就是目标 prompt 输入区，再输入内容`,
      `10. 在没有输入锚点时，不要先点击发送/生成按钮；先重新定位输入区或让光标回到正确文本框`,
      `11. 提交时优先使用与当前输入区相邻的发送/生成控件，或复用 browser_locate_input_targets 返回的 nearby_send_targets`,
      `12. 不要点击"重新生成""再次生成"等历史记录按钮`,
      `13. 若最近状态已显示附件/提示词/运行态已就位，先验证，不要默认重复动作`,
      `14. 最后一步 final_reconcile 必须执行，用 browser_read_page 确认最终状态`,
      plan.targetSearchQuery ? `15. 当前没有直接 URL，先搜索“${plan.targetSearchQuery}”定位官方入口；若结果仍不唯一，先向用户确认，不要来回跳转。` : '',
      shouldInspectModeEntry ? '16. 如果当前页像模式选择页或带下拉的入口页，先检查 Agent 模式 / 图片生成 / 视频生成 等可疑按钮；点击一层后立即重新读页确认选项，仍不明确就直接澄清。' : '',
    ].filter(Boolean).join('\n')
  }

  buildPromptRefinementRequest(latestAttachmentName?: string): string {
    return [
      '系统任务：你正在为浏览器自动化任务提炼一个可直接提交到网页的提示词。',
      '请基于当前对话中的最后一条用户请求，只返回一个 JSON 对象，不能有任何额外文本：',
      '{"prompt":"可直接提交到网页输入框的最终提示词","confidence":"high|medium|low"}',
      '要求：',
      '1) 删除“上传、点击、发送、打开网站、浏览器、网页、按钮、附件”这类操作性描述。',
      '2) 保留用户真正想让网页处理的内容、风格、主体、画面、文案要求。',
      `3) 当前会话最新附件名：${latestAttachmentName || '无'}`,
      '4) 如果对话里已经注入技能说明、系统补充或当前页连续性上下文，必须先吸收这些约束，再提炼最终 prompt。',
      '5) 如果仍无法提炼出可提交提示词，prompt 置为空字符串，confidence 置为 low。',
      '6) 输出必须是合法 JSON。',
    ].join('\n')
  }

  parsePromptDraft(raw: string): { prompt: string; confidence: 'high' | 'medium' | 'low' } | null {
    try {
      const parsed = JSON.parse(String(raw || '')) as { prompt?: unknown; confidence?: unknown }
      const prompt = String(parsed.prompt || '').trim()
      const confidenceRaw = String(parsed.confidence || '').trim().toLowerCase()
      const confidence = confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
        ? confidenceRaw
        : 'medium'
      if (prompt.length < 4 || prompt.length > 320) return null
      if (this.looksLikeBrowserPromptNoise(prompt)) return null
      return { prompt, confidence }
    } catch {
      return null
    }
  }

  buildClarifyMessage(decision: BrowserTaskDecision): string {
    return decision.attachmentSelection?.count
      ? '当前页面任务提到了上传附件，但我还无法确定要用哪一个附件。请补充附件名称，或直接说“用最新那张图”。'
      : '当前页面任务提到了上传附件，但当前会话里还没有可用附件。请先把图片或文件发到当前会话，再让我继续。'
  }

  getRecommendedMaxToolIterations(userText: string, decision: BrowserTaskDecision | undefined, base: number): number {
    const browserHeavyTask = /(浏览器|网页|web|search|navigate|点击|输入|发送|下载|图片|pinterest|kimi|gemini|然后|再去|并且)/i.test(userText)
    if (decision?.mode === 'browser_upload_workflow') {
      return Math.min(40, Math.max(16, Math.min(base, 24)))
    }
    if (decision?.mode === 'browser_workflow') {
      return Math.min(80, Math.max(base, 44))
    }
    if (!browserHeavyTask) return base
    return Math.min(80, Math.max(base, 36))
  }
}
