import type { SpecialistAgentBlueprint } from './agent-specialist-blueprint'

export const SPECIALIST_BLUEPRINT_CLARIFICATION_FIELDS = [
  'specialistId',
  'displayName',
  'charter',
  'intendedDomain',
  'rolePersona',
  'nonGoals',
  'recurringTasks',
  'requiredInputs',
  'expectedOutputs',
  'taskExamples',
  'mainVsSpecialistSplit',
  'seedRulesText',
  'knowledgeSeeds',
  'toolBoundaries',
  'toolSafetyNotes',
  'memoryProfilePolicy',
  'lifecycleNotes',
  'routingTriggers',
] as const

export type SpecialistBlueprintClarificationField = (typeof SPECIALIST_BLUEPRINT_CLARIFICATION_FIELDS)[number]
export type SpecialistBlueprintQuestionKind = 'single_choice' | 'multi_choice' | 'free_text'

export interface SpecialistBlueprintClarificationQuestion {
  id: SpecialistBlueprintClarificationField
  question: string
  kind: SpecialistBlueprintQuestionKind
  options?: string[]
  placeholder?: string
  required: true
}

export interface SpecialistBlueprintAnswerFieldMapping {
  answerId: SpecialistBlueprintClarificationField
  blueprintField: SpecialistBlueprintClarificationField
  proposeArgField: string
  answerShape: 'string' | 'string_list'
}

export interface SpecialistBlueprintClarificationContract {
  blueprintId: string
  specialistId: string
  missing: SpecialistBlueprintClarificationField[]
  unsupportedMissing: string[]
  questions: SpecialistBlueprintClarificationQuestion[]
  remainingMissing: SpecialistBlueprintClarificationField[]
  answerFieldMapping: SpecialistBlueprintAnswerFieldMapping[]
  askUserQuestionsArgs: {
    questions: SpecialistBlueprintClarificationQuestion[]
  }
  nextTool: 'ask_user_questions'
  afterAnswerTool: 'propose_specialist_blueprint'
  reproposalRule: string
}

export const SPECIALIST_BLUEPRINT_PROFESSIONAL_INTERVIEW_VERSION = 'p8g-9b.v1'

export const SPECIALIST_BLUEPRINT_PROFESSIONAL_INTERVIEW_QUESTION_IDS = [
  'workScope',
  'boundaryExamples',
  'inputsKnowledgeTools',
] as const

export type SpecialistBlueprintProfessionalInterviewQuestionId =
  (typeof SPECIALIST_BLUEPRINT_PROFESSIONAL_INTERVIEW_QUESTION_IDS)[number]

export interface SpecialistBlueprintProfessionalInterviewQuestion {
  id: SpecialistBlueprintProfessionalInterviewQuestionId
  question: string
  kind: SpecialistBlueprintQuestionKind
  placeholder?: string
  required: true
}

export interface SpecialistBlueprintProfessionalInterviewFieldMapping {
  answerId: SpecialistBlueprintProfessionalInterviewQuestionId
  proposeArgFields: string[]
}

export interface SpecialistBlueprintProfessionalInterviewContract {
  contractKind: 'professional_interview'
  version: typeof SPECIALIST_BLUEPRINT_PROFESSIONAL_INTERVIEW_VERSION
  userRequestVerbatim: string
  questions: SpecialistBlueprintProfessionalInterviewQuestion[]
  askUserQuestionsArgs: {
    questions: SpecialistBlueprintProfessionalInterviewQuestion[]
  }
  nextTool: 'ask_user_questions'
  answerFieldMapping: SpecialistBlueprintProfessionalInterviewFieldMapping[]
  afterAnswerTool: 'propose_specialist_blueprint'
  compilerRule: string
}

export interface SpecialistBlueprintProfessionalInterviewAnswer {
  id: SpecialistBlueprintProfessionalInterviewQuestionId
  answer: string
}

export interface SpecialistBlueprintProfessionalInterviewDraftField {
  proposeArgField: string
  draftValue: string | string[]
  sourceAnswerIds: SpecialistBlueprintProfessionalInterviewQuestionId[]
}

