import {
  buildDocumentWidgetOpenUIRulesSnippet as buildOpenUIRulesFromCatalog,
  type DocumentWidgetComponentName,
} from '../../../shared/document-widget-openui'
import {
  WIDGET_SKELETONS,
  WIDGET_SKELETON_IDS,
  WIDGET_SIZE_IDS,
  findSkeletonForTriggerKeyword,
  widgetSkeletonRequiresTriggerKeyword,
  type WidgetSkeletonId,
} from '../../../shared/document-widget-skeletons'

export type DocumentWidgetFamily = DocumentWidgetComponentName | null

export type DocumentWidgetStyle =
  | 'warm_minimal'
  | 'editorial'
  | 'dashboard'
  | 'notebook'
  | 'bold_data'
  | 'academic'
  | null

export interface DocumentWidgetProfile {
  family: DocumentWidgetFamily
  style: DocumentWidgetStyle
  interactionHint: string | null
  titleHint: string | null
  implementationHint: string | null
  guidanceBullets: string[]
}

function looksLikeGenericWidgetAsk(userText: string): boolean {
  return /(图表|可视化|widget|show-widget|生成式\s*ui|数据图|趋势图|卡片组件|信息卡|表格|提示块|对比卡|进度卡|日程卡|待办|习惯|计划板)/i.test(userText)
}

function inferWidgetFamily(userText: string): DocumentWidgetFamily {
  if (/(信息卡|摘要卡|推荐卡|结论卡|summary card|info card)/i.test(userText)) return 'info_card'
  if (/(提示块|提醒块|告警块|callout|提醒卡|风险提示|结论提示)/i.test(userText)) return 'callout_block'
  if (/(表格|清单表|数据表|table|对照表|明细表)/i.test(userText)) return 'data_table'
  if (/(对比卡|对比表|comparison grid|对照卡)/i.test(userText)) return 'comparison_grid'
  if (/(进度|完成率|完成进展|progress|阶段状态)/i.test(userText)) return 'progress_snapshot'
  if (/(今天的?(日程|安排)卡?|今日(日程|安排)|单日(日程|安排)|day schedule|today schedule)/i.test(userText)) return 'day_schedule_card'
  if (/(周日程|本周安排|一周安排|week schedule)/i.test(userText)) return 'week_schedule_card'
  if (/(时间分配|时间投入|time allocation|时间占比)/i.test(userText)) return 'time_allocation_chart'
  if (/(自动计划|定时任务|schedule runtime|cron)/i.test(userText)) return 'schedule_runtime_card'
  if (/(待办|todo|任务清单|task list)/i.test(userText)) return 'todo_list_manual'
  if (/(习惯|habit|streak|连续记录)/i.test(userText)) return 'habit_streak_manual'
  if (/(今日重点|today focus|重点摘要)/i.test(userText)) return 'today_focus_snapshot'
  if (/(本周|下周|周报|周计划|weekly|week)/i.test(userText)) return 'weekly_focus_chart'
  if (/(周计划板|计划板|kanban|board)/i.test(userText)) return 'weekly_plan_board_manual'
  if (/(评分|打分|计算器|预算|估算|score|calculator|estimate|budget)/i.test(userText)) return 'mini_calculator'
  if (/(流程|步骤|架构图|关系图|flow|diagram|pipeline)/i.test(userText)) return 'flow_diagram'
  if (/(科研绘图|研究结果|实验结果|investment trend|投资趋向|数据动态|动态变化|走势分析)/i.test(userText)) return 'line_chart'
  if (/(趋势|折线|line chart|time series|走势)/i.test(userText)) return 'line_chart'
  if (/(柱状|条形|分类对比|bar chart|compare|comparison)/i.test(userText)) return 'bar_chart'
  if (/(切换卡|tab|标签切换|状态块|分组信息)/i.test(userText)) return 'tab_info_block'
  if (/(统计卡|指标卡|kpi|summary card|stats card|指标)/i.test(userText)) return 'stats_card'
  return null
}

