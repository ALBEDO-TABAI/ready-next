import {
  applyColorIntentToPalette,
  coerceDesignLayoutDigest,
  extractDesignSemanticControls,
  getDefaultSectionCountForRatio,
  getDesignRatioProfile,
  getDimensionsForDesignRatio,
  inferDesignRatioFromDimensions,
  inferDesignPlatformFromText,
  parseDesignRatioFromText,
  type DesignBoardPlan,
  type DesignBrief,
  type DesignCompositionFamily,
  type DesignContentSection,
  type DesignConstraintFlags,
  type DesignExecutionProgram,
  type DesignIntentPlan,
  type DesignLayoutBudget,
  type DesignLayoutBlueprint,
  type DesignLayoutStrategyPlan,
  type DesignLayoutDigest,
  type DesignPalette,
  type DesignPlacementStrategy,
  type DesignPlatform,
  type DesignRatio,
  type DesignSceneNode,
  type DesignScenePlan,
  type DesignSceneRegion,
  type DesignSemanticControls,
  type DesignStyleSystem,
  type DesignStyleGuide,
  type DesignTypographyPlan,
} from '../../../shared/design-agent'

export interface DesignPlannerResult {
  plan: DesignIntentPlan
  confidence: 'high' | 'medium' | 'low'
  signals: string[]
  instructionText: string
}

const CHINESE_NUMERAL_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
}

const PALETTES: Record<string, DesignPalette> = {
  'warm-editorial': {
    name: 'warm-editorial',
    background: '#FDF6F0',
    surface: '#FFF9F4',
    primaryText: '#2C2C2C',
    secondaryText: '#8C7B6B',
    accent: '#D4A574',
    accentSoft: '#E8D5C4',
  },
  'github-dark': {
    name: 'github-dark',
    background: '#0D1117',
    surface: '#161B22',
    primaryText: '#E6EDF3',
    secondaryText: '#8B949E',
    accent: '#2F81F7',
    accentSoft: '#1F2937',
  },
  'clean-neutral': {
    name: 'clean-neutral',
    background: '#F8FAFC',
    surface: '#FFFFFF',
    primaryText: '#111827',
    secondaryText: '#6B7280',
    accent: '#2563EB',
    accentSoft: '#DBEAFE',
  },
}

interface DesignSignalProfile {
  rawText: string
  prefersCenter: boolean
  prefersMinimal: boolean
  prefersDense: boolean
  prefersLargeElements: boolean
  prefersSparseContent: boolean
  prefersSideMeta: boolean
  prefersContrastAccent: boolean
  prefersQuietFooter: boolean
  prefersButtons: boolean
  avoidsButtons: boolean
  prefersOutline: boolean
  prefersRail: boolean
  prefersWarm: boolean
  prefersDark: boolean
  prefersPoster: boolean
  prefersEditorial: boolean
  prefersCards: boolean
  prefersCorners: boolean
  prefersGrid: boolean
  prefersSplit: boolean
  prefersAsymmetry: boolean
  requestsDifferentVersion: boolean
  avoidsWideDivider: boolean
}

function readDesignSignalProfile(text: string): DesignSignalProfile {
  const rawText = text.trim()
  const avoidsButtons = /(不要按钮|无按钮|不要cta|不要 button|no button|去掉按钮|别做按钮|不需要.*按钮|无需.*按钮|不用.*按钮)/i.test(rawText)
  const avoidsWideDivider = /(不要粗线|不要底部线|不要分割线|no divider|去掉粗线|别做粗线)/i.test(rawText)
  return {
    rawText,
    prefersCenter: /(居中|中心|center|封面感|海报感|poster)/i.test(rawText),
    prefersMinimal: /(极简|minimal|留白|airy|简洁|克制)/i.test(rawText),
    prefersDense: /(密集|高密度|dense|信息量大|步骤|清单|列表感)/i.test(rawText),
    prefersLargeElements: /(字要更大|标题更大|元素更大|更显著|更醒目|放大一点|大一点)/i.test(rawText),
    prefersSparseContent: /(信息更少|更少信息|少一点信息|只保留|只有标题|只有主标题|只有标题和|只要标题)/i.test(rawText),
    prefersSideMeta: /(标题旁边|标题右侧|标题边上|旁边的附加信息|side info)/i.test(rawText),
    prefersContrastAccent: /(对色|撞色|对比色|contrast accent|加一点对色|补一点对色)/i.test(rawText),
    prefersQuietFooter: /(底部轻一点|底部更轻|弱化底部|footer light|底部轻一些)/i.test(rawText),
    prefersButtons: !avoidsButtons && /(按钮|cta|button|call to action|操作按钮)/i.test(rawText),
    avoidsButtons,
    prefersOutline: /(outline|描边|边框|线框)/i.test(rawText),
    prefersRail: /(轨道|rail|侧栏|导轨|栏目线)/i.test(rawText),
    prefersWarm: /(暖色|奶油|柔和|小红书|米色|编辑感)/i.test(rawText),
    prefersDark: /(黑灰|黑色|深色|github|技术|dark)/i.test(rawText),
    prefersPoster: /(封面|海报|poster|首图)/i.test(rawText),
    prefersEditorial: /(杂志|editorial|编辑感|排版感)/i.test(rawText),
    prefersCards: /(卡片|card|模块卡)/i.test(rawText),
    prefersCorners: /(角标|corner|贴角)/i.test(rawText),
    prefersGrid: /(网格|grid|矩阵|tile|宫格|卡片墙)/i.test(rawText),
    prefersSplit: /(左右|分栏|split|对开|双栏)/i.test(rawText),
    prefersAsymmetry: /(错位|stagger|不对称|非对称|节奏变化)/i.test(rawText),
    requestsDifferentVersion: /(不同版式|不同方向|另一版|第二版|第二个版本|再出一版|换个方向|另一种构图|different layout|different version|variation)/i.test(rawText),
    avoidsWideDivider,
  }
}

function pickAlternativeSkeleton(
  skeleton: DesignLayoutBlueprint['skeleton'],
  ratio: DesignRatio,
  sectionCount: number,
  signals: DesignSignalProfile,
): DesignLayoutBlueprint['skeleton'] {
  const profile = getDesignRatioProfile(ratio)
  const candidates: DesignLayoutBlueprint['skeleton'][] =
    profile === 'landscape'
      ? ['split', 'grid', 'poster', 'staggered']
      : sectionCount >= 4
        ? ['staggered', 'poster', 'column', 'grid']
        : ['poster', 'staggered', 'grid', 'column']

  if (signals.prefersMinimal) {
    return candidates.find((candidate) => candidate !== skeleton && candidate !== 'split') || skeleton
  }
  if (signals.prefersAsymmetry || signals.prefersEditorial) {
    return candidates.find((candidate) => candidate !== skeleton && (candidate === 'staggered' || candidate === 'poster')) || skeleton
  }
  if (signals.prefersGrid || signals.prefersCards) {
    return candidates.find((candidate) => candidate !== skeleton && candidate === 'grid') || skeleton
  }
  return candidates.find((candidate) => candidate !== skeleton) || skeleton
}

function buildScenePlanId(params: {
  platform: DesignPlatform
  ratio: DesignRatio
  palette: DesignPalette
  layoutBlueprint: DesignLayoutBlueprint
  styleGuide: DesignStyleGuide
}): string {
  return [
    'scene',
    params.platform,
    params.ratio,
    params.palette.name,
    params.layoutBlueprint.skeleton,
    params.layoutBlueprint.sectionFlow,
    params.layoutBlueprint.sectionEmphasis,
    params.layoutBlueprint.emphasisPlacement,
    params.layoutBlueprint.footerStyle,
    params.styleGuide.ornament,
    params.styleGuide.ctaWeight,
    `tw${Math.round(params.layoutBlueprint.titleWidthRatio * 100)}`,
    `tz${Math.round(params.layoutBlueprint.titleZoneRatio * 100)}`,
  ].join('-')
}

function hasExplicitRatio(text: string): boolean {
  return /(9[:：/ ]16|16[:：/ ]9|3[:：/ ]4|4[:：/ ]3|1[:：/ ]1|四比三|竖向|竖版|横向|横版|正方形|方形|比例)/i.test(text)
}

function hasExplicitPlatform(text: string): boolean {
  return /(小红书|xiaohongshu)/i.test(text)
}

function hasExplicitSectionCount(text: string): boolean {
  return /(\d+\s*组|[一二两三四五六]\s*组|双栏|两组|二组)/.test(text)
}

function pickRatio(primaryInstruction: string, fullText: string, digest: DesignLayoutDigest | null): DesignRatio {
  if (hasExplicitRatio(primaryInstruction)) return parseDesignRatioFromText(primaryInstruction, '9:16')
  if (hasExplicitRatio(fullText)) return parseDesignRatioFromText(fullText, '9:16')
  if (digest?.mainBounds?.w && digest?.mainBounds?.h) {
    return inferDesignRatioFromDimensions(digest.mainBounds.w, digest.mainBounds.h, '9:16')
  }
  return '9:16'
}

