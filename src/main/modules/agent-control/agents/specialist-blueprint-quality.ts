import type {
  SpecialistAgentBlueprint,
  SpecialistBlueprintQualityCheck,
  SpecialistBlueprintToolBoundaries,
  SpecialistBlueprintToolBoundary,
} from '../../../../shared/agent-specialist-blueprint'

export const SPECIALIST_FOUNDATION_PACK_VERSION = 'p8g-9c.v1'

export const SPECIALIST_FOUNDATION_PACK_SECTIONS = [
  { id: 'provenance', heading: '## Provenance' },
  { id: 'rolePersona', heading: '## Role Persona' },
  { id: 'charter', heading: '## Charter' },
  { id: 'operatingModel', heading: '## Operating Model' },
  { id: 'scope', heading: '## Scope' },
  { id: 'taskExamples', heading: '## Task Examples' },
  { id: 'mainVsSpecialistSplit', heading: '## Main vs Specialist Split' },
  { id: 'inputs', heading: '## Inputs' },
  { id: 'outputs', heading: '## Outputs' },
  { id: 'rules', heading: '## Rules' },
  { id: 'knowledgeSeeds', heading: '## Knowledge Seeds' },
  { id: 'routing', heading: '## Routing' },
  { id: 'toolBoundaries', heading: '## Tool Boundaries' },
  { id: 'memoryProfilePolicy', heading: '## Memory/Profile Policy' },
  { id: 'lifecycle', heading: '## Lifecycle' },
  { id: 'qualityChecks', heading: '## Quality Checks' },
] as const

const TRIGGER_FORBIDDEN_PATTERN = /[*?[\]{}()|\\^$+]/
const ALWAYS_GENERIC_TEXT_PATTERNS = [
  /\bTODO\b/i,
  /\bTBD\b/i,
  /\bxxx\b/i,
  /待定/,
  /暂无/,
  /^none$/i,
  /^n\/a$/i,
  /^示例[:：]?$/,
  /^例如[:：]?$/,
]
const SHORT_GENERIC_TEXT_PATTERNS = [
  /按用户要求/,
  /根据用户(?:需求|要求)/,
  /输出结果/,
  /注意安全/,
  /不做无关/,
]

const GENERIC_ANCHORS = new Set([
  'agent',
  '专项',
  '智能体',
  '任务',
  '用户',
  '需求',
  '输出',
  '结果',
])

export interface SpecialistBlueprintQualityEvaluation {
  checks: SpecialistBlueprintQualityCheck[]
  blockingIssueIds: string[]
  passed: boolean
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '')
}

function isGenericText(value: string): boolean {
  const text = value.trim()
  if (!text) return true
  if (ALWAYS_GENERIC_TEXT_PATTERNS.some((pattern) => pattern.test(text))) return true
  return text.length < 40 && SHORT_GENERIC_TEXT_PATTERNS.some((pattern) => pattern.test(text))
}

function isConcreteText(value: string, minLength = 12): boolean {
  const text = value.trim()
  return text.length >= minLength && !isGenericText(text)
}

function isRequestEcho(value: string, userRequest: string): boolean {
  const text = normalizeText(value)
  const request = normalizeText(userRequest)
  if (!text || !request) return false
  if (text === request) return true
  return text.length >= 10 && request.includes(text)
}

function listHasConcreteItems(values: readonly string[], minItems: number): boolean {
  return values.length >= minItems && values.every((item) => isConcreteText(item, 4))
}

function listsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const left = a.map(normalizeText).filter(Boolean)
  const right = b.map(normalizeText).filter(Boolean)
  return left.some((item) => right.some((other) => item === other || item.includes(other) || other.includes(item)))
}

