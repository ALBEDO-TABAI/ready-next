export type DesignTaskType = 'social-cover' | 'content-layout'
export type DesignPlatform = 'xiaohongshu' | 'youtube' | 'generic'
export type DesignRatio = '9:16' | '16:9' | '3:4' | '4:3' | '1:1'
export type DesignCompositionFamily = 'editorial-stack' | 'numbered-list' | 'split-feature'
export type DesignPlacementStrategy = 'auto-right' | 'auto-below' | 'viewport-origin' | 'explicit'
export type DesignRepairScope = 'run-owned' | 'selected'
export type DesignControllerPhase =
  | 'observe'
  | 'brief'
  | 'scene-plan'
  | 'compile'
  | 'plan'
  | 'locate'
  | 'execute'
  | 'verify'
  | 'reflect'
  | 'repair'
  | 'finalize'

export type DesignRatioProfile = 'portrait' | 'landscape' | 'square'

export const DESIGN_RATIOS: readonly DesignRatio[] = ['9:16', '16:9', '3:4', '4:3', '1:1'] as const

export const DESIGN_RATIO_DIMENSIONS: Record<DesignRatio, { width: number; height: number }> = {
  '9:16': { width: 540, height: 960 },
  '16:9': { width: 960, height: 540 },
  '3:4': { width: 540, height: 720 },
  '4:3': { width: 720, height: 540 },
  '1:1': { width: 540, height: 540 },
}

export function isDesignRatio(value: unknown): value is DesignRatio {
  return typeof value === 'string' && DESIGN_RATIOS.includes(value.trim() as DesignRatio)
}

export function normalizeDesignRatio(value: unknown, fallback: DesignRatio = '9:16'): DesignRatio {
  return isDesignRatio(value) ? value.trim() as DesignRatio : fallback
}

export function parseDesignRatioFromText(text: string, fallback: DesignRatio = '9:16'): DesignRatio {
  const patterns: Array<{ ratio: DesignRatio; pattern: RegExp; priority: number }> = [
    { ratio: '16:9', pattern: /(16[:：/ ]9|十六比九)/gi, priority: 2 },
    { ratio: '9:16', pattern: /(9[:：/ ]16|九比十六)/gi, priority: 2 },
    { ratio: '3:4', pattern: /(3[:：/ ]4|三比四)/gi, priority: 2 },
    { ratio: '4:3', pattern: /(4[:：/ ]3|四比三)/gi, priority: 2 },
    { ratio: '1:1', pattern: /(1[:：/ ]1|一比一)/gi, priority: 2 },
    { ratio: '1:1', pattern: /(正方形|方形)/gi, priority: 1 },
    { ratio: '16:9', pattern: /(横向|横版|宽屏|banner)/gi, priority: 1 },
    { ratio: '9:16', pattern: /(竖向|竖版)/gi, priority: 1 },
  ]

  let bestMatch: { ratio: DesignRatio; index: number; priority: number } | null = null
  for (const { ratio, pattern, priority } of patterns) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null = pattern.exec(text)
    while (match) {
      const index = match.index
      if (
        !bestMatch
        || priority > bestMatch.priority
        || (priority === bestMatch.priority && index > bestMatch.index)
      ) {
        bestMatch = { ratio, index, priority }
      }
      match = pattern.exec(text)
    }
  }

  if (bestMatch) return bestMatch.ratio
  return fallback
}

export function getDimensionsForDesignRatio(ratio: DesignRatio): { width: number; height: number } {
  return DESIGN_RATIO_DIMENSIONS[ratio]
}

export function getDesignRatioProfile(ratio: DesignRatio): DesignRatioProfile {
  const { width, height } = getDimensionsForDesignRatio(ratio)
  if (width === height) return 'square'
  return width > height ? 'landscape' : 'portrait'
}

export function inferDesignRatioFromDimensions(
  width: number,
  height: number,
  fallback: DesignRatio = '9:16',
): DesignRatio {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return fallback
  const aspect = width / height
  let bestRatio = fallback
  let smallestDelta = Number.POSITIVE_INFINITY

  for (const ratio of DESIGN_RATIOS) {
    const dimensions = getDimensionsForDesignRatio(ratio)
    const delta = Math.abs(aspect - (dimensions.width / dimensions.height))
    if (delta < smallestDelta) {
      smallestDelta = delta
      bestRatio = ratio
    }
  }

  return bestRatio
}

export function getDefaultSectionCountForRatio(ratio: DesignRatio): number {
  if (ratio === '16:9') return 2
  if (ratio === '4:3') return 2
  if (ratio === '3:4') return 3
  return 4
}

export function normalizeDesignPlatform(value: unknown, fallback: DesignPlatform = 'generic'): DesignPlatform {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'xiaohongshu') return 'xiaohongshu'
  if (normalized === 'youtube') return 'youtube'
  return fallback
}

export function inferDesignPlatformFromText(text: string, fallback: DesignPlatform = 'generic'): DesignPlatform {
  if (/(小红书|xiaohongshu)/i.test(text)) return 'xiaohongshu'
  if (/(youtube|shorts|yt\b)/i.test(text)) return 'youtube'
  return fallback
}

export interface DesignPalette {
  name: string
  background: string
  surface: string
  primaryText: string
  secondaryText: string
  accent: string
  accentSoft: string
  contrastAccent?: string
}

export type DesignColorIntent =
  | 'green'
  | 'red'
  | 'blue'
  | 'purple'
  | 'orange'
  | 'yellow'
  | 'pink'
  | 'teal'