export interface SpecialistBlueprintProfessionalInterviewDraft {
  version: typeof SPECIALIST_BLUEPRINT_PROFESSIONAL_INTERVIEW_VERSION
  userRequestVerbatim: string
  fields: SpecialistBlueprintProfessionalInterviewDraftField[]
  createdAgent: false
  routingActivated: false
}

const FIELD_SET = new Set<string>(SPECIALIST_BLUEPRINT_CLARIFICATION_FIELDS)

const FIELD_QUESTIONS: Record<SpecialistBlueprintClarificationField, SpecialistBlueprintClarificationQuestion> = {
  specialistId: {
    id: 'specialistId',
    question: '这个专项 agent 的英文小写 id 想叫什么？',
    kind: 'free_text',
    placeholder: '例如 visual-researcher',
    required: true,
  },
  displayName: {
    id: 'displayName',
    question: '这个专项 agent 在界面上应该叫什么名字？',
    kind: 'free_text',
    placeholder: '例如 视觉研究专项 Agent',
    required: true,
  },
  charter: {
    id: 'charter',
    question: '它应该稳定负责哪些工作范围？',
    kind: 'free_text',
    placeholder: '写清楚它该接什么任务，以及判断边界。',
    required: true,
  },
  intendedDomain: {
    id: 'intendedDomain',
    question: '它聚焦在哪个具体领域或场景？',
    kind: 'free_text',
    placeholder: '例如 视觉参考研究、短视频脚本诊断。',
    required: true,
  },
  rolePersona: {
    id: 'rolePersona',
    question: '它应该以什么角色、人设和判断口径长期工作？',
    kind: 'free_text',
    placeholder: '写清它的专业姿态、判断标准和沟通风格。',
    required: true,
  },
  nonGoals: {
    id: 'nonGoals',
    question: '这个专项 agent 明确不该做哪些事？',
    kind: 'free_text',
    placeholder: '列出排除项，避免它变成全能 agent。',
    required: true,
  },
  recurringTasks: {
    id: 'recurringTasks',
    question: '它会反复处理哪几类任务？',
    kind: 'free_text',
    placeholder: '例如 整理参考资料；比较风格方向。',
    required: true,
  },
  requiredInputs: {
    id: 'requiredInputs',
    question: '它开始工作前通常需要哪些输入？',
    kind: 'free_text',
    placeholder: '例如 目标主题、参考链接、附件、输出格式。',
    required: true,
  },
  expectedOutputs: {
    id: 'expectedOutputs',
    question: '它每次应该交付哪些具体结果？',
    kind: 'free_text',
    placeholder: '例如 研究结论、可复用清单、下一步建议。',
    required: true,
  },
  taskExamples: {
    id: 'taskExamples',
    question: '哪些任务适合交给它，哪些任务不适合？',
    kind: 'free_text',
    placeholder: '各写 1-3 个例子，帮助主 agent 判断边界。',
    required: true,
  },
  mainVsSpecialistSplit: {
    id: 'mainVsSpecialistSplit',
    question: '主 agent 和这个专项 agent 应该怎么分工？',
    kind: 'free_text',
    placeholder: '写清主 agent 保留什么判断，专项 agent 接手什么重复工作。',
    required: true,
  },
  seedRulesText: {
    id: 'seedRulesText',
    question: '它的初始工作规则应该怎么写？',
    kind: 'free_text',
    placeholder: '写成几条可执行规则，包含边界和工作流。',
    required: true,
  },
  knowledgeSeeds: {
    id: 'knowledgeSeeds',
    question: '它需要带哪些初始知识或证据来源？',
    kind: 'free_text',
    placeholder: '列出知识点和来源；如果暂时没有，也说明应该从哪里积累。',
    required: true,
  },
  toolBoundaries: {
    id: 'toolBoundaries',
    question: '它使用浏览器、写文件、外发消息和长期记忆时分别是什么边界？',
    kind: 'free_text',
    placeholder: '分别说明允许、拒绝或必须确认的场景。',
    required: true,
  },
  toolSafetyNotes: {
    id: 'toolSafetyNotes',
    question: '它最容易踩到哪些安全或越界风险？',
    kind: 'free_text',
    placeholder: '写真实风险，例如外发、账号、隐私、长期记忆、文件写入。',
    required: true,
  },
  memoryProfilePolicy: {
    id: 'memoryProfilePolicy',
    question: '它应该如何使用长期记忆和用户画像？',
    kind: 'free_text',
    placeholder: '写清哪些内容可沉淀、哪些只能临时使用、哪些必须确认。',
    required: true,
  },
  lifecycleNotes: {
    id: 'lifecycleNotes',
    question: '这个专项 agent 后续如何维护、退休或合并？',
    kind: 'free_text',
    placeholder: '写清何时更新规则、何时失效、何时并入其他 agent。',
    required: true,
  },
  routingTriggers: {
    id: 'routingTriggers',
    question: '哪些字面触发词能提示这个任务适合它？',
    kind: 'free_text',
    placeholder: '最多 8 个短词，例如 视觉研究、参考整理。',
    required: true,
  },
}

