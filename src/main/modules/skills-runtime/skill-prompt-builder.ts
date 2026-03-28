import type { ExecutionFrame, SkillGeneratedFileDefinition, SkillSourceMaterial } from '../../../shared/skill-execution-types'

function renderGeneratedFiles(files?: SkillGeneratedFileDefinition[]): string {
  if (!files || files.length === 0) return ''
  return [
    'Generated Files:',
    ...files.map((file) => `- ${file.outputKey}: ${file.pathTemplate}${file.description ? ` (${file.description})` : ''}`),
  ].join('\n')
}

function renderSourceMaterials(sourceMaterials?: SkillSourceMaterial[]): string {
  if (!sourceMaterials || sourceMaterials.length === 0) return ''
  return [
    'Source Materials:',
    ...sourceMaterials.map((item) => [
      `--- ${item.key} (${item.path}) ---`,
      item.content,
    ].join('\n')),
  ].join('\n')
}

export function buildSkillAgentPrompt(params: {
  stepPrompt: string
  sourceMaterials?: SkillSourceMaterial[]
  generatedFiles?: SkillGeneratedFileDefinition[]
}): string {
  return [
    params.stepPrompt.trim(),
    renderGeneratedFiles(params.generatedFiles),
    renderSourceMaterials(params.sourceMaterials),
  ].filter(Boolean).join('\n\n')
}

export function buildExecutionFrame(params: {
  executionId: string
  skillId: string
  stepId: string
  title: string
  description: string
  prompt?: string
  sourceMaterials?: SkillSourceMaterial[]
}): ExecutionFrame {
  return {
    executionId: params.executionId,
    skillId: params.skillId,
    stepId: params.stepId,
    title: params.title,
    description: params.description,
    prompt: params.prompt,
    sourceMaterials: params.sourceMaterials,
  }
}