function pickPlatform(text: string): DesignPlatform {
  return inferDesignPlatformFromText(text, 'generic')
}

function parseSectionCount(text: string): number {
  const arabic = text.match(/(\d+)\s*组/)
  if (arabic) return Math.max(1, Math.min(6, Number(arabic[1])))
  const chinese = text.match(/([一二两三四五六])\s*组/)
  if (chinese) return CHINESE_NUMERAL_MAP[chinese[1]] || 4
  if (/(双栏|两组|二组)/.test(text)) return 2
  if (/(只有标题和标题旁边的附加信息|只有标题和旁边的附加信息|标题旁边的附加信息|只要标题和附加信息)/i.test(text)) return 1
  if (/(只有标题和子标题[、,，/ ]*账号名|只有标题和子标题、账号名三个信息)/i.test(text)) return 3
  return 4
}

function resolveSectionCount(
  text: string,
  ratio: DesignRatio,
  controls: DesignSemanticControls,
): number {
  if (hasExplicitSectionCount(text)) return parseSectionCount(text)
  if (controls.prefersSideMeta) return 1
  if (controls.prefersSparseContent) {
    return getDesignRatioProfile(ratio) === 'landscape' ? 2 : 1
  }
  return getDefaultSectionCountForRatio(ratio)
}

function extractThemeKeywords(text: string, signals: DesignSignalProfile): string[] {
  const keywords = [
    '小红书',
    'Github',
    '技术',
    '黑灰',
    '按钮',
    '暖色',
    '杂志感',
    '现代',
    '极简',
    '封面',
    '排版',
    'CTA',
    '极简',
    '描边',
    '留白',
    '海报感',
    '不同版式',
  ]
  const matches = keywords.filter((keyword) => new RegExp(keyword, 'i').test(text))
  if (signals.prefersMinimal) matches.push('极简')
  if (signals.prefersOutline) matches.push('描边')
  if (signals.prefersEditorial) matches.push('编辑感')
  if (signals.requestsDifferentVersion) matches.push('不同版式')
  return Array.from(new Set(matches)).slice(0, 8)
}

function pickPalette(text: string, platform: DesignPlatform, signals: DesignSignalProfile): DesignPalette {
  const basePalette =
    signals.prefersDark || /(github|黑灰|深色|技术)/i.test(text)
      ? PALETTES['github-dark']
      : platform === 'xiaohongshu' || signals.prefersWarm || /(暖色|奶油|杂志感|柔和)/i.test(text)
        ? PALETTES['warm-editorial']
        : PALETTES['clean-neutral']
  return applyColorIntentToPalette(basePalette, text)
}

function pickTone(text: string, palette: DesignPalette, signals: DesignSignalProfile): string {
  if (palette.name === 'github-dark') return 'technical-precise'
  if (signals.prefersEditorial || /(杂志|编辑|editorial)/i.test(text)) return 'editorial-warm'
  if (signals.prefersMinimal || /(极简|minimal)/i.test(text)) return 'minimal-clean'
  return 'clear-conversion'
}

function pickAudience(text: string, platform: DesignPlatform): string {
  if (/(技术|开发|github)/i.test(text)) return '技术读者'
  if (platform === 'youtube') return '视频平台浏览用户'
  if (platform === 'xiaohongshu') return '小红书内容浏览用户'
  return '泛内容消费用户'
}

function pickCompositionFamily(
  text: string,
  sectionCount: number,
  palette: DesignPalette,
  signals: DesignSignalProfile,
): DesignCompositionFamily {
  let family: DesignCompositionFamily

  if (signals.prefersSplit || signals.prefersButtons) {
    family = 'split-feature'
  } else if ((signals.prefersSideMeta || signals.prefersSparseContent) && sectionCount <= 2) {
    family = 'editorial-stack'
  } else if ((signals.prefersEditorial || signals.prefersCenter || signals.prefersMinimal) && sectionCount <= 3) {
    family = 'editorial-stack'
  } else if (signals.prefersDense || sectionCount >= 4) {
    family = 'numbered-list'
  } else if (palette.name === 'github-dark' && sectionCount <= 3) {
    family = signals.prefersCards || signals.prefersGrid ? 'numbered-list' : 'editorial-stack'
  } else if (/(杂志感|编辑感|editorial|封面主标题|大标题)/i.test(text) && sectionCount <= 3) {
    family = 'editorial-stack'
  } else {
    family = sectionCount >= 3 ? 'numbered-list' : 'editorial-stack'
  }

  if (signals.requestsDifferentVersion && !signals.prefersSplit && !signals.prefersButtons) {
    if (family === 'split-feature') return sectionCount >= 4 ? 'numbered-list' : 'editorial-stack'
    if (family === 'editorial-stack') return sectionCount >= 4 ? 'numbered-list' : 'split-feature'
    return signals.prefersDark ? 'editorial-stack' : 'split-feature'
  }

  return family
}

function pickPlacementStrategy(digest: DesignLayoutDigest | null): DesignPlacementStrategy {
  if (!digest || !digest.mainBounds || digest.topLevelElementCount === 0) return 'viewport-origin'
  if (digest.mainBounds.w >= digest.mainBounds.h) return 'auto-right'
  return 'auto-below'
}

function buildSections(
  compositionFamily: DesignCompositionFamily,
  sectionCount: number,
  palette: DesignPalette,
): DesignContentSection[] {
  const base = palette.name === 'github-dark'
    ? [
      { title: '核心结论', body: '一句话放结果、能力或判断。', kind: 'headline' as const },
      { title: '关键证明', body: '放步骤、数据、对比或实现方式。', kind: 'proof' as const },
      { title: '补充说明', body: '填限制条件、场景、适用对象。', kind: 'supporting' as const },
      { title: '行动提示', body: '用下一步动作、版本信息或轻量备注收口。', kind: 'cta' as const },
    ]
    : compositionFamily === 'numbered-list'
      ? [
        { title: '主题标签', body: '先交代赛道、人群、场景或问题。', kind: 'numbered-item' as const },
        { title: '核心利益点', body: '一句话说清结果、方法或反差。', kind: 'numbered-item' as const },
        { title: '证明与补充', body: '填案例、数据、步骤或时间成本。', kind: 'numbered-item' as const },
        { title: '行动提示', body: '用 CTA、日期或系列标识收口。', kind: 'numbered-item' as const },
      ]
      : [
        { title: '主标题信息', body: '大标题区域承载最重要的反差或结果。', kind: 'headline' as const },
        { title: '辅助解释', body: '补充副标题、场景、受众或说明。', kind: 'supporting' as const },
        { title: '证明信息', body: '放数字、案例、步骤或证据。', kind: 'proof' as const },
        { title: '行动提示', body: '底部补 CTA 或替换备注。', kind: 'cta' as const },
      ]

  return base.slice(0, sectionCount).map((item, index) => ({
    id: `section-${index + 1}`,
    kind: item.kind,
    title: item.title,
    body: item.body,
  }))
}

function buildBoardPlan(ratio: DesignRatio): DesignBoardPlan {
  const dimensions = getDimensionsForDesignRatio(ratio)
  const profile = getDesignRatioProfile(ratio)
  if (profile === 'landscape') {
    return {
      width: dimensions.width,
      height: dimensions.height,
      paddingX: 42,
      paddingTop: 30,
      paddingBottom: 26,
      cornerRadius: 24,
    }
  }
  if (ratio === '3:4') {
    return {
      width: dimensions.width,
      height: dimensions.height,
      paddingX: 36,
      paddingTop: 38,
      paddingBottom: 30,
      cornerRadius: 26,
    }
  }
  if (ratio === '1:1') {
    return {
      width: dimensions.width,
      height: dimensions.height,
      paddingX: 34,
      paddingTop: 34,
      paddingBottom: 28,
      cornerRadius: 24,
    }
  }
  return {
    width: dimensions.width,
    height: dimensions.height,
    paddingX: 40,
    paddingTop: 48,
    paddingBottom: 36,
    cornerRadius: 32,
  }
}