function inferWidgetStyle(userText: string): DocumentWidgetStyle {
  if (/(米白|奶油|暖色|温和|柔和|warm|minimal|淡米|浅米)/i.test(userText)) return 'warm_minimal'
  if (/(研究|学术|论文|academic|research|科研绘图|实验结果)/i.test(userText)) return 'academic'
  if (/(笔记|notebook|文稿|卡片笔记)/i.test(userText)) return 'notebook'
  if (/(周报|dashboard|仪表盘|数据面板|saas|投资趋向|行情|趋势面板)/i.test(userText)) return 'dashboard'
  if (/(杂志|editorial|海报感|封面感)/i.test(userText)) return 'editorial'
  if (/(高对比|科技感|bold|炫酷|霓虹|数据动态)/i.test(userText)) return 'bold_data'
  return null
}

function buildFamilyGuidance(family: DocumentWidgetFamily): {
  interactionHint: string | null
  titleHint: string | null
  implementationHint: string | null
  guidanceBullets: string[]
} {
  switch (family) {
    case 'info_card':
      return {
        interactionHint: '单卡信息摘要',
        titleHint: 'info_card',
        implementationHint: 'HTML + CSS',
        guidanceBullets: [
          '适合摘要、推荐、重点说明，不要再扩成多列面板。',
          '正文要短，优先一句结论加少量补充点。',
        ],
      }
    case 'callout_block':
      return {
        interactionHint: '提示 / 风险 / 建议块',
        titleHint: 'callout_block',
        implementationHint: 'HTML + CSS',
        guidanceBullets: [
          '用清晰语气区分提示、风险、建议，不要混成杂乱信息卡。',
          '优先单卡表达，必要时再附 2-4 个要点。',
        ],
      }
    case 'data_table':
      return {
        interactionHint: '结构化小表格',
        titleHint: 'data_table',
        implementationHint: 'HTML table',
        guidanceBullets: [
          '列数控制在 2-6 列，避免过宽。',
          '优先明细和对照，不做复杂表头联动。',
        ],
      }
    case 'comparison_grid':
      return {
        interactionHint: '2-4 列对比',
        titleHint: 'comparison_grid',
        implementationHint: 'HTML + CSS',
        guidanceBullets: [
          '对比列不超过 4 个。',
          '每列只保留最关键的差异点。',
        ],
      }
    case 'progress_snapshot':
      return {
        interactionHint: '进度概览',
        titleHint: 'progress_snapshot',
        implementationHint: 'HTML + CSS',
        guidanceBullets: [
          '优先 3-6 条进度项。',
          '明确显示数值或完成比例。',
        ],
      }
    case 'weekly_focus_chart':
      return {
        interactionHint: '本周 / 下周 双态切换',
        titleHint: 'weekly_focus_chart',
        implementationHint: 'HTML + CSS + minimal inline script',
        guidanceBullets: [
          '只做单卡片，不要拆成多面板小应用。',
          '顶部保留本周 / 下周双标签切换，每个标签只放 3-5 个重点项。',
          '限制内容高度，避免切换后卡片无限延长。',
        ],
      }
    case 'mini_calculator':
      return {
        interactionHint: '本地输入 -> 本地计算',
        titleHint: 'score_calculator',
        implementationHint: 'HTML + CSS + inline script',
        guidanceBullets: [
          '输入框如果声明了 min/max，要让显示和计算都遵守范围。',
          '禁止 fetch、form submit、外部状态依赖。',
        ],
      }
    case 'flow_diagram':
      return {
        interactionHint: '静态图解或少量节点点击',
        titleHint: 'note_flow_diagram',
        implementationHint: 'SVG',
        guidanceBullets: [
          '优先单个 SVG，保证结构完整，不要只输出背景壳。',
          '节点和连线密度适中，优先清晰层级而不是装饰。',
        ],
      }
    case 'bar_chart':
      return {
        interactionHint: '分类对比，可选轻量切换',
        titleHint: 'category_bar_chart',
        implementationHint: 'Chart.js 或 SVG',
        guidanceBullets: [
          '分类控制在 4-6 个以内，避免标签拥挤。',
          '如果有切换按钮，保持一组简单状态切换，不做复杂联动。',
        ],
      }
    case 'line_chart':
      return {
        interactionHint: '趋势追踪',
        titleHint: 'trend_line_chart',
        implementationHint: 'Chart.js 或 SVG polyline',
        guidanceBullets: [
          '强调趋势和关键拐点，不要塞太多序列。',
          '适合科研绘图、投资趋向、数据动态这类高频需求。',
        ],
      }
    case 'tab_info_block':
      return {
        interactionHint: '分组信息切换',
        titleHint: 'tab_info_block',
        implementationHint: 'HTML + CSS + minimal inline script',
        guidanceBullets: [
          '切换标签数控制在 2-4 个。',
          '标签切换后只更新内容区，不做整卡重绘动画。',
        ],
      }
    case 'stats_card':
      return {
        interactionHint: '静态指标概览',
        titleHint: 'stats_card',
        implementationHint: 'SVG',
        guidanceBullets: [
          '只放 3-4 个核心指标，横向均分。',
        ],
      }
    case 'day_schedule_card':
      return {
        interactionHint: '单日日程快照',
        titleHint: 'day_schedule_card',
        implementationHint: 'HTML + CSS + minimal inline script',
        guidanceBullets: [
          '优先展示时间、标题、来源标签。',
          '操作按钮应复用现有日历入口，而不是另造编辑器。',
        ],
      }
    case 'week_schedule_card':
      return {
        interactionHint: '周视角日程概览',
        titleHint: 'week_schedule_card',
        implementationHint: 'HTML + CSS + minimal inline script',
        guidanceBullets: [
          '按天分组展示，避免做复杂周历。',
          '保留跳到现有日历的入口。',
        ],
      }
    case 'time_allocation_chart':
      return {
        interactionHint: '时间分配可视化',
        titleHint: 'time_allocation_chart',
        implementationHint: 'SVG',
        guidanceBullets: [
          '更适合聚合分配，不要做深度钻取。',
          '优先按来源或类型做 3-6 段统计。',
        ],
      }
    case 'schedule_runtime_card':
      return {
        interactionHint: '自动计划状态概览',
        titleHint: 'schedule_runtime_card',
        implementationHint: 'HTML + CSS',
        guidanceBullets: [
          '展示启用状态、下次运行、最近运行即可。',
          '操作按钮复用现有计划入口。',
        ],
      }
    case 'todo_list_manual':
      return {
        interactionHint: '本地勾选待办',
        titleHint: 'todo_list_manual',
        implementationHint: 'HTML + CSS + inline script',
        guidanceBullets: [
          '先做文档内手填版，不依赖全局待办数据层。',
          '勾选状态应在组件内本地变化。',
        ],
      }
    case 'weekly_plan_board_manual':
      return {
        interactionHint: '手填周计划板',
        titleHint: 'weekly_plan_board_manual',
        implementationHint: 'HTML + CSS',
        guidanceBullets: [
          '用 2-4 列板块表达本周计划。',
          '保持轻量，不做完整看板应用。',
        ],
      }
    case 'habit_streak_manual':
      return {
        interactionHint: '手填习惯连续记录',
        titleHint: 'habit_streak_manual',
        implementationHint: 'HTML + CSS',
        guidanceBullets: [
          '优先展示连续天数和最近一周状态。',
          '不接全局习惯数据层。',
        ],
      }
    case 'today_focus_snapshot':
      return {
        interactionHint: '今日重点摘要',
        titleHint: 'today_focus_snapshot',
        implementationHint: 'HTML + CSS',
        guidanceBullets: [
          '适合把今日亮点和关键数字合在一个摘要卡里。',
          '优先单卡片，避免扩成复杂仪表盘。',
        ],
      }
    default:
      return {
        interactionHint: null,
        titleHint: null,
        implementationHint: null,
        guidanceBullets: [],
      }
  }
}

