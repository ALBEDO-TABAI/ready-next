import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSpecialistBlueprintClarificationContract,
  buildSpecialistBlueprintProfessionalInterviewContract,
  compileSpecialistBlueprintProfessionalInterviewAnswers,
  renderSpecialistBlueprintClarificationInstruction,
} from '../shared/agent-specialist-blueprint-clarification'

const BLUEPRINT_REF = {
  blueprintId: 'bp-visual-researcher',
  specialistId: 'visual-researcher',
}

test('specialist blueprint clarification contract maps missing fields into stable ask_user_questions args', () => {
  const contract = buildSpecialistBlueprintClarificationContract(BLUEPRINT_REF, [
    'nonGoals',
    'requiredInputs',
    'expectedOutputs',
  ])

  assert.equal(contract.blueprintId, 'bp-visual-researcher')
  assert.equal(contract.nextTool, 'ask_user_questions')
  assert.equal(contract.afterAnswerTool, 'propose_specialist_blueprint')
  assert.deepEqual(contract.questions.map((question) => question.id), [
    'nonGoals',
    'requiredInputs',
    'expectedOutputs',
  ])
  assert.deepEqual(contract.answerFieldMapping.map((mapping) => [
    mapping.answerId,
    mapping.proposeArgField,
    mapping.answerShape,
  ]), [
    ['nonGoals', 'non_goals', 'string_list'],
    ['requiredInputs', 'required_inputs', 'string_list'],
    ['expectedOutputs', 'expected_outputs', 'string_list'],
  ])
  assert.deepEqual(contract.askUserQuestionsArgs, { questions: contract.questions })
})

test('specialist blueprint clarification contract caps questions and retains remaining missing fields', () => {
  const contract = buildSpecialistBlueprintClarificationContract(BLUEPRINT_REF, [
    'specialistId',
    'displayName',
    'charter',
    'intendedDomain',
    'nonGoals',
    'recurringTasks',
    'requiredInputs',
    'unknownField',
  ])

  assert.equal(contract.questions.length, 3)
  assert.deepEqual(contract.questions.map((question) => question.id), ['charter', 'nonGoals', 'recurringTasks'])
  assert.deepEqual(contract.remainingMissing, ['requiredInputs', 'displayName', 'specialistId', 'intendedDomain'])
  assert.deepEqual(contract.unsupportedMissing, ['unknownField'])
})

test('specialist blueprint clarification maps quality gaps into boundary-first questions', () => {
  const contract = buildSpecialistBlueprintClarificationContract(BLUEPRINT_REF, [
    'toolBoundaries',
    'memoryProfilePolicy',
    'rolePersona',
    'knowledgeSeeds',
  ])

  assert.deepEqual(contract.questions.map((question) => question.id), [
    'toolBoundaries',
    'memoryProfilePolicy',
    'rolePersona',
  ])
  assert.deepEqual(contract.remainingMissing, ['knowledgeSeeds'])
  assert.deepEqual(contract.answerFieldMapping.map((mapping) => mapping.proposeArgField), [
    'tool_boundaries',
    'memory_profile_policy',
    'role_persona',
  ])
})

test('specialist blueprint clarification maps professional specificity gaps back to scope', () => {
  const contract = buildSpecialistBlueprintClarificationContract(BLUEPRINT_REF, [
    'professionalSpecificity',
    'toolBoundaries',
  ])

  assert.deepEqual(contract.questions.map((question) => question.id), [
    'charter',
    'toolBoundaries',
  ])
  assert.match(contract.questions[0].question, /工作范围/)
})

test('specialist blueprint clarification instruction exposes parseable ask_user_questions JSON in text', () => {
  const contract = buildSpecialistBlueprintClarificationContract(BLUEPRINT_REF, ['nonGoals'])
  const text = renderSpecialistBlueprintClarificationInstruction(contract)
  assert.match(text, /ask_user_questions/)
  assert.match(text, /propose_specialist_blueprint/)

  const jsonLine = text.split('\n').find((line) => line.trim().startsWith('{"questions"'))
  assert.ok(jsonLine)
  assert.deepEqual(JSON.parse(jsonLine), contract.askUserQuestionsArgs)
})