function buildTypographyPlan(
  ratio: DesignRatio,
  compositionFamily: DesignCompositionFamily,
  palette: DesignPalette,
  semanticControls: DesignSemanticControls,
): DesignTypographyPlan {
  const profile = getDesignRatioProfile(ratio)
  const base = palette.name === 'github-dark'
    ? profile === 'landscape'
      ? {
        titleFontSize: 28,
        titleLineHeight: 34,
        subtitleFontSize: 13,
        subtitleLineHeight: 18,
        sectionTitleFontSize: 14,
        sectionBodyFontSize: 11,
        sectionLineHeight: 17,
        badgeFontSize: 11,
        footerFontSize: 10,
      }
      : ratio === '3:4'
      ? {
        titleFontSize: 31,
        titleLineHeight: 38,
        subtitleFontSize: 14,
        subtitleLineHeight: 20,
        sectionTitleFontSize: 15,
        sectionBodyFontSize: 12,
        sectionLineHeight: 19,
        badgeFontSize: 12,
        footerFontSize: 11,
      }
      : {
        titleFontSize: 33,
        titleLineHeight: 40,
        subtitleFontSize: 14,
        subtitleLineHeight: 21,
        sectionTitleFontSize: 15,
        sectionBodyFontSize: 12,
        sectionLineHeight: 19,
        badgeFontSize: 12,
        footerFontSize: 11,
      }
    : compositionFamily === 'editorial-stack'
    ? profile === 'landscape'
      ? {
        titleFontSize: 27,
        titleLineHeight: 33,
        subtitleFontSize: 13,
        subtitleLineHeight: 19,
        sectionTitleFontSize: 15,
        sectionBodyFontSize: 11,
        sectionLineHeight: 18,
        badgeFontSize: 11,
        footerFontSize: 10,
      }
      : ratio === '9:16'
      ? {
        titleFontSize: 36,
        titleLineHeight: 43,
        subtitleFontSize: 15,
        subtitleLineHeight: 22,
        sectionTitleFontSize: 17,
        sectionBodyFontSize: 13,
        sectionLineHeight: 21,
        badgeFontSize: 12,
        footerFontSize: 11,
      }
      : {
        titleFontSize: 30,
        titleLineHeight: 37,
        subtitleFontSize: 14,
        subtitleLineHeight: 21,
        sectionTitleFontSize: 16,
        sectionBodyFontSize: 12,
        sectionLineHeight: 19,
        badgeFontSize: 12,
        footerFontSize: 11,
      }
    : profile === 'landscape'
    ? {
      titleFontSize: 28,
      titleLineHeight: 34,
      subtitleFontSize: 13,
      subtitleLineHeight: 19,
      sectionTitleFontSize: 14,
      sectionBodyFontSize: 11,
      sectionLineHeight: 18,
      badgeFontSize: 11,
      footerFontSize: 10,
    }
    : ratio === '9:16'
    ? {
      titleFontSize: 35,
      titleLineHeight: 42,
      subtitleFontSize: 15,
      subtitleLineHeight: 22,
      sectionTitleFontSize: 16,
      sectionBodyFontSize: 13,
      sectionLineHeight: 20,
      badgeFontSize: 12,
      footerFontSize: 11,
    }
    : {
      titleFontSize: 29,
      titleLineHeight: 36,
      subtitleFontSize: 14,
      subtitleLineHeight: 20,
      sectionTitleFontSize: 15,
      sectionBodyFontSize: 12,
      sectionLineHeight: 19,
      badgeFontSize: 12,
      footerFontSize: 11,
    }

  return {
    titleFontSize: Math.round(base.titleFontSize * semanticControls.titleScale),
    titleLineHeight: Math.round(base.titleLineHeight * semanticControls.titleScale),
    subtitleFontSize: Math.round(base.subtitleFontSize * semanticControls.bodyScale),
    subtitleLineHeight: Math.round(base.subtitleLineHeight * Math.max(1, semanticControls.bodyScale)),
    sectionTitleFontSize: Math.round(base.sectionTitleFontSize * Math.max(1, semanticControls.sectionScale * 0.92)),
    sectionBodyFontSize: Math.round(base.sectionBodyFontSize * semanticControls.bodyScale),
    sectionLineHeight: Math.round(base.sectionLineHeight * Math.max(1, semanticControls.bodyScale)),
    badgeFontSize: base.badgeFontSize,
    footerFontSize: Math.max(10, Math.round(base.footerFontSize * (semanticControls.prefersQuietFooter ? 0.92 : 1))),
  }
}

function buildLayoutStrategy(
  compositionFamily: DesignCompositionFamily,
  palette: DesignPalette,
  semanticControls: DesignSemanticControls,
): DesignLayoutStrategyPlan {
  if (compositionFamily === 'split-feature') {
    return {
      align: 'split',
      sectionStyle: 'feature-split',
      heroWeight: semanticControls.prefersLargeElements ? 0.62 : 0.58,
      sectionGap: semanticControls.prefersSparseContent ? 18 : 14,
      titleGap: 12,
      footerMode: 'caption',
    }
  }

  if (compositionFamily === 'editorial-stack') {
    return {
      align: 'left',
      sectionStyle: 'cards',
      heroWeight: semanticControls.prefersSparseContent ? 0.42 : 0.36,
      sectionGap: semanticControls.prefersSparseContent ? 18 : 14,
      titleGap: 12,
      footerMode: 'caption',
    }
  }

  return {
    align: 'left',
    sectionStyle: 'rows',
    heroWeight: semanticControls.prefersSparseContent ? 0.36 : 0.3,
    sectionGap: semanticControls.prefersSparseContent ? 22 : 18,
    titleGap: 12,
    footerMode: semanticControls.prefersQuietFooter ? 'caption' : 'pill',
  }
}

function buildConstraintFlags(sourceText: string): DesignConstraintFlags {
  return {
    ratioExplicit: hasExplicitRatio(sourceText),
    sectionCountExplicit: hasExplicitSectionCount(sourceText),
    platformExplicit: hasExplicitPlatform(sourceText),
  }
}

function buildReviewChecklist(
  ratio: DesignRatio,
  compositionFamily: DesignCompositionFamily,
  sectionCount: number,
  signals: DesignSignalProfile,
): string[] {
  const checklist = [
    `保持 ${ratio} 版面不偏离用户要求的目标比例`,
    '标题区控制在 2 到 3 行，副标题不抢主标题层级',
    sectionCount >= 4 ? '信息组之间维持稳定节奏，避免尾部超出版心' : '主要信息区之间保留清晰留白',
    compositionFamily === 'split-feature'
      ? '右侧强调区与左侧标题区形成明确主次，不出现挤压'
      : '底部备注保持轻量，不与正文区竞争视觉焦点',
  ]

  if (signals.avoidsButtons) checklist.push('不要按钮型 CTA 或右侧固定按钮簇。')
  if (signals.avoidsWideDivider) checklist.push('不要出现底部粗横条或横向粗分割线。')
  if (signals.requestsDifferentVersion) checklist.push('当前版式必须明显区别于上一轮母题，不能只换文案。')

  return checklist
}

function buildDesignBrief(params: {
  sourceText: string
  platform: DesignPlatform
  ratio: DesignRatio
  audience: string
  tone: string
  sectionCount: number
  palette: DesignPalette
  sections: DesignContentSection[]
  signals: DesignSignalProfile
}): DesignBrief {
  const isGithub = params.palette.name === 'github-dark'
  const isYoutube = params.platform === 'youtube'
  const promptText = params.sourceText.trim()
  const headline = isGithub
    ? '把你的核心标题放这里\n更像产品框架或技术封面\n控制在 2 到 3 行'
    : '你的主标题放这里\n突出反差、收益或结果\n建议控制在 2 到 3 行'
  const subheadline = isGithub
    ? '用一行副标题补充对象、方法或约束，让封面看起来更像有判断的框架。'
    : '补一行副标题或结果摘要，让用户先看懂主题再往下读。'

  return {
    id: `brief-${params.platform}-${params.ratio}-${params.palette.name}`,
    taskType: 'social-cover',
    platform: params.platform,
    ratio: params.ratio,
    promptText,
    objective: isYoutube
      ? '生成适合视频封面/缩略图的排版，而不是竖版社媒卡片。'
      : isGithub
        ? (params.signals.requestsDifferentVersion
          ? '生成与上一轮母题明显不同的技术型封面，而不是继续沿用默认按钮母题。'
          : '生成技术型封面，而不是营销感封面。')
        : '生成可直接替换文案的社媒封面框架。',
    visualTone: isGithub
      ? (params.signals.prefersMinimal ? 'dark-technical + minimal restraint' : 'dark-technical + editorial restraint')
      : params.signals.prefersEditorial
        ? 'warm-editorial + poster rhythm'
        : 'warm-editorial + mobile cover',
    audience: params.audience,
    headline,
    subheadline,
    contentHierarchy: [
      { id: 'badge', role: 'badge', label: isYoutube ? 'YOUTUBE COVER' : isGithub ? 'OPEN SOURCE PLAYBOOK' : '干货分享', priority: 1, maxLines: 1 },
      { id: 'headline', role: 'headline', label: '主标题', priority: 2, maxLines: 3 },
      { id: 'subtitle', role: 'subtitle', label: '副标题', priority: 3, maxLines: 3 },
      ...params.sections.map((section, index) => ({
        id: section.id,
        role: 'section' as const,
        label: section.title,
        priority: 4 + index,
        maxLines: 5,
      })),
      { id: 'meta', role: 'meta', label: isYoutube ? '频道名 / 系列 / 上线时间' : isGithub ? 'Repo / CTA / Version' : '底部备注 / 可替换信息', priority: 90, maxLines: 2 },
    ],
    antiGoals: Array.from(new Set(isGithub
      ? [
        '不要暖色营销感',
        '不要大椭圆',
        '不要默认右侧按钮母题',
        '不要底部粗横条',
        ...(params.signals.avoidsButtons ? ['不要按钮型 CTA'] : []),
        ...(params.signals.requestsDifferentVersion ? ['不要沿用上一轮模板母题'] : []),
      ]
      : [
        '不要技术仪表盘感',
        '不要过重按钮',
        '不要无意义大色块',
        ...(params.signals.avoidsWideDivider ? ['不要粗分割线'] : []),
      ])),
    sectionCount: params.sectionCount,
  }
}