function buildStyleGuidance(style: DocumentWidgetStyle): string[] {
  switch (style) {
    case 'warm_minimal':
      return ['使用米白 / 奶油色背景、柔和描边和低饱和点缀色。']
    case 'dashboard':
      return ['视觉上更像周报/仪表盘，信息密度高但结构必须稳定。']
    case 'notebook':
      return ['保留文稿感和笔记卡片感，减少过重的图表装饰。']
    case 'editorial':
      return ['强调版式、留白和标题层级，适合更有设计感的说明图。']
    case 'bold_data':
      return ['允许更高对比度和更明显的强调色，但保持可读性优先。']
    case 'academic':
      return ['偏研究/论文表达，颜色克制，标签和注释更清晰。']
    default:
      return []
  }
}

export function inferDocumentWidgetProfile(userText: string): DocumentWidgetProfile | null {
  const family = inferWidgetFamily(userText)
  if (!family) return null

  const style = inferWidgetStyle(userText)
  const familyGuidance = buildFamilyGuidance(family)

  return {
    family,
    style,
    interactionHint: familyGuidance.interactionHint,
    titleHint: familyGuidance.titleHint,
    implementationHint: familyGuidance.implementationHint,
    guidanceBullets: [
      ...familyGuidance.guidanceBullets,
      ...buildStyleGuidance(style),
    ],
  }
}