test('professional interview contract asks three high-impact specialist design questions', () => {
  const contract = buildSpecialistBlueprintProfessionalInterviewContract({
    userRequestVerbatim: '我要一个视觉研究类型的专项 agent',
  })

  assert.equal(contract.version, 'p8g-9b.v1')
  assert.equal(contract.contractKind, 'professional_interview')
  assert.equal(contract.nextTool, 'ask_user_questions')
  assert.equal(contract.afterAnswerTool, 'propose_specialist_blueprint')
  assert.equal(contract.questions.length, 3)
  assert.deepEqual(contract.questions.map((question) => question.id), [
    'workScope',
    'boundaryExamples',
    'inputsKnowledgeTools',
  ])
  assert.match(contract.questions[0].question, /工作对象|场景/)
  assert.match(contract.questions[0].question, /做好怎样算完成/)
  assert.match(contract.questions[1].question, /不交给它/)
  assert.match(contract.questions[1].question, /适合和不适合/)
  assert.match(contract.questions[2].question, /输入/)
  assert.match(contract.questions[2].question, /浏览器、写入、外发和长期记忆/)
  assert.deepEqual(contract.askUserQuestionsArgs, { questions: contract.questions })
  assert.ok(contract.questions.every((question) => question.kind === 'free_text'))
})

test('professional interview contract maps answers into blueprint fields without creating an agent', () => {
  const contract = buildSpecialistBlueprintProfessionalInterviewContract({
    userRequestVerbatim: '我要一个视觉研究类型的专项 agent',
  })

  assert.deepEqual(contract.answerFieldMapping.map((mapping) => mapping.answerId), [
    'workScope',
    'boundaryExamples',
    'inputsKnowledgeTools',
  ])
  assert.ok(contract.answerFieldMapping[0].proposeArgFields.includes('charter'))
  assert.ok(contract.answerFieldMapping[1].proposeArgFields.includes('main_vs_specialist_split'))
  assert.ok(contract.answerFieldMapping[2].proposeArgFields.includes('tool_boundaries'))

  const draft = compileSpecialistBlueprintProfessionalInterviewAnswers(contract, [
    {
      id: 'workScope',
      answer: '长期整理视觉参考，完成标准是输出带来源的参考清单和风格边界。',
    },
    {
      id: 'boundaryExamples',
      answer: '不替用户最终拍板；主 agent 保留目标取舍；适合参考整理，不适合直接外发。',
    },
    {
      id: 'inputsKnowledgeTools',
      answer: '需要主题、链接、附件和输出格式；浏览器/写入/长期记忆要确认，外发禁止。',
    },
  ])

  assert.equal(draft.userRequestVerbatim, '我要一个视觉研究类型的专项 agent')
  assert.equal(draft.createdAgent, false)
  assert.equal(draft.routingActivated, false)
  const fields = new Map(draft.fields.map((field) => [field.proposeArgField, field]))
  for (const field of [
    'charter',
    'intended_domain',
    'role_persona',
    'non_goals',
    'recurring_tasks',
    'required_inputs',
    'expected_outputs',
    'suitable_task_examples',
    'unsuitable_task_examples',
    'main_vs_specialist_split',
    'seed_rules_text',
    'knowledge_seeds',
    'tool_boundaries',
    'tool_safety_notes',
    'memory_profile_policy',
    'lifecycle_notes',
    'routing_triggers',
  ]) {
    assert.ok(fields.has(field), `draft should include ${field}`)
  }
  assert.deepEqual(fields.get('charter')?.sourceAnswerIds, ['workScope'])
  assert.deepEqual(fields.get('tool_boundaries')?.sourceAnswerIds, ['inputsKnowledgeTools'])
  assert.equal((fields.get('recurring_tasks')?.draftValue as string[]).length, 2)
  assert.equal((fields.get('expected_outputs')?.draftValue as string[]).length, 2)
  assert.equal((fields.get('non_goals')?.draftValue as string[]).length, 2)
  assert.notDeepEqual(
    fields.get('suitable_task_examples')?.draftValue,
    fields.get('unsuitable_task_examples')?.draftValue,
  )
})
