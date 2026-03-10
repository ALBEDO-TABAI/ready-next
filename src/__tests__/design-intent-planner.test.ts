import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildDesignIntentPlan, formatDesignPlannerPrompt } from '../main/modules/claude-bridge/design-intent-planner'

describe('design intent planner', () => {
  it('produces different cover plans for xiaohongshu warm cover vs github dark technical cover', () => {
    const warm = buildDesignIntentPlan({
      rawUserText: '在画板新建一个竖向 9:16 的小红书封面版式，要有 4 组文案信息，给我一个排版很好的框架让我直接替换内容就行',
      primaryInstruction: '在画板新建一个竖向 9:16 的小红书封面版式，要有 4 组文案信息，给我一个排版很好的框架让我直接替换内容就行',
    })
    const github = buildDesignIntentPlan({
      rawUserText: '重新建一个竖向 3:4 的画板，有 2 组文案信息，有点 github 的风格和黑色，让画面多一点按钮的感觉',
      primaryInstruction: '重新建一个竖向 3:4 的画板，有 2 组文案信息，有点 github 的风格和黑色，让画面多一点按钮的感觉',
    })

    assert.equal(warm.plan.platform, 'xiaohongshu')
    assert.equal(warm.plan.ratio, '9:16')
    assert.equal(warm.plan.palette.name, 'warm-editorial')
    assert.equal(warm.plan.compositionFamily, 'numbered-list')
    assert.equal(warm.plan.sectionCount, 4)
    assert.equal(warm.plan.board.height, 960)
    assert.equal(warm.plan.styleGuide?.componentMood, 'warm-editorial')
    assert.equal(warm.plan.layoutBlueprint?.skeleton, 'staggered')
    assert.equal(warm.plan.layoutBudget?.boardHeight, 960)
    assert.equal(warm.plan.repairScope, 'selected')
    assert.equal(warm.plan.constraintFlags.ratioExplicit, true)
    assert.ok(warm.plan.brief)
    assert.ok(warm.plan.styleSystem)
    assert.ok(warm.plan.scenePlan)
    assert.equal(warm.plan.brief?.sectionCount, 4)
    assert.match(String(warm.plan.brief?.headline || ''), /主标题/)
    assert.ok((warm.plan.scenePlan?.nodes || []).length >= 6)
    assert.ok(warm.plan.reviewChecklist.length >= 3)
    assert.ok(Array.isArray(warm.plan.decisionTrace))
    assert.ok((warm.plan.decisionTrace || []).length >= 4)
    assert.match(warm.instructionText, /小红书封面版式/)

    assert.equal(github.plan.ratio, '3:4')
    assert.equal(github.plan.palette.name, 'github-dark')
    assert.equal(github.plan.compositionFamily, 'split-feature')
    assert.equal(github.plan.sectionCount, 2)
    assert.equal(github.plan.board.height, 720)
    assert.equal(github.plan.layoutStrategy.align, 'split')
    assert.equal(github.plan.styleGuide?.componentMood, 'dark-technical')
    assert.equal(github.plan.layoutBlueprint?.skeleton, 'grid')
    assert.equal(github.plan.styleGuide?.ctaWeight, 'button')
    assert.equal(github.plan.layoutBlueprint?.footerStyle, 'pill')
    assert.equal(github.plan.layoutBudget?.boardHeight, 720)
    assert.ok(github.plan.brief?.antiGoals.includes('不要大椭圆'))
    assert.equal(github.plan.styleSystem?.palette.name, 'github-dark')
    assert.ok((github.plan.scenePlan?.bannedMotifs || []).some((item) => /按钮母题/.test(item)))
    assert.ok((github.plan.scenePlan?.nodes || []).some((node) => node.role === 'cta-button'))
    assert.notEqual(warm.plan.reasoningSummary, github.plan.reasoningSummary)
    assert.notDeepEqual(warm.plan.decisionTrace, github.plan.decisionTrace)
    assert.notDeepEqual(warm.plan.layoutBlueprint, github.plan.layoutBlueprint)
    assert.notDeepEqual(warm.plan.scenePlan, github.plan.scenePlan)
  })

  it('uses layout digest hints to change placement strategy when an existing canvas is tall', () => {
    const withDigest = buildDesignIntentPlan({
      rawUserText: [
        '在画板新建一个竖向 9:16 的小红书封面版式',
        '### 当前设计画布上下文',
        '- 布局摘要JSON: {"topLevelElementCount":5,"mainBounds":{"x":0,"y":0,"w":540,"h":1280},"regions":[],"selectionSummary":"未选中元素"}',
      ].join('\n'),
      primaryInstruction: '在画板新建一个竖向 9:16 的小红书封面版式',
    })

    assert.equal(withDigest.plan.placementStrategy, 'auto-below')
    assert.match(formatDesignPlannerPrompt(withDigest), /placementStrategy: auto-below/)
    assert.match(formatDesignPlannerPrompt(withDigest), /styleGuide:/)
    assert.match(formatDesignPlannerPrompt(withDigest), /brief:/)
    assert.match(formatDesignPlannerPrompt(withDigest), /styleSystem:/)
    assert.match(formatDesignPlannerPrompt(withDigest), /layoutBlueprint:/)
    assert.match(formatDesignPlannerPrompt(withDigest), /layoutBudget:/)
    assert.match(formatDesignPlannerPrompt(withDigest), /scenePlan:/)
    assert.match(formatDesignPlannerPrompt(withDigest), /reviewChecklist:/)
  })

  it('recognizes explicit 16:9 requests and plans a landscape board instead of falling back to portrait', () => {
    const landscape = buildDesignIntentPlan({
      rawUserText: '做一个 github 风格的 16:9 封面排版，黑灰技术感，2 组信息，标题居中一点',
      primaryInstruction: '做一个 github 风格的 16:9 封面排版，黑灰技术感，2 组信息，标题居中一点',
    })

    assert.equal(landscape.plan.ratio, '16:9')
    assert.equal(landscape.plan.board.width, 960)
    assert.equal(landscape.plan.board.height, 540)
    assert.equal(landscape.plan.layoutBudget?.boardWidth, 960)
    assert.equal(landscape.plan.layoutBudget?.boardHeight, 540)
    assert.ok(['split', 'grid'].includes(String(landscape.plan.layoutBlueprint?.skeleton || '')))
    assert.match(formatDesignPlannerPrompt(landscape), /16:9/)
  })

  it('recognizes explicit 4:3 requests and does not coerce them to 16:9 just because the prompt says landscape', () => {
    const landscapeFourThree = buildDesignIntentPlan({
      rawUserText: '生成一个横向 4:3 的 youtube 封面排版，黑灰技术感，3 组信息',
      primaryInstruction: '生成一个横向 4:3 的 youtube 封面排版，黑灰技术感，3 组信息',
    })

    assert.equal(landscapeFourThree.plan.ratio, '4:3')
    assert.equal(landscapeFourThree.plan.board.width, 720)
    assert.equal(landscapeFourThree.plan.board.height, 540)
    assert.equal(landscapeFourThree.plan.layoutBudget?.boardWidth, 720)
    assert.equal(landscapeFourThree.plan.layoutBudget?.boardHeight, 540)
    assert.match(formatDesignPlannerPrompt(landscapeFourThree), /4:3/)
  })

  it('keeps an explicit numeric ratio even when an orientation keyword appears later in the sentence', () => {
    const fixed = buildDesignIntentPlan({
      rawUserText: '生成一个 4:3 的 youtube 封面横向排版，黑灰技术感，3 组信息，不要按钮',
      primaryInstruction: '生成一个 4:3 的 youtube 封面横向排版，黑灰技术感，3 组信息，不要按钮',
    })

    assert.equal(fixed.plan.ratio, '4:3')
    assert.equal(fixed.plan.board.width, 720)
    assert.equal(fixed.plan.board.height, 540)
  })

  it('falls back to the current design board ratio when a follow-up prompt omits explicit ratio', () => {
    const followUp = buildDesignIntentPlan({
      rawUserText: [
        '标题再偏左一点，不要按钮，底部轻一点。',
        '### 当前设计画布上下文',
        '- 布局摘要JSON: {"topLevelElementCount":9,"mainBounds":{"x":0,"y":0,"w":540,"h":960},"regions":[],"selectionSummary":"未选中元素"}',
      ].join('\n'),
      primaryInstruction: '标题再偏左一点，不要按钮，底部轻一点。',
    })

    assert.equal(followUp.plan.ratio, '9:16')
    assert.equal(followUp.plan.board.height, 960)
    assert.ok(['poster', 'staggered', 'column'].includes(String(followUp.plan.layoutBlueprint?.skeleton || '')))
  })

  it('prefers the current primary instruction ratio over older context ratios', () => {
    const square = buildDesignIntentPlan({
      rawUserText: [
        '### L1 会话上下文',
        '用户: 先做一个 16:9 的 github 风格封面',
        '助手: 已记录 16:9 技术风方向。',
        '',
        '生成一个 1:1 的 github 风格的排版设计',
      ].join('\n'),
      primaryInstruction: '生成一个 1:1 的 github 风格的排版设计',
    })

    assert.equal(square.plan.ratio, '1:1')
    assert.equal(square.plan.board.width, 540)
    assert.equal(square.plan.board.height, 540)
    assert.equal(square.plan.layoutBudget?.boardWidth, 540)
    assert.equal(square.plan.layoutBudget?.boardHeight, 540)
    assert.equal(square.plan.constraintFlags.ratioExplicit, true)
    assert.match(formatDesignPlannerPrompt(square), /1:1/)
  })

  it('does not infer button-heavy split layout from github style alone', () => {
    const github = buildDesignIntentPlan({
      rawUserText: '生成一个 1:1 的 github 风格封面排版，黑灰技术感，3 组信息，不需要你额外加按钮',
      primaryInstruction: '生成一个 1:1 的 github 风格封面排版，黑灰技术感，3 组信息，不需要你额外加按钮',
    })

    assert.equal(github.plan.ratio, '1:1')
    assert.equal(github.plan.styleGuide?.ctaWeight, 'none')
    assert.notEqual(github.plan.compositionFamily, 'split-feature')
    assert.notEqual(github.plan.layoutBlueprint?.footerStyle, 'meta-strip')
    assert.equal((github.plan.scenePlan?.nodes || []).some((node) => node.role === 'cta-button'), false)
  })

  it('maps explicit color requests into the resolved palette instead of ignoring them', () => {
    const green = buildDesignIntentPlan({
      rawUserText: '生成一个 1:1 的 github 风格封面，绿色主题，黑灰技术感，3 组信息，不要按钮',
      primaryInstruction: '生成一个 1:1 的 github 风格封面，绿色主题，黑灰技术感，3 组信息，不要按钮',
    })

    assert.equal(green.plan.ratio, '1:1')
    assert.equal(green.plan.palette.name, 'github-dark')
    assert.equal(green.plan.palette.accent, '#3FB950')
    assert.equal(green.plan.palette.background, '#0D1712')
    assert.equal(green.plan.styleSystem?.palette.accent, '#3FB950')
  })

  it('turns explicit title-area and sparse-content instructions into semantic controls and layout budget changes', () => {
    const sparse = buildDesignIntentPlan({
      rawUserText: '做一个 3:4 的小红书封面，标题要占画幅 1/3，只有标题和标题旁边的附加信息，字要更大',
      primaryInstruction: '做一个 3:4 的小红书封面，标题要占画幅 1/3，只有标题和标题旁边的附加信息，字要更大',
    })

    assert.equal(sparse.plan.ratio, '3:4')
    assert.equal(sparse.plan.sectionCount, 1)
    assert.equal(sparse.plan.semanticControls?.prefersSideMeta, true)
    assert.equal(sparse.plan.semanticControls?.prefersSparseContent, true)
    assert.equal(sparse.plan.layoutBlueprint?.emphasisPlacement, 'side-card')
    assert.ok((sparse.plan.semanticControls?.titleZoneRatio || 0) >= 0.32)
    assert.ok((sparse.plan.layoutBudget?.titleZoneHeight || 0) >= 220)
    assert.ok((sparse.plan.typography.titleFontSize || 0) >= 36)
  })

  it('keeps contrast-accent intent in the palette and style system for red youtube covers', () => {
    const red = buildDesignIntentPlan({
      rawUserText: '生成一个 1920x1080 的 youtube 封面排版，红色主题，加一点对色，有两级排版结构',
      primaryInstruction: '生成一个 1920x1080 的 youtube 封面排版，红色主题，加一点对色，有两级排版结构',
    })

    assert.equal(red.plan.palette.accent, '#E15A4F')
    assert.equal(red.plan.palette.contrastAccent, '#0F9C94')
    assert.equal(red.plan.styleSystem?.palette.contrastAccent, '#0F9C94')
    assert.equal(red.plan.semanticControls?.prefersContrastAccent, true)
  })

  it('diversifies the scene plan for explicit different-version requests and preserves negative constraints', () => {
    const base = buildDesignIntentPlan({
      rawUserText: '做一个 github 风格的 9:16 封面，黑灰技术感，3 组信息，有一点按钮感',
      primaryInstruction: '做一个 github 风格的 9:16 封面，黑灰技术感，3 组信息，有一点按钮感',
    })
    const variation = buildDesignIntentPlan({
      rawUserText: '再来一个不同版式的 9:16 github 风格封面，还是黑灰技术感，3 组信息，但不要按钮，不要粗线，更克制一点',
      primaryInstruction: '再来一个不同版式的 9:16 github 风格封面，还是黑灰技术感，3 组信息，但不要按钮，不要粗线，更克制一点',
    })

    assert.equal(variation.plan.ratio, '9:16')
    assert.equal(variation.plan.palette.name, 'github-dark')
    assert.equal(variation.plan.styleGuide?.ctaWeight, 'none')
    assert.ok(variation.plan.reviewChecklist.some((item) => /不要按钮/.test(item)))
    assert.ok(variation.plan.brief?.antiGoals.some((item) => /不要按钮|模板母题/.test(item)))
    assert.ok(
      base.plan.layoutBlueprint?.skeleton !== variation.plan.layoutBlueprint?.skeleton
      || base.plan.compositionFamily !== variation.plan.compositionFamily,
    )
    assert.equal((variation.plan.scenePlan?.nodes || []).some((node) => node.role === 'cta-button'), false)
    assert.ok((variation.plan.decisionTrace || []).some((item) => /不同版式|母题/.test(item)))
  })
})