export function buildDocumentWidgetClarificationSnippet(userText: string): string {
  if (!looksLikeGenericWidgetAsk(userText)) return ''
  const profile = inferDocumentWidgetProfile(userText)
  if (profile) return ''

  return [
    '## Widget 澄清建议',
    '- 如果用户还没说明清楚，优先追问 1 个最关键问题，不要一次追问太多。',
    '- 推荐优先澄清：这是信息卡、表格、趋势图、柱状图，还是日程/待办类组件？',
    '- 如果图表类型还不清楚，可给出 3 个简短选项：折线趋势 / 柱状对比 / 流程图。',
    '- 如果是个性化组件，可再追问：要读真实日历/计划数据，还是只做文档内手填版？',
  ].join('\n')
}

export function buildDocumentWidgetOpenUIRulesSnippet(): string {
  return buildOpenUIRulesFromCatalog()
}

export function inferWidgetSkeletonId(userText: string): WidgetSkeletonId | null {
  return findSkeletonForTriggerKeyword(userText)
}

export function buildDocumentWidgetSkeletonRulesSnippet(): string {
  const lines: string[] = []
  lines.push('## Widget 骨架规则 (v0.1)')
  lines.push('- 优先使用 9 个骨架之一；自由构图（freeform_static/freeform_interactive）仅在用户消息命中触发关键词时使用。')
  lines.push(`- 支持尺寸：${WIDGET_SIZE_IDS.join(' / ')}。A4 仅用于打印/导出 PDF；landscape_4_3 用于横版报表。`)
  lines.push('- background_mode 是跨骨架维度：opaque 默认带外框，transparent 去掉外框方便无痕嵌入文档。')
  lines.push('- freeform_interactive 必须声明 supports_animation=true，其他骨架不允许带动画脚本。')
  lines.push('')
  lines.push('### 骨架清单')
  for (const id of WIDGET_SKELETON_IDS) {
    const def = WIDGET_SKELETONS[id]
    const trigger = widgetSkeletonRequiresTriggerKeyword(id) && def.triggerKeywords
      ? `（触发关键词：${def.triggerKeywords.join(' / ')}）`
      : ''
    lines.push(`- ${id}：${def.displayName} — ${def.description}${trigger}`)
  }
  return lines.join('\n')
}

export function buildDocumentWidgetGuidanceSnippet(profile: DocumentWidgetProfile | null): string {
  if (!profile) return ''

  const lines = [
    '## Widget 基线建议',
    `- family: ${profile.family}`,
    profile.titleHint ? `- title hint: ${profile.titleHint}` : null,
    profile.implementationHint ? `- implementation: ${profile.implementationHint}` : null,
    profile.interactionHint ? `- interaction: ${profile.interactionHint}` : null,
    profile.style ? `- style: ${profile.style}` : null,
    ...profile.guidanceBullets.map((item) => `- ${item}`),
  ].filter(Boolean)

  return lines.join('\n')
}