/**
 * Design style presets
 */
export type DesignStylePreset =
  | 'poster'      // Poster: oversized title + minimal content
  | 'luxury'      // Luxury: small corners + gold contrast + loose spacing
  | 'minimal'     // Minimal: no ornament + large whitespace + monochrome
  | 'editorial'   // Editorial: large title + multi-column + serif font
  | 'tech'        // Tech: gradient + large corners + blue-purple palette
  | 'organic'     // Organic: irregular corners + natural palette
  | null

/**
 * Style preset to parameter mapping
 */
interface StylePresetMapping {
  titleScale: number
  bodyScale: number
  cornerRadiusScale: number
  spacingScale: number
  prefersSparseContent: boolean
  prefersContrastAccent: boolean
  prefersLargeElements: boolean
}

const STYLE_PRESET_MAPPINGS: Record<Exclude<DesignStylePreset, null>, StylePresetMapping> = {
  poster: {
    titleScale: 2.5,              // Oversized title
    bodyScale: 0.8,               // Small body text
    cornerRadiusScale: 0.5,       // Small corners
    spacingScale: 1.5,            // Large spacing
    prefersSparseContent: true,   // Minimal content
    prefersContrastAccent: false, // No contrast color
    prefersLargeElements: true,   // Large elements
  },
  luxury: {
    titleScale: 1.3,              // Medium title
    bodyScale: 1.0,               // Normal body text
    cornerRadiusScale: 0.3,       // Small corners or straight
    spacingScale: 1.4,            // Loose spacing
    prefersSparseContent: true,   // Sparse content
    prefersContrastAccent: true,  // Gold contrast
    prefersLargeElements: false,  // Refined elements
  },
  minimal: {
    titleScale: 1.5,              // Large title
    bodyScale: 0.9,               // Small body text
    cornerRadiusScale: 0,         // No corners
    spacingScale: 1.8,            // Extra large spacing
    prefersSparseContent: true,   // Minimal content
    prefersContrastAccent: false, // Monochrome
    prefersLargeElements: false,  // Minimal elements
  },
  editorial: {
    titleScale: 1.8,              // Large title
    bodyScale: 1.1,               // Large body text
    cornerRadiusScale: 0.5,       // Small corners
    spacingScale: 1.2,            // Medium spacing
    prefersSparseContent: false,  // Rich content
    prefersContrastAccent: true,  // Contrast emphasis
    prefersLargeElements: false,  // Multiple elements
  },
  tech: {
    titleScale: 1.4,              // Medium-large title
    bodyScale: 1.0,               // Normal body text
    cornerRadiusScale: 1.5,       // Large corners
    spacingScale: 1.1,            // Normal spacing
    prefersSparseContent: false,  // Normal content
    prefersContrastAccent: true,  // Gradient contrast
    prefersLargeElements: true,   // Large elements
  },
  organic: {
    titleScale: 1.3,              // Medium title
    bodyScale: 1.0,               // Normal body text
    cornerRadiusScale: 1.2,       // Medium-large corners
    spacingScale: 1.3,            // Loose spacing
    prefersSparseContent: false,  // Normal content
    prefersContrastAccent: true,  // Natural contrast
    prefersLargeElements: false,  // Normal elements
  },
}

export interface DesignSemanticControls {
  titleScale: number
  bodyScale: number
  sectionScale: number
  titleZoneRatio: number | null
  titleWidthRatio: number | null
  prefersSparseContent: boolean
  prefersLargeElements: boolean
  prefersSideMeta: boolean
  prefersContrastAccent: boolean
  prefersQuietFooter: boolean

  // Corner radius control
  cornerRadiusScale: number  // Corner radius scale factor, default 1.0
  explicitCornerRadius: number | null  // Specific corner radius value (px), higher priority than scale

  // Font size control
  explicitTitleFontSize: number | null  // Specific title font size (px)
  explicitBodyFontSize: number | null  // Specific body font size (px)

  // Typography control
  explicitLineHeight: number | null  // Specific line height (multiplier, e.g. 1.5)
  fontWeightMode: 'light' | 'regular' | 'medium' | 'bold' | 'black' | null  // Font weight

  // Layout control
  spacingScale: number  // Spacing scale factor, default 1.0
  alignMode: 'left' | 'center' | 'right' | null  // Alignment mode

  // Style preset
  stylePreset: DesignStylePreset

  // Stage 3D: Enhanced Semantic Controls
  // Color control
  explicitBackgroundColor: string | null  // Specific background color (hex, e.g. "#FF5733")
  explicitAccentColor: string | null  // Specific accent color (hex)
  explicitTextColor: string | null  // Specific text color (hex)

  // Border control
  explicitBorderWidth: number | null  // Specific border width (px)
  explicitBorderStyle: 'solid' | 'dashed' | 'dotted' | null  // Border style

  // Precise spacing control
  explicitPadding: number | null  // Specific padding value (px)
  explicitGap: number | null  // Specific gap value (px)
}

function parseFractionToken(token: string): number | null {
  const normalized = token.trim()
  if (!normalized) return null
  const slashMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/)
  if (slashMatch) {
    const numerator = Number(slashMatch[1])
    const denominator = Number(slashMatch[2])
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return numerator / denominator
    }
  }
  const percentage = Number(normalized)
  if (Number.isFinite(percentage) && percentage > 1 && percentage <= 100) return percentage / 100
  if (Number.isFinite(percentage) && percentage > 0 && percentage <= 1) return percentage
  return null
}