function anchorParts(value: string): string[] {
  const compact = normalizeText(value)
  if (!compact || isGenericText(value)) return []
  const parts = value
    .split(/[\s,，、/|;；:：()（）[\]【】"'“”]+/)
    .map(normalizeText)
    .filter((item) => item.length >= 2 && !GENERIC_ANCHORS.has(item))
  return [
    compact.length >= 2 && !GENERIC_ANCHORS.has(compact) ? compact : '',
    ...parts,
  ].filter(Boolean)
}

function domainAnchors(blueprint: SpecialistAgentBlueprint): string[] {
  const anchors = [
    ...anchorParts(blueprint.intendedDomain),
    ...blueprint.routingTriggers.flatMap(anchorParts),
  ]
  return [...new Set(anchors)].slice(0, 12)
}

function foundationMentionsDomainAnchors(blueprint: SpecialistAgentBlueprint): boolean {
  const anchors = domainAnchors(blueprint)
  if (anchors.length === 0) return false
  const body = normalizeText([
    blueprint.charter,
    blueprint.rolePersona,
    blueprint.mainVsSpecialistSplit,
    blueprint.seedRulesText,
    blueprint.toolSafetyNotes,
    blueprint.taskExamples.suitable.join('\n'),
    blueprint.taskExamples.unsuitable.join('\n'),
    blueprint.recurringTasks.join('\n'),
    blueprint.expectedOutputs.join('\n'),
  ].join('\n'))
  return anchors.some((anchor) => body.includes(anchor))
}

function boundaryIsComplete(boundary: SpecialistBlueprintToolBoundary): boolean {
  return isConcreteText(boundary.notes, 8)
}

function riskyAllowHasJustification(boundary: SpecialistBlueprintToolBoundary): boolean {
  if (boundary.mode !== 'allow') return true
  return isConcreteText(boundary.notes, 8)
}

function boundariesComplete(boundaries: SpecialistBlueprintToolBoundaries): boolean {
  return [
    boundaries.browser,
    boundaries.write,
    boundaries.externalSend,
    boundaries.longMemory,
  ].every(boundaryIsComplete)
}

function riskyBoundariesJustified(boundaries: SpecialistBlueprintToolBoundaries): boolean {
  return [
    boundaries.write,
    boundaries.externalSend,
    boundaries.longMemory,
  ].every(riskyAllowHasJustification)
}

function routingTriggersAreLiteral(triggers: readonly string[]): boolean {
  return triggers.length > 0
    && triggers.length <= 8
    && triggers.every((trigger) => {
      const text = trigger.trim()
      return text.length > 0 && text.length <= 32 && !TRIGGER_FORBIDDEN_PATTERN.test(text) && !isGenericText(text)
    })
}

function knowledgeSeedsHaveEvidence(blueprint: SpecialistAgentBlueprint): boolean {
  return blueprint.knowledgeSeeds.length === 0
    || blueprint.knowledgeSeeds.every((seed) => (
      isConcreteText(seed.title, 4)
      && isConcreteText(seed.body, 8)
      && seed.evidenceRefs.some((ref) => isConcreteText(ref, 3))
    ))
}

function makeCheck(check: string, pass: boolean, message: string): SpecialistBlueprintQualityCheck {
  return { check, pass, blocking: !pass, message }
}

export function evaluateSpecialistBlueprintQuality(
  blueprint: SpecialistAgentBlueprint,
): SpecialistBlueprintQualityEvaluation {
  const userRequest = blueprint.userRequestVerbatim || blueprint.provenance.userRequestVerbatim
  const checks = [
    makeCheck(
      'charter',
      isConcreteText(blueprint.charter, 18) && !isRequestEcho(blueprint.charter, userRequest),
      '职责范围需要比用户原话更具体。',
    ),
    makeCheck(
      'rolePersona',
      isConcreteText(blueprint.rolePersona, 18) && !isRequestEcho(blueprint.rolePersona, userRequest),
      '需要写清这个专项 agent 的角色、人设和判断口径。',
    ),
    makeCheck('nonGoals', listHasConcreteItems(blueprint.nonGoals, 2), '至少需要两个具体不做事项。'),
    makeCheck('recurringTasks', listHasConcreteItems(blueprint.recurringTasks, 2), '至少需要两类会反复处理的任务。'),
    makeCheck('requiredInputs', listHasConcreteItems(blueprint.requiredInputs, 2), '至少需要两个开始工作前所需输入。'),
    makeCheck('expectedOutputs', listHasConcreteItems(blueprint.expectedOutputs, 2), '至少需要两个具体交付物。'),
    makeCheck(
      'taskExamples',
      listHasConcreteItems(blueprint.taskExamples.suitable, 1)
        && listHasConcreteItems(blueprint.taskExamples.unsuitable, 1),
      '需要各写至少一个适合和不适合交给它的任务例子。',
    ),
    makeCheck(
      'mainVsSpecialistSplit',
      isConcreteText(blueprint.mainVsSpecialistSplit, 18),
      '需要写清主 agent 和专项 agent 的分工边界。',
    ),
    makeCheck(
      'professionalSpecificity',
      foundationMentionsDomainAnchors(blueprint),
      '基础文档需要落到具体领域、触发词或长期工作对象，不能只写通用工作方法。',
    ),
    makeCheck(
      'seedRulesText',
      isConcreteText(blueprint.seedRulesText, 24) && !isRequestEcho(blueprint.seedRulesText, userRequest),
      '初始规则必须是可执行规则，不是口号或用户原话复述。',
    ),
    makeCheck('knowledgeSeeds', knowledgeSeedsHaveEvidence(blueprint), '知识种子需要内容和证据引用。'),
    makeCheck('toolBoundaries', boundariesComplete(blueprint.toolBoundaries), '浏览器、写入、外发、长期记忆边界都需要说明。'),
    makeCheck('toolBoundaries', riskyBoundariesJustified(blueprint.toolBoundaries), '允许写入、外发或长期记忆时必须写清理由。'),
    makeCheck(
      'toolSafetyNotes',
      isConcreteText(blueprint.toolSafetyNotes, 14),
      '安全说明需要覆盖真实风险，不是泛泛提醒。',
    ),
    makeCheck(
      'memoryProfilePolicy',
      isConcreteText(blueprint.memoryProfilePolicy, 18),
      '需要写清它如何使用长期记忆和用户画像。',
    ),
    makeCheck(
      'lifecycleNotes',
      isConcreteText(blueprint.lifecycleNotes, 18),
      '需要写清后续如何维护、退休或合并。',
    ),
    makeCheck(
      'recurringTasks',
      !listsOverlap(blueprint.recurringTasks, blueprint.nonGoals),
      '常规任务不能和不做事项重叠。',
    ),
    makeCheck('routingTriggers', routingTriggersAreLiteral(blueprint.routingTriggers), '路由触发词必须是短字面关键词。'),
  ]
  const blockingIssueIds = [...new Set(checks.filter((check) => !check.pass).map((check) => check.check))]
  return { checks, blockingIssueIds, passed: blockingIssueIds.length === 0 }
}

export function assertSpecialistBlueprintQualityPasses(blueprint: SpecialistAgentBlueprint): void {
  const evaluation = evaluateSpecialistBlueprintQuality(blueprint)
  if (!evaluation.passed) {
    throw new Error(`[specialist-blueprint-quality] blocking issues: ${evaluation.blockingIssueIds.join(', ')}`)
  }
}

function renderBoundary(label: string, boundary: SpecialistBlueprintToolBoundary): string {
  return `- ${label}: ${boundary.mode} - ${boundary.notes}`
}

function renderList(values: readonly string[]): string {
  return values.length > 0 ? values.map((item) => `- ${item}`).join('\n') : '- none'
}

function renderSeeds(blueprint: SpecialistAgentBlueprint): string {
  if (blueprint.knowledgeSeeds.length === 0) return '- none'
  return blueprint.knowledgeSeeds.map((seed) => [
    `- ${seed.title}`,
    `  - ${seed.body}`,
    `  - Evidence: ${seed.evidenceRefs.join(', ') || 'none'}`,
  ].join('\n')).join('\n')
}

function renderOperatingModel(blueprint: SpecialistAgentBlueprint): string {
  return [
    `This specialist owns repeated ${blueprint.intendedDomain} work described in its charter.`,
    `It produces: ${blueprint.expectedOutputs.join(', ') || 'none'}.`,
    `Main-agent boundary: ${blueprint.mainVsSpecialistSplit}`,
  ].join('\n')
}

export function renderSpecialistFoundationMarkdown(blueprint: SpecialistAgentBlueprint): string {
  const evaluation = evaluateSpecialistBlueprintQuality(blueprint)
  return [
    `# ${blueprint.displayName} Foundation`,
    '',
    `Foundation pack: ${SPECIALIST_FOUNDATION_PACK_VERSION}`,
    '',
    '## Provenance',
    `- Blueprint: ${blueprint.blueprintId}`,
    `- Specialist: ${blueprint.specialistId}`,
    `- Source: ${blueprint.source}`,
    `- User request: ${blueprint.userRequestVerbatim}`,
    `- Created: ${blueprint.provenance.createdAt}`,
    '',
    '## Role Persona',
    blueprint.rolePersona,
    '',
    '## Charter',
    blueprint.charter,
    '',
    '## Operating Model',
    renderOperatingModel(blueprint),
    '',
    '## Scope',
    `- Domain: ${blueprint.intendedDomain}`,
    '',
    '## Task Examples',
    '',
    '### Recurring Tasks',
    renderList(blueprint.recurringTasks),
    '',
    '### Non-Goals',
    renderList(blueprint.nonGoals),
    '',
    '### Suitable Tasks',
    renderList(blueprint.taskExamples.suitable),
    '',
    '### Unsuitable Tasks',
    renderList(blueprint.taskExamples.unsuitable),
    '',
    '## Main vs Specialist Split',
    blueprint.mainVsSpecialistSplit,
    '',
    '## Inputs',
    renderList(blueprint.requiredInputs),
    '',
    '## Outputs',
    renderList(blueprint.expectedOutputs),
    '',
    '## Rules',
    blueprint.seedRulesText,
    '',
    '## Knowledge Seeds',
    renderSeeds(blueprint),
    '',
    '## Routing',
    renderList(blueprint.routingTriggers),
    '',
    '## Tool Boundaries',
    renderBoundary('browser', blueprint.toolBoundaries.browser),
    renderBoundary('write', blueprint.toolBoundaries.write),
    renderBoundary('externalSend', blueprint.toolBoundaries.externalSend),
    renderBoundary('longMemory', blueprint.toolBoundaries.longMemory),
    '',
    '## Memory/Profile Policy',
    blueprint.memoryProfilePolicy,
    '',
    '## Lifecycle',
    blueprint.lifecycleNotes,
    '',
    '## Quality Checks',
    ...evaluation.checks.map((check) => `- ${check.pass ? 'pass' : 'fail'} ${check.check}: ${check.message ?? ''}`.trim()),
    '',
  ].join('\n')
}