const PROPOSE_ARG_FIELD: Record<SpecialistBlueprintClarificationField, string> = {
  specialistId: 'specialist_id',
  displayName: 'display_name',
  charter: 'charter',
  intendedDomain: 'intended_domain',
  rolePersona: 'role_persona',
  nonGoals: 'non_goals',
  recurringTasks: 'recurring_tasks',
  requiredInputs: 'required_inputs',
  expectedOutputs: 'expected_outputs',
  taskExamples: 'suitable_task_examples/unsuitable_task_examples',
  mainVsSpecialistSplit: 'main_vs_specialist_split',
  seedRulesText: 'seed_rules_text',
  knowledgeSeeds: 'knowledge_seeds',
  toolBoundaries: 'tool_boundaries',
  toolSafetyNotes: 'tool_safety_notes',
  memoryProfilePolicy: 'memory_profile_policy',
  lifecycleNotes: 'lifecycle_notes',
  routingTriggers: 'routing_triggers',
}

const ANSWER_SHAPE: Record<SpecialistBlueprintClarificationField, 'string' | 'string_list'> = {
  specialistId: 'string',
  displayName: 'string',
  charter: 'string',
  intendedDomain: 'string',
  rolePersona: 'string',
  nonGoals: 'string_list',
  recurringTasks: 'string_list',
  requiredInputs: 'string_list',
  expectedOutputs: 'string_list',
  taskExamples: 'string_list',
  mainVsSpecialistSplit: 'string',
  seedRulesText: 'string',
  knowledgeSeeds: 'string_list',
  toolBoundaries: 'string',
  toolSafetyNotes: 'string',
  memoryProfilePolicy: 'string',
  lifecycleNotes: 'string',
  routingTriggers: 'string_list',
}

const GAP_PRIORITY: SpecialistBlueprintClarificationField[] = [
  'charter',
  'nonGoals',
  'mainVsSpecialistSplit',
  'toolBoundaries',
  'memoryProfilePolicy',
  'rolePersona',
  'taskExamples',
  'recurringTasks',
  'requiredInputs',
  'expectedOutputs',
  'knowledgeSeeds',
  'seedRulesText',
  'toolSafetyNotes',
  'lifecycleNotes',
  'routingTriggers',
  'displayName',
  'specialistId',
  'intendedDomain',
]