export function extractDesignSemanticControls(text: string): DesignSemanticControls {
  const rawText = text.trim()

  // === Style preset recognition (highest priority) ===
  const stylePreset: DesignStylePreset =
    /(大字报|超大标题|巨大字体|poster)/i.test(rawText) ? 'poster' :
    /(奢华|豪华|高端|luxury)/i.test(rawText) ? 'luxury' :
    /(极简|简约|minimal)/i.test(rawText) ? 'minimal' :
    /(编辑|杂志|editorial)/i.test(rawText) ? 'editorial' :
    /(科技|tech|未来)/i.test(rawText) ? 'tech' :
    /(有机|自然|organic)/i.test(rawText) ? 'organic' :
    null

  // If style preset is recognized, apply preset parameters as base
  let baseControls: Partial<DesignSemanticControls> = {}
  if (stylePreset) {
    baseControls = STYLE_PRESET_MAPPINGS[stylePreset]
  }

  // === Existing extraction logic (can override preset) ===
  const titleZoneMatch =
    rawText.match(/(?:标题|主标题)[^，。；\n]{0,16}(?:占|占据|占画幅|占版面|占整个画面|占到)\s*([0-9]+(?:\.[0-9]+)?\s*\/\s*[0-9]+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?%?)/i)
    || rawText.match(/([0-9]+(?:\.[0-9]+)?\s*\/\s*[0-9]+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?%?)[^，。；\n]{0,10}(?:画幅|版面)[^，。；\n]{0,8}(?:标题|主标题)/i)
  const titleZoneRatio = titleZoneMatch ? parseFractionToken(titleZoneMatch[1] || '') : null
  const prefersSparseContent =
    /(信息更少|更少信息|少一点信息|只保留|只有标题|只有主标题|只有标题和|只要标题|标题和标题旁边的附加信息)/i.test(rawText)
  const prefersLargeElements =
    /(字要更大|标题更大|元素更大|更显著|更醒目|放大一点|主标题更突出|更大更显著|大一点)/i.test(rawText)
  const prefersSideMeta =
    /(标题旁边|标题右侧|标题边上|side info|旁边的附加信息|标题和标题旁边的附加信息)/i.test(rawText)
  const prefersContrastAccent =
    /(对色|撞色|对比色|contrast accent|对比一点颜色|加一点对色|补一点对色)/i.test(rawText)
  const prefersQuietFooter =
    /(底部轻一点|底部更轻|弱化底部|footer light|底部轻一些)/i.test(rawText)

  let titleScale = 1
  let bodyScale = 1
  let sectionScale = 1

  if (prefersLargeElements) {
    titleScale += 0.18
    bodyScale += 0.08
    sectionScale += 0.12
  }
  if (prefersSparseContent) {
    titleScale += 0.08
    bodyScale += 0.04
    sectionScale += 0.16
  }
  if (titleZoneRatio && titleZoneRatio >= 0.3) {
    titleScale += 0.1
    sectionScale += 0.06
  }

  // === Corner radius extraction ===
  const cornerRadiusMatch = rawText.match(/圆角\s*(\d+)(?:px)?/i)
  const explicitCornerRadius = cornerRadiusMatch ? Number(cornerRadiusMatch[1]) : null
  const cornerRadiusScale = /(圆角更大|圆角大一点|更圆润)/i.test(rawText) ? 1.3 :
                            /(圆角更小|圆角小一点|更方正)/i.test(rawText) ? 0.7 :
                            /(无圆角|直角|方形)/i.test(rawText) ? 0 : 1.0

  // === Font size extraction ===
  const titleFontSizeMatch = rawText.match(/(?:标题|主标题|title).*?(\d+)(?:px|号|pt)/i)
  const bodyFontSizeMatch = rawText.match(/(?:正文|内容|文字|body|text).*?(\d+)(?:px|号|pt)/i)
  const explicitTitleFontSize = titleFontSizeMatch ? Number(titleFontSizeMatch[1]) : null
  const explicitBodyFontSize = bodyFontSizeMatch ? Number(bodyFontSizeMatch[1]) : null

  // === Line height extraction ===
  const lineHeightMatch = rawText.match(/行高\s*(\d+(?:\.\d+)?)/i)
  const explicitLineHeight = lineHeightMatch ? Number(lineHeightMatch[1]) : null

  // === Font weight extraction ===
  const fontWeightMode = /(特粗|极粗|black)/i.test(rawText) ? 'black' :
                         /(粗体|加粗|bold)/i.test(rawText) ? 'bold' :
                         /(中等|medium)/i.test(rawText) ? 'medium' :
                         /(细体|light)/i.test(rawText) ? 'light' : null

  // === Spacing extraction ===
  const spacingScale = /(间距更大|间距大一点|更宽松|松散)/i.test(rawText) ? 1.3 :
                       /(间距更小|间距小一点|更紧凑|紧密)/i.test(rawText) ? 0.7 : 1.0

  // === Alignment extraction ===
  const alignMode = /(居中|中心对齐|center)/i.test(rawText) ? 'center' :
                    /(右对齐|靠右|align right)/i.test(rawText) ? 'right' :
                    /(左对齐|靠左|align left)/i.test(rawText) ? 'left' : null

  // === Stage 3D: Enhanced Semantic Controls ===

  // Color extraction (hex format)
  const backgroundColorMatch = rawText.match(/(?:背景色|背景颜色|background)[^#]*?(#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3})/i)
  const accentColorMatch = rawText.match(/(?:强调色|主色|accent)[^#]*?(#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3})/i)
  const textColorMatch = rawText.match(/(?:文字颜色|文本颜色|text color)[^#]*?(#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3})/i)

  const explicitBackgroundColor = backgroundColorMatch ? backgroundColorMatch[1] : null
  const explicitAccentColor = accentColorMatch ? accentColorMatch[1] : null
  const explicitTextColor = textColorMatch ? textColorMatch[1] : null

  // Border extraction (support both Chinese and English)
  const borderWidthMatch = rawText.match(/(?:边框|border)\s*(\d+)(?:px)?/i)
  const explicitBorderWidth = borderWidthMatch ? Number(borderWidthMatch[1]) : null

  const explicitBorderStyle = /(边框.*?虚线|虚线边框|dashed)/i.test(rawText) ? 'dashed' :
                              /(边框.*?点线|点线边框|dotted)/i.test(rawText) ? 'dotted' :
                              /(边框.*?实线|实线边框|solid)/i.test(rawText) ? 'solid' : null

  // Precise spacing extraction (support both Chinese and English)
  const paddingMatch = rawText.match(/(?:内边距|padding)\s*(\d+)(?:px)?/i)
  const gapMatch = rawText.match(/(?:间隙|gap)\s*(\d+)(?:px)?/i)

  const explicitPadding = paddingMatch ? Number(paddingMatch[1]) : null
  const explicitGap = gapMatch ? Number(gapMatch[1]) : null

  return {
    // Preset parameters as base
    ...baseControls,
    // Explicitly extracted parameters override preset
    titleScale: titleScale !== 1 ? titleScale : (baseControls.titleScale ?? 1),
    bodyScale: bodyScale !== 1 ? bodyScale : (baseControls.bodyScale ?? 1),
    sectionScale,
    titleZoneRatio: titleZoneRatio && titleZoneRatio > 0.12 && titleZoneRatio < 0.6 ? titleZoneRatio : null,
    titleWidthRatio: prefersSideMeta ? 0.5 : null,
    prefersSparseContent: prefersSparseContent || (baseControls.prefersSparseContent ?? false),
    prefersLargeElements: prefersLargeElements || (baseControls.prefersLargeElements ?? false),
    prefersSideMeta,
    prefersContrastAccent: prefersContrastAccent || (baseControls.prefersContrastAccent ?? false),
    prefersQuietFooter,
    cornerRadiusScale: cornerRadiusScale !== 1.0 ? cornerRadiusScale : (baseControls.cornerRadiusScale ?? 1.0),
    explicitCornerRadius,
    explicitTitleFontSize,
    explicitBodyFontSize,
    explicitLineHeight,
    fontWeightMode,
    spacingScale: spacingScale !== 1.0 ? spacingScale : (baseControls.spacingScale ?? 1.0),
    alignMode,
    stylePreset,
    // Stage 3D: Enhanced controls
    explicitBackgroundColor,
    explicitAccentColor,
    explicitTextColor,
    explicitBorderWidth,
    explicitBorderStyle,
    explicitPadding,
    explicitGap,
  }
}

export function extractDesignColorIntent(text: string): DesignColorIntent | null {
  const patterns: Array<[DesignColorIntent, RegExp]> = [
    ['green', /(绿色|绿调|green|emerald|mint)/i],
    ['red', /(红色|红调|red|crimson|scarlet)/i],
    ['blue', /(蓝色|蓝调|blue|azure|cobalt)/i],
    ['purple', /(紫色|紫调|purple|violet)/i],
    ['orange', /(橙色|橘色|orange|amber)/i],
    ['yellow', /(黄色|金色|yellow|golden)/i],
    ['pink', /(粉色|pink|rose)/i],
    ['teal', /(青色|青绿|teal|cyan|turquoise)/i],
  ]

  for (const [intent, pattern] of patterns) {
    if (pattern.test(text)) return intent
  }
  return null
}

export function applyColorIntentToPalette(basePalette: DesignPalette, text: string): DesignPalette {
  const intent = extractDesignColorIntent(text)
  if (!intent) return basePalette

  const darkVariants: Record<DesignColorIntent, Omit<DesignPalette, 'name'>> = {
    green: {
      background: '#0D1712',
      surface: '#121F18',
      primaryText: '#E6F4EA',
      secondaryText: '#93A89A',
      accent: '#3FB950',
      accentSoft: '#173123',
      contrastAccent: '#F778BA',
    },
    red: {
      background: '#171012',
      surface: '#211519',
      primaryText: '#FBE9EB',
      secondaryText: '#B89AA0',
      accent: '#F85149',
      accentSoft: '#341A20',
      contrastAccent: '#2FB7A8',
    },
    blue: {
      background: '#0D1117',
      surface: '#161B22',
      primaryText: '#E6EDF3',
      secondaryText: '#8B949E',
      accent: '#2F81F7',
      accentSoft: '#1F2937',
      contrastAccent: '#FB8C00',
    },
    purple: {
      background: '#140F19',
      surface: '#1D1526',
      primaryText: '#F2EAFE',
      secondaryText: '#A998BC',
      accent: '#A371F7',
      accentSoft: '#2D1E43',
      contrastAccent: '#E3B341',
    },
    orange: {
      background: '#19120D',
      surface: '#241A12',
      primaryText: '#FFF1E3',
      secondaryText: '#B9A28B',
      accent: '#FB8C00',
      accentSoft: '#382410',
      contrastAccent: '#2F81F7',
    },
    yellow: {
      background: '#18160D',
      surface: '#221F12',
      primaryText: '#FFF7D6',
      secondaryText: '#B9AD7C',
      accent: '#D29922',
      accentSoft: '#362D10',
      contrastAccent: '#A371F7',
    },
    pink: {
      background: '#181016',
      surface: '#231720',
      primaryText: '#FCEAF3',
      secondaryText: '#B99CAC',
      accent: '#DB61A2',
      accentSoft: '#321926',
      contrastAccent: '#2FB7A8',
    },
    teal: {
      background: '#0C1618',
      surface: '#122124',
      primaryText: '#E5F3F4',
      secondaryText: '#92A8AA',
      accent: '#2FB7A8',
      accentSoft: '#163332',
      contrastAccent: '#F85149',
    },
  }

  const lightVariants: Record<DesignColorIntent, Omit<DesignPalette, 'name'>> = {
    green: {
      background: '#F2FAF3',
      surface: '#FCFEFC',
      primaryText: '#193321',
      secondaryText: '#6A7C6E',
      accent: '#3F8F59',
      accentSoft: '#D8ECD9',
      contrastAccent: '#D94692',
    },
    red: {
      background: '#FFF5F4',
      surface: '#FFFDFD',
      primaryText: '#3A2321',
      secondaryText: '#8F6D68',
      accent: '#E15A4F',
      accentSoft: '#F6D8D3',
      contrastAccent: '#0F9C94',
    },
    blue: {
      background: '#F4F8FF',
      surface: '#FFFFFF',
      primaryText: '#18263A',
      secondaryText: '#62748A',
      accent: '#2F6FEB',
      accentSoft: '#DBEAFE',
      contrastAccent: '#EA7A19',
    },
    purple: {
      background: '#FBF7FF',
      surface: '#FFFFFF',
      primaryText: '#2F2142',
      secondaryText: '#77678F',
      accent: '#8B5CF6',
      accentSoft: '#E9DDFE',
      contrastAccent: '#C78A11',
    },
    orange: {
      background: '#FFF8F2',
      surface: '#FFFFFF',
      primaryText: '#3A2614',
      secondaryText: '#8A705C',
      accent: '#EA7A19',
      accentSoft: '#FBE3CB',
      contrastAccent: '#2F6FEB',
    },
    yellow: {
      background: '#FFFBEF',
      surface: '#FFFFFF',
      primaryText: '#3D3215',
      secondaryText: '#8B7C51',
      accent: '#C78A11',
      accentSoft: '#F7E7B0',
      contrastAccent: '#8B5CF6',
    },
    pink: {
      background: '#FFF7FB',
      surface: '#FFFFFF',
      primaryText: '#432135',
      secondaryText: '#8C6B82',
      accent: '#D94692',
      accentSoft: '#F7D8E9',
      contrastAccent: '#0F9C94',
    },
    teal: {
      background: '#F1FBFB',
      surface: '#FFFFFF',
      primaryText: '#173538',
      secondaryText: '#648185',
      accent: '#0F9C94',
      accentSoft: '#D3F0EE',
      contrastAccent: '#E15A4F',
    },
  }

  const variants = basePalette.background.toLowerCase() === '#0d1117' ? darkVariants : lightVariants
  return {
    name: basePalette.name,
    ...variants[intent],
  }
}

export interface DesignGeometryRules {
  badgeShape: 'pill' | 'rectangle'
  indexMarker: 'circle' | 'pill'
  divider: 'line' | 'bar'
  allowStretchedEllipse: boolean
}

export interface DesignBoardPlan {
  width: number
  height: number
  paddingX: number
  paddingTop: number
  paddingBottom: number
  cornerRadius: number
}

export interface DesignTypographyPlan {
  titleFontSize: number
  titleLineHeight: number
  subtitleFontSize: number
  subtitleLineHeight: number
  sectionTitleFontSize: number
  sectionBodyFontSize: number
  sectionLineHeight: number
  badgeFontSize: number
  footerFontSize: number
}

export interface DesignLayoutStrategyPlan {
  align: 'left' | 'split'
  sectionStyle: 'rows' | 'cards' | 'feature-split'
  heroWeight: number
  sectionGap: number
  titleGap: number
  footerMode: 'caption' | 'pill'
}

export interface DesignConstraintFlags {
  ratioExplicit: boolean
  sectionCountExplicit: boolean
  platformExplicit: boolean
}

export interface DesignContentSection {
  id: string
  kind: 'headline' | 'supporting' | 'proof' | 'cta' | 'metric' | 'numbered-item'
  title: string
  body: string
}

export interface DesignStyleGuide {
  palette: DesignPalette
  borderRadius: number
  headlineAlign: 'left' | 'center'
  ornament: 'divider-bar' | 'side-rail' | 'corner-plates' | 'floating-pill' | 'none'
  sectionTone: 'soft' | 'solid' | 'outline'
  ctaWeight: 'none' | 'pill' | 'button'
  density: 'airy' | 'balanced' | 'dense'
  shadow: {
    enabled: boolean
    blur: number
    opacity: number
    offsetY: number
  }
  spacingScale: {
    xs: number
    sm: number
    md: number
    lg: number
    xl: number
  }
  componentMood: 'warm-editorial' | 'dark-technical' | 'clean-neutral'
}

export interface DesignBrief {
  id: string
  taskType: DesignTaskType
  platform: DesignPlatform
  ratio: DesignRatio
  promptText: string
  objective: string
  visualTone: string
  audience: string
  headline: string
  subheadline: string
  contentHierarchy: Array<{
    id: string
    role: 'badge' | 'headline' | 'subtitle' | 'section' | 'meta' | 'cta'
    label: string
    priority: number
    maxLines?: number
  }>
  antiGoals: string[]
  sectionCount: number
}

export interface DesignStyleSystem {
  id: string
  palette: DesignPalette
  typographyTokens: {
    headlineFamily: 'sans' | 'serif' | 'mono'
    headlineWeight: 'bold' | 'black'
    bodyFamily: 'sans' | 'serif' | 'mono'
    bodyWeight: 'regular' | 'medium'
    titleFontSize: number
    titleLineHeight: number
    subtitleFontSize: number
    subtitleLineHeight: number
    sectionTitleFontSize: number
    sectionBodyFontSize: number
    sectionLineHeight: number
    badgeFontSize: number
    metaFontSize: number
    letterSpacing: number
  }
  radiusTokens: {
    board: number
    card: number
    chip: number
  }
  spacingScale: DesignStyleGuide['spacingScale']
  borderRules: {
    enabled: boolean
    width: number
    color: string
    accentWidth: number
  }
  shadowRules: DesignStyleGuide['shadow']
  ornamentRules: {
    mode: 'none' | 'short-line' | 'chip' | 'corner' | 'rail'
    accentAreaLimit: number
    allowLargeEllipse: boolean
  }
  motionRules: {
    emphasis: 'quiet' | 'balanced' | 'expressive'
  }
}

export interface DesignLayoutBlueprint {
  skeleton: 'poster' | 'column' | 'grid' | 'split' | 'staggered'
  titlePlacement: 'top-left' | 'top-center' | 'top-wide' | 'middle-left'
  emphasisPlacement: 'none' | 'hero-band' | 'hero-card' | 'side-card' | 'floating-chip'
  sectionFlow: 'stack' | 'grid' | 'stagger'
  sectionEmphasis: 'uniform' | 'first-large' | 'last-highlight' | 'alternating'
  ornamentMode: 'none' | 'short-line' | 'pill' | 'corner' | 'rail'
  footerStyle: 'caption' | 'pill' | 'meta-strip'
  titleWidthRatio: number
  titleZoneRatio: number
  emphasisWeight: number
  sectionColumns: 1 | 2
  asymmetry: number
}

export interface DesignObservation {
  activeFile: string | null
  selectedIds: string[]
  selectedElementCount: number
  selectionBounds: DesignLayoutBounds | null
  layoutDigest: DesignLayoutDigest | null
  emptySpace: {
    x: number
    y: number
    basis: 'empty-canvas' | 'existing-layout-right' | 'existing-layout-below' | 'viewport-origin' | 'explicit'
  } | null
  currentToolContext: string | null
}

export interface DesignSceneRegion {
  id: string
  role: 'board' | 'header' | 'emphasis' | 'sections' | 'footer'
  xRatio: number
  yRatio: number
  wRatio: number
  hRatio: number
}

export interface DesignSceneNode {
  id: string
  role: string
  kind: 'frame' | 'surface' | 'text' | 'section-card' | 'badge' | 'divider' | 'chip' | 'button' | 'group' | 'geo'
  xRatio: number
  yRatio: number
  wRatio: number
  hRatio: number
  content?: string
  shape?: 'rectangle' | 'ellipse' | 'circle' | 'pill'
  style?: {
    fill?: string
    textColor?: string
    stroke?: string
    strokeWidth?: number
    textAlign?: 'left' | 'center'
    fontFamily?: 'sans' | 'serif' | 'mono'
    fontWeight?: 'regular' | 'medium' | 'bold'
    cornerRadius?: number
    opacity?: number
    variant?: 'primary' | 'secondary' | 'ghost'
  }
  children?: string[]
}

export interface DesignScenePlan {
  id: string
  ratio: DesignRatio
  placementStrategy: DesignPlacementStrategy
  compositionFamily: DesignCompositionFamily
  board: DesignBoardPlan
  layoutBudget: DesignLayoutBudget
  regions: DesignSceneRegion[]
  nodes: DesignSceneNode[]
  bannedMotifs: string[]
  rationale: string[]
}

export interface DesignExecutionProgramStage {
  id: string
  title: string
  goal: string
  role: 'board' | 'header' | 'sections' | 'ornament' | 'footer' | 'repair'
  ops: DesignBatchOp[]
}

export interface DesignExecutionProgram {
  id: string
  scenePlanId: string
  stages: DesignExecutionProgramStage[]
  expectedBoardRole: string
}

export interface DesignRepairPlan {
  id: string
  reason: string
  strategy: 'rebuild-board' | 'tighten-layout' | 'remove-motif' | 'restack-sections'
  targets: string[]
  notes: string[]
}

export interface DesignLayoutBudget {
  boardWidth: number
  boardHeight: number
  paddingX: number
  paddingTop: number
  paddingBottom: number
  titleMaxLines: number
  subtitleMaxLines: number
  sectionMaxLines: number
  footerMaxLines: number
  titleZoneHeight: number
  sectionsZoneHeight: number
  footerZoneHeight: number
}

export interface DesignExecutionOpDescriptor {
  name: string
  role: string
}

export interface DesignExecutionStep {
  id: string
  phase: DesignControllerPhase
  title: string
  goal: string
  successCriteria: string[]
  failureCriteria: string[]
  batchOps: DesignBatchOp[]
  opDescriptors: DesignExecutionOpDescriptor[]
  rollbackIds: string[]
}

export interface DesignReviewIssue {
  code: 'ratio-mismatch' | 'overflow' | 'duplicate-node' | 'structure-mismatch' | 'selection-conflict' | 'visual-rhythm'
  severity: 'warning' | 'error'
  message: string
}

export interface DesignReviewReport {
  passed: boolean
  geometryPassed: boolean
  screenshotPassed: boolean
  attempts: number
  executionBatches: number
  repairRounds: number
  usedScreenshotVerification: boolean
  touchedSelection: boolean
  issues: DesignReviewIssue[]
  summary: string
}

export interface DesignIntentPlan {
  taskType: DesignTaskType
  platform: DesignPlatform
  ratio: DesignRatio
  audience: string
  tone: string
  themeKeywords: string[]
  palette: DesignPalette
  compositionFamily: DesignCompositionFamily
  sectionCount: number
  contentSections: DesignContentSection[]
  placementStrategy: DesignPlacementStrategy
  geometryRules: DesignGeometryRules
  board: DesignBoardPlan
  typography: DesignTypographyPlan
  layoutStrategy: DesignLayoutStrategyPlan
  constraintFlags: DesignConstraintFlags
  semanticControls?: DesignSemanticControls
  reviewChecklist: string[]
  observation?: DesignObservation
  brief?: DesignBrief
  styleGuide?: DesignStyleGuide
  styleSystem?: DesignStyleSystem
  layoutBlueprint?: DesignLayoutBlueprint
  layoutBudget?: DesignLayoutBudget
  scenePlan?: DesignScenePlan
  executionProgram?: DesignExecutionProgram | null
  executionSteps?: DesignExecutionStep[]
  reviewReport?: DesignReviewReport | null
  repairPlan?: DesignRepairPlan | null
  repairScope?: DesignRepairScope
  decisionTrace?: string[]
  reasoningSummary: string
}

export interface DesignWorkPlan extends DesignIntentPlan {
  observation: DesignObservation
  brief: DesignBrief
  styleGuide: DesignStyleGuide
  styleSystem: DesignStyleSystem
  semanticControls: DesignSemanticControls
  layoutBudget: DesignLayoutBudget
  scenePlan: DesignScenePlan
  executionProgram: DesignExecutionProgram
  executionSteps: DesignExecutionStep[]
  reviewReport: DesignReviewReport | null
  repairScope: DesignRepairScope
}

export interface DesignRequestSpec {
  taskType: DesignTaskType
  promptText: string
  platform?: DesignPlatform
  ratio?: DesignRatio
  sectionCount?: number
  repairScope?: DesignRepairScope
  requestedAt: string
  rawArgs: Record<string, unknown>
}

export interface DesignResolvedPlan {
  observation: DesignObservation
  brief: DesignBrief
  styleGuide: DesignStyleGuide
  styleSystem: DesignStyleSystem
  semanticControls: DesignSemanticControls
  layoutBudget: DesignLayoutBudget
  scenePlan: DesignScenePlan
  executionProgram: DesignExecutionProgram
  executionSteps: DesignExecutionStep[]
  repairScope: DesignRepairScope
}

export interface DesignMutationStats {
  boardCreates: number
  boardDeletes: number
  boardRebuilds: number
  sectionRebuilds: number
  executionBatches: number
  repairRounds: number
  touchedSelection: boolean
}

export interface DesignExecutionResult {
  status: 'success' | 'failed' | 'cancelled'
  summary: string
  ratio?: DesignRatio
  boardId?: string | null
  ownedNodeIds: string[]
  review: {
    passed: boolean
    geometryPassed: boolean
    screenshotPassed: boolean
    summary: string
    issues: DesignReviewIssue[]
  }
  mutationStats: DesignMutationStats
  artifactRefs?: Array<Record<string, unknown>>
}

export interface DesignRunCapture {
  runId: string
  request: DesignRequestSpec
  observation: DesignObservation
  resolvedPlan: DesignResolvedPlan
  mutationStats: DesignMutationStats
  review: DesignReviewReport
  boardId: string | null
  ownedNodeIds: string[]
  screenshotPath: string | null
  createdAt: string
}

export interface DesignLayoutBounds {
  x: number
  y: number
  w: number
  h: number
}

export interface DesignLayoutRegion extends DesignLayoutBounds {
  id: string
  type: string
  label: string
}

export interface DesignLayoutDigest {
  topLevelElementCount: number
  mainBounds: DesignLayoutBounds | null
  regions: DesignLayoutRegion[]
  selectionSummary: string | null
  selectedElementCount?: number
  selectionBounds?: DesignLayoutBounds | null
  latestReviewSummary?: string | null
}

export type DesignBatchOp =
  | {
    op: 'create'
    target: 'text'
    x?: number
    y?: number
    text: string
    name?: string
    role?: string
    meta?: Record<string, unknown>
    styleTokens?: Record<string, unknown>
  }
  | {
    op: 'create'
    target: 'geo'
    x?: number
    y?: number
    w?: number
    h?: number
    shape: 'rectangle' | 'ellipse' | 'circle' | 'pill'
    label?: string
    fillColor?: string
    textColor?: string
    name?: string
    role?: string
    meta?: Record<string, unknown>
    styleTokens?: Record<string, unknown>
  }
  | {
    op: 'create'
    target: 'frame'
    x?: number
    y?: number
    w?: number
    h?: number
    name?: string
    role?: string
    meta?: Record<string, unknown>
    styleTokens?: Record<string, unknown>
  }
  | {
    op: 'create'
    target: 'component'
    x?: number
    y?: number
    component: string
    props?: Record<string, unknown>
    name?: string
    role?: string
    meta?: Record<string, unknown>
    styleTokens?: Record<string, unknown>
  }
  | {
    op: 'update'
    id: string
    x?: number
    y?: number
    props?: Record<string, unknown>
    meta?: Record<string, unknown>
    styleTokens?: Record<string, unknown>
  }
  | {
    op: 'group'
    ids: string[]
    name?: string
    role?: string
    meta?: Record<string, unknown>
  }
  | {
    op: 'z-order'
    ids: string[]
    mode: 'front' | 'back' | 'forward' | 'backward'
  }
  | {
    op: 'delete'
    ids: string[]
  }
  | {
    op: 'select'
    ids: string[]
  }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isDesignLayoutDigest(value: unknown): value is DesignLayoutDigest {
  if (!isPlainRecord(value)) return false
  const regions = value.regions
  const mainBounds = value.mainBounds
  return (
    isFiniteNumber(value.topLevelElementCount)
    && (value.selectionSummary === null || typeof value.selectionSummary === 'string' || value.selectionSummary === undefined)
    && (value.selectedElementCount === undefined || isFiniteNumber(value.selectedElementCount))
    && (value.latestReviewSummary === undefined || value.latestReviewSummary === null || typeof value.latestReviewSummary === 'string')
    && Array.isArray(regions)
    && (mainBounds === null || mainBounds === undefined || (
      isPlainRecord(mainBounds)
      && isFiniteNumber(mainBounds.x)
      && isFiniteNumber(mainBounds.y)
      && isFiniteNumber(mainBounds.w)
      && isFiniteNumber(mainBounds.h)
    ))
    && (value.selectionBounds === null || value.selectionBounds === undefined || (
      isPlainRecord(value.selectionBounds)
      && isFiniteNumber(value.selectionBounds.x)
      && isFiniteNumber(value.selectionBounds.y)
      && isFiniteNumber(value.selectionBounds.w)
      && isFiniteNumber(value.selectionBounds.h)
    ))
  )
}

export function coerceDesignLayoutDigest(value: unknown): DesignLayoutDigest | null {
  if (!isDesignLayoutDigest(value)) return null
  const regions = Array.isArray(value.regions)
    ? value.regions
      .filter((region) => isPlainRecord(region))
      .map((region, index) => ({
        id: typeof region.id === 'string' ? region.id : `region-${index}`,
        type: typeof region.type === 'string' ? region.type : 'shape',
        label: typeof region.label === 'string' ? region.label : '区域',
        x: Number(region.x || 0),
        y: Number(region.y || 0),
        w: Number(region.w || 0),
        h: Number(region.h || 0),
      }))
      .filter((region) => Number.isFinite(region.w) && Number.isFinite(region.h))
    : []

  const mainBounds = isPlainRecord(value.mainBounds)
    ? {
      x: Number(value.mainBounds.x || 0),
      y: Number(value.mainBounds.y || 0),
      w: Number(value.mainBounds.w || 0),
      h: Number(value.mainBounds.h || 0),
    }
    : null

  return {
    topLevelElementCount: Number(value.topLevelElementCount || 0),
    mainBounds,
    regions,
    selectionSummary: typeof value.selectionSummary === 'string' ? value.selectionSummary : null,
    selectedElementCount: typeof value.selectedElementCount === 'number' ? Number(value.selectedElementCount) : undefined,
    selectionBounds: isPlainRecord(value.selectionBounds)
      ? {
        x: Number(value.selectionBounds.x || 0),
        y: Number(value.selectionBounds.y || 0),
        w: Number(value.selectionBounds.w || 0),
        h: Number(value.selectionBounds.h || 0),
      }
      : null,
    latestReviewSummary: typeof value.latestReviewSummary === 'string' ? value.latestReviewSummary : null,
  }
}

export function formatDesignLayoutDigest(digest: DesignLayoutDigest | null | undefined): string[] {
  if (!digest) return []
  const lines = [
    `- 画布元素: ${digest.topLevelElementCount} 个`,
    digest.mainBounds
      ? `- 主边界框: (${digest.mainBounds.x}, ${digest.mainBounds.y}) ${digest.mainBounds.w}x${digest.mainBounds.h}`
      : '- 主边界框: 无',
    digest.selectionSummary ? `- 选择状态: ${digest.selectionSummary}` : null,
    typeof digest.selectedElementCount === 'number' ? `- 选择元素数: ${digest.selectedElementCount}` : null,
    digest.selectionBounds
      ? `- 选择边界: (${digest.selectionBounds.x}, ${digest.selectionBounds.y}) ${digest.selectionBounds.w}x${digest.selectionBounds.h}`
      : null,
    digest.latestReviewSummary ? `- 最近复查: ${digest.latestReviewSummary}` : null,
    digest.regions.length > 0
      ? `- 大板块: ${digest.regions.slice(0, 4).map((region) => `${region.label}@(${region.x},${region.y}) ${region.w}x${region.h}`).join(' | ')}`
      : '- 大板块: 无',
    `- 布局摘要JSON: ${JSON.stringify(digest)}`,
  ].filter(Boolean) as string[]

  return lines
}
