export type DocumentWidgetFamily =
  | 'stats_card'
  | 'bar_chart'
  | 'line_chart'
  | 'weekly_focus_chart'
  | 'tab_info_block'
  | 'mini_calculator'
  | 'flow_diagram'
  | null

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

function inferWidgetFamily(userText: string): DocumentWidgetFamily {
  if (/(本周|下周|周报|周计划|weekly|week)/i.test(userText)) return 'weekly_focus_chart'
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
        titleHint: 'stats_summary_card',
        implementationHint: 'SVG',
        guidanceBullets: [
          '只放 3-4 个核心指标，横向均分。',
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