function buildStyleSystem(
  palette: DesignPalette,
  styleGuide: DesignStyleGuide,
  typography: DesignTypographyPlan,
  board: DesignBoardPlan,
): DesignStyleSystem {
  return {
    id: `style-${palette.name}-${styleGuide.componentMood}`,
    palette,
    typographyTokens: {
      headlineFamily: palette.name === 'github-dark' ? 'mono' : 'sans',
      headlineWeight: palette.name === 'github-dark' ? 'bold' : 'black',
      bodyFamily: palette.name === 'github-dark' ? 'mono' : 'sans',
      bodyWeight: 'regular',
      titleFontSize: typography.titleFontSize,
      titleLineHeight: typography.titleLineHeight,
      subtitleFontSize: typography.subtitleFontSize,
      subtitleLineHeight: typography.subtitleLineHeight,
      sectionTitleFontSize: typography.sectionTitleFontSize,
      sectionBodyFontSize: typography.sectionBodyFontSize,
      sectionLineHeight: typography.sectionLineHeight,
      badgeFontSize: typography.badgeFontSize,
      metaFontSize: typography.footerFontSize,
      letterSpacing: palette.name === 'github-dark' ? 0.4 : 0,
    },
    radiusTokens: {
      board: board.cornerRadius,
      card: Math.max(10, Math.round(styleGuide.borderRadius * 0.8)),
      chip: Math.max(12, Math.round(styleGuide.borderRadius * 1.2)),
    },
    spacingScale: styleGuide.spacingScale,
    borderRules: {
      enabled: styleGuide.sectionTone === 'outline' || palette.name === 'github-dark',
      width: palette.name === 'github-dark' ? 1.5 : 1,
      color: palette.name === 'github-dark' ? '#30363D' : palette.accent,
      accentWidth: palette.name === 'github-dark' ? 2 : 1,
    },
    shadowRules: styleGuide.shadow,
    ornamentRules: {
      mode: styleGuide.ornament === 'divider-bar'
        ? 'short-line'
        : styleGuide.ornament === 'floating-pill'
          ? 'chip'
          : styleGuide.ornament === 'corner-plates'
            ? 'corner'
            : styleGuide.ornament === 'side-rail'
              ? 'rail'
              : 'none',
      accentAreaLimit: palette.name === 'github-dark' ? 0.12 : 0.18,
      allowLargeEllipse: false,
    },
    motionRules: {
      emphasis: styleGuide.density === 'dense' ? 'expressive' : styleGuide.density === 'airy' ? 'quiet' : 'balanced',
    },
  }
}