const QUALITY_GAP_TO_FIELD: Record<string, SpecialistBlueprintClarificationField> = {
  charter: 'charter',
  rolePersona: 'rolePersona',
  nonGoals: 'nonGoals',
  recurringTasks: 'recurringTasks',
  requiredInputs: 'requiredInputs',
  expectedOutputs: 'expectedOutputs',
  taskExamples: 'taskExamples',
  mainVsSpecialistSplit: 'mainVsSpecialistSplit',
  seedRulesText: 'seedRulesText',
  knowledgeSeeds: 'knowledgeSeeds',
  toolBoundaries: 'toolBoundaries',
  toolSafetyNotes: 'toolSafetyNotes',
  memoryProfilePolicy: 'memoryProfilePolicy',
  lifecycleNotes: 'lifecycleNotes',
  routingTriggers: 'routingTriggers',
  scope_too_generic: 'charter',
  role_not_operational: 'rolePersona',
  main_split_unclear: 'mainVsSpecialistSplit',
  weak_non_goals: 'nonGoals',
  weak_task_examples: 'taskExamples',
  weak_inputs_outputs: 'requiredInputs',
  tool_boundary_underexplained: 'toolBoundaries',
  memory_policy_unclear: 'memoryProfilePolicy',
  knowledge_lacks_evidence: 'knowledgeSeeds',
  foundation_echoes_request: 'charter',
  professionalSpecificity: 'charter',
  lifecycle_unclear: 'lifecycleNotes',
}

const PROFESSIONAL_INTERVIEW_QUESTIONS: SpecialistBlueprintProfessionalInterviewQuestion[] = [
  {
    id: 'workScope',
    question: '这个专项 agent 长期服务的工作对象或场景是什么？一次做好怎样算完成，最重要的输出样式是什么？',
    kind: 'free_text',
    placeholder: '例如：持续整理视觉参考；完成标准是给出带来源的方向判断；输出参考清单和风格边界。',
    required: true,
  },
  {
    id: 'boundaryExamples',
    question: '哪些事不交给它，主 agent 保留什么判断？各举一个适合和不适合交给它的任务例子。',
    kind: 'free_text',
    placeholder: '例如：不替用户最终拍板；主 agent 保留目标取舍；适合整理参考，不适合直接外发。',
    required: true,
  },
  {
    id: 'inputsKnowledgeTools',
    question: '它开始前需要哪些输入和初始知识来源？浏览器、写入、外发和长期记忆分别哪些必须确认或禁止？',
    kind: 'free_text',
    placeholder: '例如：需要主题、链接和附件；浏览器/写入/长期记忆要确认，外发禁止；知识来自用户指定资料。',
    required: true,
  },
]

const PROFESSIONAL_INTERVIEW_FIELD_MAPPING: SpecialistBlueprintProfessionalInterviewFieldMapping[] = [
  {
    answerId: 'workScope',
    proposeArgFields: [
      'charter',
      'intended_domain',
      'role_persona',
      'recurring_tasks',
      'expected_outputs',
    ],
  },
  {
    answerId: 'boundaryExamples',
    proposeArgFields: [
      'non_goals',
      'suitable_task_examples',
      'unsuitable_task_examples',
      'main_vs_specialist_split',
    ],
  },
  {
    answerId: 'inputsKnowledgeTools',
    proposeArgFields: [
      'required_inputs',
      'seed_rules_text',
      'knowledge_seeds',
      'tool_boundaries',
      'tool_safety_notes',
      'memory_profile_policy',
      'lifecycle_notes',
      'routing_triggers',
    ],
  },
]

function isClarificationField(value: string): value is SpecialistBlueprintClarificationField {
  return FIELD_SET.has(value)
}

function uniqueMissing(missing: readonly string[]): {
  known: SpecialistBlueprintClarificationField[]
  unsupported: string[]
} {
  const known: SpecialistBlueprintClarificationField[] = []
  const unsupported: string[] = []
  const seen = new Set<string>()
  for (const field of missing) {
    if (seen.has(field)) continue
    seen.add(field)
    const mapped = isClarificationField(field) ? field : QUALITY_GAP_TO_FIELD[field]
    if (mapped) known.push(mapped)
    else unsupported.push(field)
  }
  const priority = new Map(GAP_PRIORITY.map((field, index) => [field, index]))
  known.sort((a, b) => (priority.get(a) ?? 999) - (priority.get(b) ?? 999))
  return { known, unsupported }
}

