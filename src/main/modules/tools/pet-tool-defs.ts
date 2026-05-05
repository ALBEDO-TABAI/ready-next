import {
  buildToolParamSchema,
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
  type ToolParamSchemaSpec,
} from './tool-schema'
import { PET_SCHEMAS } from './schemas/pet-schemas'
import { zodObjectToParamList } from './zod-param-derivation'

type ToolParam = ToolParamSchemaSpec

export interface PetToolDef {
  name: string
  description: string
  params: ToolParam[]
}

export const PET_TOOLS: PetToolDef[] = [
  {
    name: 'pet_show_sticky_note',
    description:
      '把一条简短内容贴到桌面宠物旁边的独立便利贴层。用于用户明确要求“贴到猫猫/宠物/便利贴/气泡上”的内容；如果用户要求整理或生成内容后再贴，先组织成简短便利贴再调用。',
    params: zodObjectToParamList(PET_SCHEMAS.pet_show_sticky_note) as ToolParam[],
  },
  {
    name: 'pet_dismiss_sticky_note',
    description: '关闭指定 id 的宠物便利贴。',
    params: zodObjectToParamList(PET_SCHEMAS.pet_dismiss_sticky_note) as ToolParam[],
  },
  {
    name: 'pet_clear_sticky_notes',
    description: '清空当前所有宠物便利贴。',
    params: zodObjectToParamList(PET_SCHEMAS.pet_clear_sticky_notes) as ToolParam[],
  },
]

export function getPetAnthropicTools(): Array<Record<string, unknown>> {
  return PET_TOOLS.map((tool) => normalizeAnthropicToolSchema({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, buildToolParamSchema(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }))
}

export function getPetOpenAITools(): Array<Record<string, unknown>> {
  return PET_TOOLS.map((tool) => normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(tool.params.map((param) => [param.name, buildToolParamSchema(param)])),
        required: tool.params.filter((param) => param.required).map((param) => param.name),
      },
    },
  }))
}