function buildSceneRegions(
  ratio: DesignRatio,
  layoutBudget: DesignLayoutBudget,
  layoutBlueprint: DesignLayoutBlueprint,
): DesignSceneRegion[] {
  const profile = getDesignRatioProfile(ratio)
  const sectionsYRatio = layoutBudget.titleZoneHeight / layoutBudget.boardHeight
  const footerYRatio = (layoutBudget.titleZoneHeight + layoutBudget.sectionsZoneHeight) / layoutBudget.boardHeight
  const headerWidth = profile === 'landscape' && layoutBlueprint.skeleton === 'split' ? 0.56 : 1
  const emphasisWidth = Math.max(0.18, Math.min(0.4, layoutBlueprint.emphasisWeight + 0.12))
  return [
    { id: 'board', role: 'board', xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
    { id: 'header', role: 'header', xRatio: 0, yRatio: 0, wRatio: headerWidth, hRatio: sectionsYRatio },
    {
      id: 'emphasis',
      role: 'emphasis',
      xRatio: headerWidth >= 1 ? 0 : 1 - emphasisWidth,
      yRatio: 0,
      wRatio: headerWidth >= 1 ? 0 : emphasisWidth,
      hRatio: Math.max(0.2, sectionsYRatio + 0.06),
    },
    { id: 'sections', role: 'sections', xRatio: 0, yRatio: sectionsYRatio, wRatio: 1, hRatio: footerYRatio - sectionsYRatio },
    { id: 'footer', role: 'footer', xRatio: 0, yRatio: footerYRatio, wRatio: 1, hRatio: 1 - footerYRatio },
  ]
}

function buildSceneNodes(params: {
  sourceText: string
  brief: DesignBrief
  styleSystem: DesignStyleSystem
  styleGuide: DesignStyleGuide
  board: DesignBoardPlan
  layoutBlueprint: DesignLayoutBlueprint
  compositionFamily: DesignCompositionFamily
  sections: DesignContentSection[]
  semanticControls: DesignSemanticControls
}): DesignSceneNode[] {
  const isGithub = params.styleSystem.palette.name === 'github-dark'
  const alignCenter = params.layoutBlueprint.titlePlacement === 'top-center' || params.layoutBlueprint.titlePlacement === 'top-wide'
  const signals = readDesignSignalProfile(params.sourceText)
  const accentColor = params.semanticControls.prefersContrastAccent && params.styleSystem.palette.contrastAccent
    ? params.styleSystem.palette.contrastAccent
    : params.styleSystem.palette.accent
  const columnCount = params.layoutBlueprint.sectionColumns
  const showBadge = !params.semanticControls.prefersSparseContent
  const titleY = showBadge ? 0.145 : (alignCenter ? 0.11 : 0.1)
  const subtitleY = showBadge ? 0.29 : (alignCenter ? 0.245 : 0.22)
  const nodes: DesignSceneNode[] = [
    {
      id: 'board-frame',
      role: 'board',
      kind: 'frame',
      xRatio: 0,
      yRatio: 0,
      wRatio: 1,
      hRatio: 1,
      content: 'Design Board',
      style: { cornerRadius: params.styleSystem.radiusTokens.board },
    },
    {
      id: 'board-surface',
      role: 'board-surface',
      kind: 'surface',
      xRatio: 0,
      yRatio: 0,
      wRatio: 1,
      hRatio: 1,
      style: {
        fill: params.styleSystem.palette.background,
        cornerRadius: params.styleSystem.radiusTokens.board,
      },
    },
    {
      id: 'headline',
      role: 'title',
      kind: 'text',
      xRatio: alignCenter ? 0.12 : 0.08,
      yRatio: titleY,
      wRatio: params.layoutBlueprint.titleWidthRatio,
      hRatio: Math.min(0.18, Math.max(0.12, params.layoutBlueprint.titleZoneRatio * 0.6)),
      content: params.brief.headline,
      style: {
        textColor: params.styleSystem.palette.primaryText,
        textAlign: alignCenter ? 'center' : 'left',
        fontFamily: params.styleSystem.typographyTokens.headlineFamily,
        fontWeight: 'bold',
      },
    },
    {
      id: 'subtitle',
      role: 'subtitle',
      kind: 'text',
      xRatio: alignCenter ? 0.14 : 0.08,
      yRatio: subtitleY,
      wRatio: Math.min(0.82, params.layoutBlueprint.titleWidthRatio),
      hRatio: 0.08,
      content: params.brief.subheadline,
      style: {
        textColor: params.styleSystem.palette.secondaryText,
        textAlign: alignCenter ? 'center' : 'left',
        fontFamily: params.styleSystem.typographyTokens.bodyFamily,
        fontWeight: 'regular',
      },
    },
  ]

  if (showBadge) {
    nodes.splice(2, 0, {
      id: 'badge',
      role: 'badge',
      kind: 'badge',
      xRatio: alignCenter ? 0.32 : 0.08,
      yRatio: 0.07,
      wRatio: isGithub ? 0.34 : 0.18,
      hRatio: 0.045,
      content: params.brief.contentHierarchy.find((item) => item.role === 'badge')?.label || 'Badge',
      style: {
        fill: isGithub ? params.styleSystem.palette.surface : params.styleSystem.palette.accentSoft,
        textColor: params.semanticControls.prefersContrastAccent ? accentColor : (isGithub ? accentColor : '#8B6914'),
        textAlign: alignCenter ? 'center' : 'left',
        fontFamily: params.styleSystem.typographyTokens.bodyFamily,
        fontWeight: 'medium',
        cornerRadius: params.styleSystem.radiusTokens.chip,
      },
    })
  }

  if (params.styleSystem.ornamentRules.mode !== 'none' && !params.semanticControls.prefersSparseContent) {
    nodes.push({
      id: 'ornament',
      role: params.styleSystem.ornamentRules.mode === 'rail' ? 'rail' : 'divider',
      kind: params.styleSystem.ornamentRules.mode === 'chip' ? 'chip' : 'geo',
      xRatio: alignCenter ? 0.42 : 0.08,
      yRatio: 0.385,
      wRatio: params.styleSystem.ornamentRules.mode === 'rail'
        ? 0.008
        : params.styleSystem.ornamentRules.mode === 'chip'
          ? 0.16
          : params.styleSystem.ornamentRules.mode === 'corner'
            ? 0.04
            : 0.12,
      hRatio: params.styleSystem.ornamentRules.mode === 'rail'
        ? 0.7
        : params.styleSystem.ornamentRules.mode === 'chip'
          ? 0.022
          : 0.008,
      shape: params.styleSystem.ornamentRules.mode === 'chip' ? 'pill' : 'rectangle',
      style: {
        fill: accentColor,
        cornerRadius: params.styleSystem.ornamentRules.mode === 'chip' ? params.styleSystem.radiusTokens.chip : params.styleSystem.radiusTokens.card,
      },
    })
  }

  if (params.styleSystem.ornamentRules.mode === 'corner') {
    nodes.push({
      id: 'corner-left',
      role: 'divider',
      kind: 'geo',
      xRatio: 0.08,
      yRatio: 0.388,
      wRatio: 0.035,
      hRatio: 0.008,
      shape: 'rectangle',
      style: { fill: accentColor },
    })
    nodes.push({
      id: 'corner-right',
      role: 'divider',
      kind: 'geo',
      xRatio: 0.87,
      yRatio: 0.388,
      wRatio: 0.035,
      hRatio: 0.008,
      shape: 'rectangle',
      style: { fill: params.styleSystem.palette.accentSoft },
    })
  }

  if (params.layoutBlueprint.emphasisPlacement === 'floating-chip') {
    nodes.push({
      id: 'meta-chip',
      role: 'meta-chip',
      kind: 'chip',
      xRatio: alignCenter ? 0.63 : 0.68,
      yRatio: 0.215,
      wRatio: isGithub ? 0.22 : 0.18,
      hRatio: 0.04,
      content: isGithub ? 'v1.0 / Repo' : '重点摘要',
      style: {
        fill: params.styleSystem.palette.accentSoft,
        textColor: accentColor,
        textAlign: 'center',
        fontFamily: isGithub ? 'mono' : params.styleSystem.typographyTokens.bodyFamily,
        fontWeight: 'medium',
        cornerRadius: params.styleSystem.radiusTokens.chip,
      },
    })
  }

  let remainingSections = [...params.sections]
  let sectionAreaX = 0.08
  let sectionAreaW = 0.84
  let sectionAreaTop = isGithub && params.layoutBlueprint.skeleton === 'split' ? 0.41 : 0.44
  const sectionAreaBottom = 0.885
  const addSectionNode = (input: {
    id: string
    role?: string
    xRatio: number
    yRatio: number
    wRatio: number
    hRatio: number
    section: DesignContentSection
    highlight?: boolean
  }) => {
    nodes.push({
      id: input.id,
      role: input.role || 'section',
      kind: 'section-card',
      xRatio: input.xRatio,
      yRatio: input.yRatio,
      wRatio: input.wRatio,
      hRatio: input.hRatio,
      content: `${input.section.title}\n${input.section.body}`,
      style: {
        fill: input.highlight
          ? params.styleSystem.palette.surface
          : params.styleGuide.sectionTone === 'outline'
            ? params.styleSystem.palette.background
            : params.styleGuide.sectionTone === 'solid'
              ? params.styleSystem.palette.surface
              : params.styleSystem.palette.accentSoft,
        textColor: params.styleSystem.palette.primaryText,
        stroke: params.styleSystem.borderRules.enabled || input.highlight ? params.styleSystem.borderRules.color : undefined,
        strokeWidth: params.styleSystem.borderRules.enabled || input.highlight
          ? (input.highlight ? params.styleSystem.borderRules.accentWidth : params.styleSystem.borderRules.width)
          : 0,
        fontFamily: params.styleSystem.typographyTokens.bodyFamily,
        fontWeight: input.highlight ? 'bold' : 'medium',
        cornerRadius: input.highlight
          ? Math.max(params.styleSystem.radiusTokens.card, params.styleSystem.radiusTokens.chip)
          : params.styleSystem.radiusTokens.card,
      },
    })
  }

  if (params.layoutBlueprint.emphasisPlacement === 'hero-band' && remainingSections.length > 0) {
    const hero = remainingSections.shift()!
    addSectionNode({
      id: 'hero-band',
      xRatio: sectionAreaX,
      yRatio: sectionAreaTop,
      wRatio: sectionAreaW,
      hRatio: 0.13,
      section: hero,
      highlight: true,
    })
    sectionAreaTop += 0.15
  } else if (params.layoutBlueprint.emphasisPlacement === 'hero-card' && remainingSections.length > 0) {
    const hero = remainingSections.shift()!
    const heroWidth = 0.72 + (params.layoutBlueprint.asymmetry * 0.2)
    addSectionNode({
      id: 'hero-card',
      xRatio: alignCenter ? 0.14 : 0.08,
      yRatio: sectionAreaTop,
      wRatio: Math.min(0.84, heroWidth),
      hRatio: 0.145,
      section: hero,
      highlight: true,
    })
    sectionAreaTop += 0.165
  } else if (params.layoutBlueprint.emphasisPlacement === 'side-card' && remainingSections.length > 0) {
    const sideSection = params.styleGuide.ctaWeight === 'button'
      ? (remainingSections.pop() || params.sections.at(-1)!)
      : (remainingSections.shift() || params.sections[0]!)
    const sideWidth = Math.min(0.27, 0.18 + params.layoutBlueprint.emphasisWeight * 0.35)
    const sideX = 0.92 - sideWidth
    addSectionNode({
      id: 'side-panel',
      role: params.styleGuide.ctaWeight === 'button' ? 'cta-panel' : 'section',
      xRatio: sideX,
      yRatio: 0.19,
      wRatio: sideWidth,
      hRatio: 0.22,
      section: sideSection,
      highlight: true,
    })
    if (!signals.avoidsButtons && params.styleGuide.ctaWeight === 'button') {
      nodes.push({
        id: 'cta',
        role: 'cta-button',
        kind: 'button',
        xRatio: sideX + 0.02,
        yRatio: 0.355,
        wRatio: Math.max(0.12, sideWidth - 0.04),
        hRatio: 0.05,
        content: sideSection.title || '打开详情',
        style: { variant: 'primary' },
      })
    }
    sectionAreaW = Math.max(0.48, sideX - sectionAreaX - 0.03)
  }

  const availableHeight = Math.max(0.18, sectionAreaBottom - sectionAreaTop)
  const effectiveColumns: 1 | 2 =
    params.layoutBlueprint.sectionFlow === 'grid' && remainingSections.length > 1
      ? 2
      : params.layoutBlueprint.sectionFlow === 'grid' && columnCount === 2
        ? 2
        : 1

  if (params.layoutBlueprint.sectionFlow === 'grid' && remainingSections.length > 0) {
    const gap = 0.03
    const firstLarge = params.layoutBlueprint.sectionEmphasis === 'first-large' && remainingSections.length > 2
    const highlightLast = params.layoutBlueprint.sectionEmphasis === 'last-highlight'
    let cursorY = sectionAreaTop

    if (firstLarge) {
      const hero = remainingSections.shift()!
      addSectionNode({
        id: 'grid-hero',
        xRatio: sectionAreaX,
        yRatio: cursorY,
        wRatio: sectionAreaW,
        hRatio: Math.min(0.15, availableHeight * 0.32),
        section: hero,
        highlight: true,
      })
      cursorY += Math.min(0.17, availableHeight * 0.36)
    }

    const rows = Math.max(1, Math.ceil(remainingSections.length / effectiveColumns))
    const cardW = effectiveColumns === 2 ? (sectionAreaW - gap) / 2 : sectionAreaW
    const cardH = Math.max(0.09, (sectionAreaBottom - cursorY - gap * Math.max(0, rows - 1)) / rows)

    remainingSections.forEach((section, index) => {
      const row = Math.floor(index / effectiveColumns)
      const column = index % effectiveColumns
      const isLast = index === remainingSections.length - 1
      const isLastHighlight = highlightLast && remainingSections.length > 1 && isLast
      const spanFull = effectiveColumns === 2 && isLast && remainingSections.length % 2 === 1
      addSectionNode({
        id: `section-${index + 1}`,
        role: isLastHighlight && params.styleGuide.ctaWeight !== 'none' ? 'cta-panel' : 'section',
        xRatio: spanFull ? sectionAreaX : sectionAreaX + column * (cardW + gap),
        yRatio: cursorY + row * (cardH + gap),
        wRatio: spanFull ? sectionAreaW : cardW,
        hRatio: Math.min(0.16, cardH * (isLastHighlight ? 1.08 : 1)),
        section,
        highlight: isLastHighlight,
      })
    })
  } else {
    const stagger = params.layoutBlueprint.sectionFlow === 'stagger'
    const highlightFirst = params.layoutBlueprint.sectionEmphasis === 'first-large'
    const highlightLast = params.layoutBlueprint.sectionEmphasis === 'last-highlight'
    const alternating = params.layoutBlueprint.sectionEmphasis === 'alternating'
    const gap = stagger ? 0.024 : 0.022
    const rows = Math.max(1, remainingSections.length)
    const baseH = Math.max(0.085, (availableHeight - gap * Math.max(0, rows - 1)) / rows)

    remainingSections.forEach((section, index) => {
      const isFirst = index === 0
      const isLast = index === remainingSections.length - 1
      const isLastHighlight = highlightLast && remainingSections.length > 1 && isLast
      const widthRatio = stagger
        ? (alternating ? (index % 2 === 0 ? 0.92 : 0.76) : 0.84)
        : alternating
          ? (index % 2 === 0 ? 1 : 0.88)
          : 1
      const wRatio = Math.max(0.58, sectionAreaW * widthRatio)
      const xRatio = stagger && index % 2 === 1
        ? sectionAreaX + Math.max(0, sectionAreaW - wRatio)
        : alignCenter && widthRatio < 1
          ? sectionAreaX + Math.max(0, (sectionAreaW - wRatio) / 2)
          : sectionAreaX
      const highlight = (highlightFirst && isFirst) || (highlightLast && isLast)
      const yRatio = sectionAreaTop + index * (baseH + gap)

      if (params.compositionFamily === 'numbered-list') {
        const pillIndex = signals.prefersDense
        const markerSize = pillIndex ? 0.048 : 0.044
        nodes.push({
          id: `index-${index + 1}`,
          role: 'index',
          kind: 'geo',
          xRatio,
          yRatio: yRatio + 0.01,
          wRatio: pillIndex ? 0.08 : markerSize,
          hRatio: markerSize,
          shape: pillIndex ? 'pill' : 'circle',
          content: String(index + 1).padStart(2, '0'),
          style: {
            fill: accentColor,
            textColor: '#FFFFFF',
            textAlign: 'center',
            fontWeight: 'bold',
            cornerRadius: params.styleSystem.radiusTokens.chip,
          },
        })
      }

      addSectionNode({
        id: `section-${index + 1}`,
        role: isLastHighlight && params.styleGuide.ctaWeight !== 'none' ? 'cta-panel' : 'section',
        xRatio: params.compositionFamily === 'numbered-list' ? xRatio + 0.08 : xRatio,
        yRatio,
        wRatio: params.compositionFamily === 'numbered-list' ? Math.max(0.5, wRatio - 0.08) : wRatio,
        hRatio: Math.min(0.17, baseH * (highlight ? 1.14 : 1)),
        section,
        highlight,
      })
    })
  }

  nodes.push({
    id: 'footer',
    role: 'footer',
    kind: 'text',
    xRatio: 0.08,
    yRatio: 0.91,
    wRatio: 0.84,
    hRatio: params.layoutBlueprint.footerStyle === 'pill' ? 0.05 : 0.04,
    content: isGithub ? 'Repo / CTA / Version' : '底部备注 / 可替换成账号名、日期或系列标签',
    style: {
      fill: params.layoutBlueprint.footerStyle === 'pill'
        ? params.styleSystem.palette.accentSoft
        : params.layoutBlueprint.footerStyle === 'meta-strip'
          ? params.styleSystem.palette.surface
          : undefined,
      textColor: params.styleSystem.palette.secondaryText,
      textAlign: alignCenter ? 'center' : 'left',
      fontFamily: params.styleSystem.typographyTokens.bodyFamily,
      fontWeight: 'regular',
      cornerRadius: params.layoutBlueprint.footerStyle === 'pill'
        ? params.styleSystem.radiusTokens.chip
        : params.layoutBlueprint.footerStyle === 'meta-strip'
          ? 10
          : 0,
    },
  })

  return nodes
}

function buildLayoutBlueprint(params: {
  sourceText: string
  ratio: DesignRatio
  sectionCount: number
  palette: DesignPalette
  compositionFamily: DesignCompositionFamily
  styleGuide: DesignStyleGuide
  signals: DesignSignalProfile
  semanticControls: DesignSemanticControls
}): DesignLayoutBlueprint {
  const ratioProfile = getDesignRatioProfile(params.ratio)
  const explicitSplit = params.signals.prefersSplit
  const explicitGrid = params.signals.prefersGrid
  const explicitStagger = params.signals.prefersAsymmetry || params.signals.prefersEditorial
  const explicitMinimal = params.signals.prefersMinimal
  const posterLike = params.signals.prefersPoster || params.signals.prefersEditorial
  const technicalLike = params.signals.prefersDark || /(github|技术|产品|工程|dashboard)/i.test(params.sourceText)

  let skeleton: DesignLayoutBlueprint['skeleton'] = 'column'
  if (params.semanticControls.prefersSideMeta) skeleton = 'split'
  else if (explicitSplit) skeleton = 'split'
  else if (ratioProfile === 'landscape' && technicalLike) skeleton = params.styleGuide.ctaWeight === 'button' ? 'split' : 'grid'
  else if (ratioProfile === 'landscape' && posterLike) skeleton = 'grid'
  else if (explicitGrid) skeleton = 'grid'
  else if (explicitStagger || (posterLike && params.sectionCount >= 3)) skeleton = 'staggered'
  else if (posterLike || params.styleGuide.headlineAlign === 'center') skeleton = 'poster'
  else if (technicalLike && params.sectionCount <= 3) skeleton = 'grid'
  else if (params.sectionCount >= 4) skeleton = 'column'
  else if (params.compositionFamily === 'split-feature' && params.styleGuide.ctaWeight === 'button') skeleton = 'split'

  if (params.signals.requestsDifferentVersion) {
    skeleton = pickAlternativeSkeleton(skeleton, params.ratio, params.sectionCount, params.signals)
  }

  const sectionColumns: 1 | 2 = skeleton === 'grid' || skeleton === 'split' || ratioProfile === 'landscape' ? 2 : 1
  const preferCenter = params.styleGuide.headlineAlign === 'center'
  const titlePlacement: DesignLayoutBlueprint['titlePlacement'] =
    preferCenter
      ? (skeleton === 'poster' ? 'top-wide' : 'top-center')
      : skeleton === 'poster'
        ? 'middle-left'
        : 'top-left'

  const emphasisPlacement: DesignLayoutBlueprint['emphasisPlacement'] =
    params.semanticControls.prefersSideMeta
      ? 'side-card'
      : params.styleGuide.ctaWeight === 'button'
      ? (skeleton === 'split' || technicalLike ? 'side-card' : 'hero-card')
      : params.signals.requestsDifferentVersion && skeleton === 'poster'
        ? 'hero-card'
        : skeleton === 'poster'
        ? 'hero-band'
        : skeleton === 'staggered'
          ? 'floating-chip'
          : explicitMinimal
            ? 'none'
            : technicalLike && params.sectionCount <= 3 && params.signals.prefersCards
              ? 'hero-card'
              : 'none'

  const sectionFlow: DesignLayoutBlueprint['sectionFlow'] =
    sectionColumns === 2 ? 'grid' : skeleton === 'staggered' ? 'stagger' : 'stack'

  const sectionEmphasis: DesignLayoutBlueprint['sectionEmphasis'] =
    params.styleGuide.ctaWeight === 'button'
      ? 'last-highlight'
      : params.signals.requestsDifferentVersion && skeleton === 'grid'
        ? 'alternating'
        : skeleton === 'poster'
        ? 'first-large'
        : skeleton === 'staggered'
          ? 'alternating'
          : 'uniform'

  const ornamentMode: DesignLayoutBlueprint['ornamentMode'] =
    explicitMinimal ? 'none'
      : params.styleGuide.ornament === 'side-rail' ? 'rail'
        : params.styleGuide.ornament === 'floating-pill' ? 'pill'
          : params.styleGuide.ornament === 'corner-plates' ? 'corner'
            : 'short-line'

  const titleWidthRatio = params.semanticControls.titleWidthRatio
    ? Math.max(0.32, Math.min(0.9, params.semanticControls.titleWidthRatio))
    : ratioProfile === 'landscape'
    ? skeleton === 'split' ? 0.44 : skeleton === 'grid' ? 0.52 : skeleton === 'poster' ? 0.5 : 0.58
    : skeleton === 'split' ? 0.56 : skeleton === 'poster' ? 0.88 : skeleton === 'grid' ? 0.82 : 0.84
  const titleZoneRatio = params.semanticControls.titleZoneRatio
    ? Math.max(0.18, Math.min(0.42, params.semanticControls.titleZoneRatio))
    : ratioProfile === 'portrait' && params.ratio === '9:16'
    ? skeleton === 'poster' ? 0.3 : skeleton === 'staggered' ? 0.28 : 0.24
    : ratioProfile === 'landscape'
      ? skeleton === 'split' ? 0.2 : 0.18
      : skeleton === 'poster' ? 0.28 : 0.22

  return {
    skeleton,
    titlePlacement,
    emphasisPlacement,
    sectionFlow,
    sectionEmphasis,
    ornamentMode,
    footerStyle: params.styleGuide.ctaWeight === 'button'
      ? 'pill'
      : params.semanticControls.prefersQuietFooter
        ? 'caption'
      : technicalLike && params.signals.prefersDense && !params.signals.prefersMinimal
        ? 'meta-strip'
        : 'caption',
    titleWidthRatio,
    titleZoneRatio,
    emphasisWeight: ratioProfile === 'landscape'
      ? (params.styleGuide.ctaWeight === 'button' ? 0.24 : 0.16)
      : params.styleGuide.ctaWeight === 'button' ? 0.28 : skeleton === 'poster' ? 0.22 : params.signals.prefersAsymmetry ? 0.2 : 0.18,
    sectionColumns,
    asymmetry: skeleton === 'staggered'
      ? 0.22
      : skeleton === 'split'
        ? 0.28
        : skeleton === 'poster'
          ? 0.16
          : params.signals.prefersAsymmetry
            ? 0.16
            : 0.08,
  }
}

function buildDecisionTrace(params: {
  ratio: DesignRatio
  platform: DesignPlatform
  sectionCount: number
  palette: DesignPalette
  compositionFamily: DesignCompositionFamily
  styleGuide: DesignStyleGuide
  layoutBlueprint: DesignLayoutBlueprint
  placementStrategy: DesignPlacementStrategy
  signals: DesignSignalProfile
  semanticControls: DesignSemanticControls
}): string[] {
  const platformLabel = params.platform === 'xiaohongshu'
    ? '小红书封面'
    : params.platform === 'youtube'
      ? 'YouTube 封面'
      : '通用画板'
  const alignLabel = params.styleGuide.headlineAlign === 'center' ? '标题居中' : '标题左对齐'
  const sectionToneLabel =
    params.styleGuide.sectionTone === 'outline'
      ? '信息区用描边结构'
      : params.styleGuide.sectionTone === 'solid'
        ? '信息区用实底块'
        : '信息区用柔和浅底'
  const ornamentLabel =
    params.styleGuide.ornament === 'side-rail'
      ? '加入侧向导轨'
      : params.styleGuide.ornament === 'floating-pill'
        ? '加入悬浮标签'
        : params.styleGuide.ornament === 'corner-plates'
          ? '加入角标装饰'
          : '用短分隔线建立节奏'

  return [
    `约束归一化：锁定 ${platformLabel}、${params.ratio} 比例、${params.sectionCount} 组信息区。`,
    `风格决策：采用 ${params.palette.name} 配色，${alignLabel}，${sectionToneLabel}，${ornamentLabel}。`,
    `结构决策：先生成 ${params.layoutBlueprint.skeleton} 版面蓝图，标题落在 ${params.layoutBlueprint.titlePlacement}，信息区按 ${params.layoutBlueprint.sectionFlow} 节奏排布，而不是直接套固定模板。`,
    params.semanticControls.titleZoneRatio || params.semanticControls.prefersLargeElements || params.semanticControls.prefersSparseContent
      ? `语义预算：标题区${params.semanticControls.titleZoneRatio ? `约占画幅 ${Math.round(params.semanticControls.titleZoneRatio * 100)}%` : '放大处理'}，${params.semanticControls.prefersSparseContent ? '信息区收紧并增大单个元素占比' : '保持常规信息密度'}。`
      : '语义预算：沿默认标题/信息区比例推进，但保持对显式颜色和版面限制的响应。',
    params.signals.requestsDifferentVersion
      ? '变体决策：用户明确要求不同版式，本轮主动避开上一轮常见母题并切换骨架与装饰。'
      : '变体决策：当前版式保持单一主版本，不额外追加第二套母题。',
    `落位策略：按 ${params.placementStrategy} 寻找空白区，避免覆盖已有画布资产。`,
    '执行原则：先建主容器，再写标题区，随后分批写入信息组，最后做版心与节奏复查。',
  ]
}

function buildStyleGuide(
  palette: DesignPalette,
  compositionFamily: DesignCompositionFamily,
  sourceText: string,
  signals: DesignSignalProfile,
): DesignStyleGuide {
  const headlineAlign = signals.prefersCenter ? 'center' : 'left'
  const density = signals.prefersMinimal
    ? 'airy'
    : signals.prefersDense
      ? 'dense'
      : 'balanced'
  if (palette.name === 'github-dark') {
    return {
      palette,
      borderRadius: compositionFamily === 'split-feature' ? 20 : 16,
      headlineAlign,
      ornament: signals.prefersRail ? 'side-rail' : 'corner-plates',
      sectionTone: signals.prefersOutline ? 'outline' : 'solid',
      ctaWeight: signals.avoidsButtons || signals.prefersSparseContent ? 'none' : (signals.prefersButtons ? 'button' : 'pill'),
      density,
      shadow: {
        enabled: true,
        blur: 24,
        opacity: 26,
        offsetY: 10,
      },
      spacingScale: { xs: 8, sm: 12, md: 18, lg: 24, xl: 32 },
      componentMood: 'dark-technical',
    }
  }

  if (palette.name === 'warm-editorial') {
    return {
      palette,
      borderRadius: compositionFamily === 'editorial-stack' ? 24 : 18,
      headlineAlign,
      ornament: signals.prefersEditorial || signals.prefersWarm || signals.avoidsWideDivider
        ? 'floating-pill'
        : signals.prefersCorners
          ? 'corner-plates'
          : 'divider-bar',
      sectionTone: signals.prefersOutline ? 'outline' : 'soft',
      ctaWeight: signals.avoidsButtons || signals.prefersSparseContent ? 'none' : (signals.prefersButtons ? 'button' : 'pill'),
      density,
      shadow: {
        enabled: true,
        blur: 20,
        opacity: 14,
        offsetY: 8,
      },
      spacingScale: { xs: 8, sm: 12, md: 16, lg: 24, xl: 36 },
      componentMood: 'warm-editorial',
    }
  }

  return {
    palette,
    borderRadius: 18,
    headlineAlign,
    ornament: signals.prefersCorners ? 'corner-plates' : signals.avoidsWideDivider ? 'floating-pill' : 'divider-bar',
    sectionTone: signals.prefersOutline ? 'outline' : 'solid',
    ctaWeight: signals.avoidsButtons || signals.prefersSparseContent ? 'none' : (signals.prefersButtons ? 'button' : 'pill'),
    density,
    shadow: {
      enabled: true,
      blur: 16,
      opacity: 10,
      offsetY: 6,
    },
    spacingScale: { xs: 8, sm: 12, md: 16, lg: 22, xl: 30 },
    componentMood: 'clean-neutral',
  }
}

function buildLayoutBudget(
  board: DesignBoardPlan,
  layoutStrategy: DesignLayoutStrategyPlan,
  semanticControls: DesignSemanticControls,
): DesignLayoutBudget {
  const usableHeight = board.height - board.paddingTop - board.paddingBottom
  const baseTitleRatio = layoutStrategy.align === 'split' ? 0.26 : 0.24
  const resolvedTitleRatio = semanticControls.titleZoneRatio
    ? Math.max(0.18, Math.min(0.42, semanticControls.titleZoneRatio))
    : Math.max(0.2, Math.min(0.38, baseTitleRatio + (semanticControls.prefersLargeElements ? 0.04 : 0) + (semanticControls.prefersSparseContent ? 0.03 : 0)))
  const titleZoneHeight = Math.round(usableHeight * resolvedTitleRatio)
  const footerZoneHeight = Math.round(usableHeight * (semanticControls.prefersQuietFooter ? 0.08 : (layoutStrategy.footerMode === 'caption' ? 0.1 : 0.12)))
  return {
    boardWidth: board.width,
    boardHeight: board.height,
    paddingX: board.paddingX,
    paddingTop: board.paddingTop,
    paddingBottom: board.paddingBottom,
    titleMaxLines: 3,
    subtitleMaxLines: 3,
    sectionMaxLines: 5,
    footerMaxLines: 2,
    titleZoneHeight,
    sectionsZoneHeight: Math.max(120, usableHeight - titleZoneHeight - footerZoneHeight),
    footerZoneHeight,
  }
}

function extractLayoutDigest(text: string): DesignLayoutDigest | null {
  const match = text.match(/布局摘要JSON:\s*(\{[^\n]+\})/)
  if (!match) return null
  try {
    return coerceDesignLayoutDigest(JSON.parse(match[1]))
  } catch {
    return null
  }
}

export function buildDesignIntentPlan(input: {
  rawUserText: string
  primaryInstruction: string
}): DesignPlannerResult {
  const sourceText = `${input.primaryInstruction}\n${input.rawUserText}`.trim()
  const signals = readDesignSignalProfile(sourceText)
  const semanticControls = extractDesignSemanticControls(sourceText)
  const platform = pickPlatform(sourceText)
  const digest = extractLayoutDigest(sourceText)
  const ratio = pickRatio(input.primaryInstruction, sourceText, digest)
  const sectionCount = resolveSectionCount(sourceText, ratio, semanticControls)
  const palette = pickPalette(sourceText, platform, signals)
  const tone = pickTone(sourceText, palette, signals)
  const audience = pickAudience(sourceText, platform)
  const compositionFamily = pickCompositionFamily(sourceText, sectionCount, palette, signals)
  const placementStrategy = pickPlacementStrategy(digest)
  const themeKeywords = extractThemeKeywords(sourceText, signals)
  const contentSections = buildSections(compositionFamily, sectionCount, palette)
  const board = buildBoardPlan(ratio)
  const typography = buildTypographyPlan(ratio, compositionFamily, palette, semanticControls)
  const layoutStrategy = buildLayoutStrategy(compositionFamily, palette, semanticControls)
  const styleGuide = buildStyleGuide(palette, compositionFamily, sourceText, signals)
  const layoutBlueprint = buildLayoutBlueprint({
    sourceText,
    ratio,
    sectionCount: contentSections.length,
    palette,
    compositionFamily,
    styleGuide,
    signals,
    semanticControls,
  })
  const layoutBudget = buildLayoutBudget(board, layoutStrategy, semanticControls)
  const constraintFlags = buildConstraintFlags(sourceText)
  const reviewChecklist = buildReviewChecklist(ratio, compositionFamily, contentSections.length, signals)
  const brief = buildDesignBrief({
    sourceText,
    platform,
    ratio,
    audience,
    tone,
    sectionCount: contentSections.length,
    palette,
    sections: contentSections,
    signals,
  })
  const styleSystem = buildStyleSystem(palette, styleGuide, typography, board)
  const scenePlan: DesignScenePlan = {
    id: buildScenePlanId({
      platform,
      ratio,
      palette,
      layoutBlueprint,
      styleGuide,
    }),
    ratio,
    placementStrategy,
    compositionFamily,
    board,
    layoutBudget,
    regions: buildSceneRegions(ratio, layoutBudget, layoutBlueprint),
    nodes: buildSceneNodes({
      sourceText,
      brief,
      styleSystem,
      styleGuide,
      board,
      layoutBlueprint,
      compositionFamily,
      sections: contentSections,
      semanticControls,
    }),
    bannedMotifs: brief.antiGoals,
    rationale: [
      '先完成设计判断，再把判断编译成节点树与批次执行程序。',
      `当前场景采用 ${layoutBlueprint.skeleton} 骨架、${layoutBlueprint.sectionFlow} 信息流，而不是固定模板母题。`,
      `强调区规则：${layoutBlueprint.emphasisPlacement}；装饰规则：${styleSystem.ornamentRules.mode}。`,
    ],
  }
  const decisionTrace = buildDecisionTrace({
    ratio,
    platform,
    sectionCount: contentSections.length,
    palette,
    compositionFamily,
    styleGuide,
    layoutBlueprint,
    placementStrategy,
    signals,
    semanticControls,
  })
  const plannerSignals = [
    `${platform}`,
    `${ratio}`,
    `${compositionFamily}`,
    palette.name,
    digest ? `digest:${digest.topLevelElementCount}` : 'digest:none',
  ]

  const confidence =
    ratio && contentSections.length > 0 && themeKeywords.length > 0
      ? 'high'
      : digest || /封面|画板|版式|排版/.test(sourceText)
        ? 'medium'
        : 'low'

  const plan: DesignIntentPlan = {
    taskType: 'social-cover',
    platform,
    ratio,
    audience,
    tone,
    themeKeywords,
    palette,
    compositionFamily,
    sectionCount: contentSections.length,
    contentSections,
    placementStrategy,
    geometryRules: {
      badgeShape: 'pill',
      indexMarker: compositionFamily === 'numbered-list' ? 'circle' : 'pill',
      divider: palette.name === 'github-dark' ? 'bar' : 'line',
      allowStretchedEllipse: false,
    },
    board,
    typography,
    layoutStrategy,
    semanticControls,
    brief,
    styleGuide,
    styleSystem,
    layoutBlueprint,
    layoutBudget,
    scenePlan,
    executionProgram: null as DesignExecutionProgram | null,
    constraintFlags,
    reviewChecklist,
    repairScope: 'selected',
    decisionTrace,
    repairPlan: null,
    reasoningSummary: `${decisionTrace[0]} ${decisionTrace[1]} ${decisionTrace[2]} 校验重点是标题层级、信息节奏与版心不溢出。`,
  }

  return {
    plan,
    confidence,
    signals: plannerSignals,
    instructionText: input.primaryInstruction.trim() || input.rawUserText.trim(),
  }
}

export function formatDesignPlannerPrompt(result: DesignPlannerResult): string {
  const { plan, confidence } = result
  const sectionSummary = plan.contentSections
    .map((section, index) => `${index + 1}. ${section.title}: ${section.body}`)
    .join('\n')

  return [
    '系统补充：以下是本轮设计任务的内部决策结果。请依据这些结论调用 design_* 工具执行，而不是机械复用旧模板。',
    `- planner confidence: ${confidence}`,
    `- taskType: ${plan.taskType}`,
    `- platform: ${plan.platform}`,
    `- ratio: ${plan.ratio}`,
    `- audience: ${plan.audience}`,
    `- tone: ${plan.tone}`,
    `- palette: ${JSON.stringify(plan.palette)}`,
    `- compositionFamily: ${plan.compositionFamily}`,
    `- sectionCount: ${plan.sectionCount}`,
    `- placementStrategy: ${plan.placementStrategy}`,
    `- themeKeywords: ${plan.themeKeywords.join(', ') || 'none'}`,
    `- geometryRules: ${JSON.stringify(plan.geometryRules)}`,
    `- board: ${JSON.stringify(plan.board)}`,
    `- typography: ${JSON.stringify(plan.typography)}`,
    `- layoutStrategy: ${JSON.stringify(plan.layoutStrategy)}`,
    `- semanticControls: ${JSON.stringify(plan.semanticControls)}`,
    `- brief: ${JSON.stringify(plan.brief)}`,
    `- styleGuide: ${JSON.stringify(plan.styleGuide)}`,
    `- styleSystem: ${JSON.stringify(plan.styleSystem)}`,
    `- layoutBlueprint: ${JSON.stringify(plan.layoutBlueprint)}`,
    `- layoutBudget: ${JSON.stringify(plan.layoutBudget)}`,
    `- scenePlan: ${JSON.stringify(plan.scenePlan)}`,
    `- repairScope: ${plan.repairScope || 'selected'}`,
    `- constraintFlags: ${JSON.stringify(plan.constraintFlags)}`,
    `- reasoningSummary: ${plan.reasoningSummary}`,
    `- reviewChecklist: ${plan.reviewChecklist.join(' | ')}`,
    ...(Array.isArray(plan.decisionTrace) && plan.decisionTrace.length > 0
      ? ['- decisionTrace:', ...plan.decisionTrace.map((line) => `  - ${line}`)]
      : []),
    '内容区规划：',
    sectionSummary,
    plan.taskType === 'social-cover'
      ? '优先调用 design_run_task_controller，并把 compositionFamily、palette、sectionCount、placementStrategy、themeKeywords、contentSections、board、typography、layoutStrategy、styleGuide、layoutBudget、repairScope 一并传入。'
      : '优先调用 design_compose_content_layout 或必要的低层 design_* 工具完成布局。',
    confidence === 'low'
      ? '如果你仍然缺少足够画布信息，先调用 design_get_editor_state 或 design_snapshot_layout 再继续。'
      : '如果当前画布已有内容，优先尊重现有布局并按 placementStrategy 落位；落图后要按 reviewChecklist 自检，不通过则在同一次执行里继续修正。',
  ].join('\n')
}