export function buildSpecialistBlueprintClarificationContract(
  blueprint: Pick<SpecialistAgentBlueprint, 'blueprintId' | 'specialistId'>,
  missing: readonly string[],
): SpecialistBlueprintClarificationContract {
  const { known, unsupported } = uniqueMissing(missing)
  const questions = known.slice(0, 3).map((field) => ({ ...FIELD_QUESTIONS[field] }))
  const remainingMissing = known.slice(questions.length)
  const answerFieldMapping = questions.map((question) => ({
    answerId: question.id,
    blueprintField: question.id,
    proposeArgField: PROPOSE_ARG_FIELD[question.id],
    answerShape: ANSWER_SHAPE[question.id],
  }))

  return {
    blueprintId: blueprint.blueprintId,
    specialistId: blueprint.specialistId,
    missing: known,
    unsupportedMissing: unsupported,
    questions,
    remainingMissing,
    answerFieldMapping,
    askUserQuestionsArgs: { questions },
    nextTool: 'ask_user_questions',
    afterAnswerTool: 'propose_specialist_blueprint',
    reproposalRule: 'After the user answers, refill the mapped propose_specialist_blueprint fields, keep the original user_request_verbatim, reuse the same specialist_id when present, and call propose_specialist_blueprint again. Do not create an agent or activate routing.',
  }
}

export function buildSpecialistBlueprintProfessionalInterviewContract(params: {
  userRequestVerbatim: string
}): SpecialistBlueprintProfessionalInterviewContract {
  const userRequestVerbatim = params.userRequestVerbatim.trim()
  return {
    contractKind: 'professional_interview',
    version: SPECIALIST_BLUEPRINT_PROFESSIONAL_INTERVIEW_VERSION,
    userRequestVerbatim,
    questions: PROFESSIONAL_INTERVIEW_QUESTIONS.map((question) => ({ ...question })),
    askUserQuestionsArgs: {
      questions: PROFESSIONAL_INTERVIEW_QUESTIONS.map((question) => ({ ...question })),
    },
    nextTool: 'ask_user_questions',
    answerFieldMapping: PROFESSIONAL_INTERVIEW_FIELD_MAPPING.map((mapping) => ({
      answerId: mapping.answerId,
      proposeArgFields: [...mapping.proposeArgFields],
    })),
    afterAnswerTool: 'propose_specialist_blueprint',
    compilerRule: 'After the user answers, compile the three answers into propose_specialist_blueprint fields. Keep user_request_verbatim as the original user wording. Do not create an agent or activate routing.',
  }
}

function answerValue(
  answers: readonly SpecialistBlueprintProfessionalInterviewAnswer[],
  id: SpecialistBlueprintProfessionalInterviewQuestionId,
): string {
  return answers.find((answer) => answer.id === id)?.answer.trim() || ''
}

function draftField(
  proposeArgField: string,
  draftValue: string | string[],
  sourceAnswerIds: SpecialistBlueprintProfessionalInterviewQuestionId[],
): SpecialistBlueprintProfessionalInterviewDraftField {
  return { proposeArgField, draftValue, sourceAnswerIds }
}

