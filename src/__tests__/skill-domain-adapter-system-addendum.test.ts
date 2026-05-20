import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildSkillDomainInstruction } from '../main/modules/agent-control/skills/skill-domain-adapter'

// skill-resume D2 — when narrowing actually drops tools, system instruction
// gets a dynamic addendum listing the dropped tools. Without addendum, LLM
// would retry them and waste iterations.

const BASE_INSTRUCTION = '系统执行器：本轮走 skill 执行路径。优先使用 skill_* 工具推进，不要退回无关的通用工具。'

describe('buildSkillDomainInstruction (D2 dynamic addendum)', () => {
  it('returns base INSTRUCTION when input is null/empty', () => {
    assert.equal(buildSkillDomainInstruction(null, ['skill_x']), BASE_INSTRUCTION)
    assert.equal(buildSkillDomainInstruction([], ['skill_x']), BASE_INSTRUCTION)
    assert.equal(buildSkillDomainInstruction(undefined, ['skill_x']), BASE_INSTRUCTION)
  })

  it('returns base INSTRUCTION when nothing was dropped (output == input)', () => {
    const tools = ['skill_run_shell', 'memory_search']
    assert.equal(buildSkillDomainInstruction(tools, tools), BASE_INSTRUCTION)
  })

  it('appends TurnFrame steering reminder when a typed skill action is preferred', () => {
    const result = buildSkillDomainInstruction(
      ['skill_video_expert_pipeline', 'skill_run_shell', 'memory_search'],
      ['skill_video_expert_pipeline', 'skill_run_shell', 'memory_search'],
      {
        preferredToolNames: ['skill_video_expert_pipeline', 'skill_run_shell'],
        systemReminder: '系统补充：当前 TurnFrame 已确认应优先调用 typed skill action skill_video_expert_pipeline。',
      },
    )

    assert.ok(result.startsWith(BASE_INSTRUCTION), 'keeps base instruction')
    assert.ok(result.includes('skill_video_expert_pipeline'), 'names preferred typed action')
    assert.ok(result.includes('typed skill action'), 'keeps steering language')
    assert.ok(result.includes('skill_run_shell 只用于必要诊断'), 'discourages shell inspection loops')
  })

  it('appends addendum listing dropped tool names when narrowing dropped some', () => {
    const input = ['skill_run_shell', 'file_search', 'file_locate', 'document_open_tab']
    const output = ['skill_run_shell']
    const result = buildSkillDomainInstruction(input, output)
    assert.ok(result.startsWith(BASE_INSTRUCTION), 'starts with base instruction')
    assert.ok(result.includes('已暂停 3 个工具'), 'reports drop count')
    assert.ok(result.includes('file_search'), 'lists file_search')
    assert.ok(result.includes('file_locate'), 'lists file_locate')
    assert.ok(result.includes('document_open_tab'), 'lists document_open_tab')
    assert.ok(result.includes('普通指令'), 'tells LLM how to recover')
  })

  it('caps sample at 5 with "(共 N 个)" suffix when N > 5', () => {
    const input = [
      'skill_run_shell',
      'file_search', 'file_locate', 'file_open', 'file_read', 'file_save',
      'document_open_tab', 'document_set_content',
    ]
    const output = ['skill_run_shell']
    const result = buildSkillDomainInstruction(input, output)
    assert.ok(result.includes('已暂停 7 个工具'), 'reports total count')
    assert.ok(result.includes('（共 7 个）'), 'shows total in parens')
    // 5 names should be in sample
    const sampleMatch = result.match(/file_search、file_locate、file_open、file_read、file_save/)
    assert.ok(sampleMatch, 'first 5 dropped tools listed in sample')
    // 6th+ should NOT appear in sample
    assert.ok(!result.includes('document_open_tab、document_set_content'),
      '6th+ dropped not in sample (capped at 5)')
  })

  it('output null treated as "everything dropped"', () => {
    const result = buildSkillDomainInstruction(['skill_a', 'file_b'], null)
    assert.ok(result.includes('已暂停 2 个工具'))
  })
})