function compactAnswer(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function derivedListItems(
  answer: string,
  labels: readonly string[],
): string[] {
  const text = compactAnswer(answer)
  return labels.map((label) => `${label}: ${text}`)
}

export function compileSpecialistBlueprintProfessionalInterviewAnswers(
  contract: SpecialistBlueprintProfessionalInterviewContract,
  answers: readonly SpecialistBlueprintProfessionalInterviewAnswer[],
): SpecialistBlueprintProfessionalInterviewDraft {
  const workScope = answerValue(answers, 'workScope')
  const boundaryExamples = answerValue(answers, 'boundaryExamples')
  const inputsKnowledgeTools = answerValue(answers, 'inputsKnowledgeTools')
  const request = contract.userRequestVerbatim
  const allSources: SpecialistBlueprintProfessionalInterviewQuestionId[] = [
    'workScope',
    'boundaryExamples',
    'inputsKnowledgeTools',
  ]

  return {
    version: SPECIALIST_BLUEPRINT_PROFESSIONAL_INTERVIEW_VERSION,
    userRequestVerbatim: request,
    createdAgent: false,
    routingActivated: false,
    fields: [
      draftField('charter', `Original request: ${request}\nWork scope and success criteria: ${workScope}`, ['workScope']),
      draftField('intended_domain', `Domain inferred from original request and work scope: ${request}\n${workScope}`, ['workScope']),
      draftField('role_persona', `Role persona should be designed around this work scope and output standard: ${workScope}`, ['workScope']),
      draftField('recurring_tasks', derivedListItems(workScope, [
        'Recurring task from work object',
        'Recurring task from success/output standard',
      ]), ['workScope']),
      draftField('expected_outputs', derivedListItems(workScope, [
        'Expected deliverable',
        'Expected completion evidence',
      ]), ['workScope']),
      draftField('non_goals', derivedListItems(boundaryExamples, [
        'Explicit non-goal',
        'Main-agent retained judgment',
      ]), ['boundaryExamples']),
      draftField('suitable_task_examples', derivedListItems(boundaryExamples, [
        'Suitable task example',
      ]), ['boundaryExamples']),
      draftField('unsuitable_task_examples', derivedListItems(boundaryExamples, [
        'Unsuitable task example',
      ]), ['boundaryExamples']),
      draftField('main_vs_specialist_split', boundaryExamples, ['boundaryExamples']),
      draftField('required_inputs', derivedListItems(inputsKnowledgeTools, [
        'Required user/context input',
        'Required source or evidence input',
      ]), ['inputsKnowledgeTools']),
      draftField('seed_rules_text', `Rules must reflect:\n- ${workScope}\n- ${boundaryExamples}\n- ${inputsKnowledgeTools}`, allSources),
      draftField('knowledge_seeds', `Initial knowledge and evidence sources: ${inputsKnowledgeTools}`, ['inputsKnowledgeTools']),
      draftField('tool_boundaries', inputsKnowledgeTools, ['inputsKnowledgeTools']),
      draftField('tool_safety_notes', inputsKnowledgeTools, ['inputsKnowledgeTools']),
      draftField('memory_profile_policy', inputsKnowledgeTools, ['inputsKnowledgeTools']),
      draftField('lifecycle_notes', inputsKnowledgeTools, ['inputsKnowledgeTools']),
      draftField('routing_triggers', [
        compactAnswer(request),
        `Trigger derived from work scope: ${compactAnswer(workScope)}`,
      ], ['workScope']),
    ],
  }
}

export function renderSpecialistBlueprintProfessionalInterviewInstruction(
  contract: SpecialistBlueprintProfessionalInterviewContract,
): string {
  return [
    '专项 agent 还需要先完成专业访谈，避免只按类型名生成空壳 agent。',
    '下一步必须调用 ask_user_questions，参数如下：',
    JSON.stringify(contract.askUserQuestionsArgs),
    contract.compilerRule,
  ].join('\n\n')
}

export function renderSpecialistBlueprintClarificationInstruction(
  contract: SpecialistBlueprintClarificationContract,
): string {
  const missing = [
    ...contract.missing,
    ...contract.unsupportedMissing,
  ].join(', ') || 'unknown'
  if (contract.questions.length === 0) {
    return [
      `专项 agent 蓝图还缺少关键信息：${missing}。`,
      '这些缺口还没有可自动提问的字段映射。不要创建 agent，不要激活路由。',
    ].join('\n\n')
  }
  return [
    `专项 agent 蓝图还缺少关键信息：${missing}。`,
    '下一步必须调用 ask_user_questions，参数如下：',
    JSON.stringify(contract.askUserQuestionsArgs),
    '用户回答后，用这些回答补齐对应字段，再重新调用 propose_specialist_blueprint。不要创建 agent，不要激活路由。',
  ].join('\n\n')
}
