import {
  normalizeAnthropicToolSchema,
  normalizeOpenAIToolSchema,
} from './tool-schema'

export const IMAGE_GENERATION_TOOL_NAMES = ['generate_image'] as const

const IMAGE_GENERATION_DESCRIPTION = [
  '根据用户描述生成一张真实图片。',
  '当用户要求生成、绘制、制作图片，或使用 /imag 时必须调用本工具，不要只回复文字方案。',
  '本轮有图片附件时，它们会按界面中的“参考图 1、2…”顺序自动提供；如只使用其中部分，传递从小到大且不重复的 reference_image_orders。',
  '不要向用户索要本机路径，也不要在参数中编造路径。',
].join('')

const IMAGE_GENERATION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: '要生成的画面描述，应包含主体、场景、构图、风格和必要文字要求。',
      minLength: 1,
      maxLength: 10_000,
    },
    service_id: {
      type: 'string',
      description: '可选。用户明确指定服务时传 gpt-image-default 或 gemini-image-default；否则省略并使用首个已启用服务。',
    },
    reference_image_orders: {
      type: 'array',
      description: '可选。只使用本轮部分参考图时传一基序号，必须从小到大且不重复；省略表示使用全部参考图。',
      items: { type: 'integer', minimum: 1 },
      maxItems: 8,
    },
    size: {
      type: 'string',
      description: '可选。GPT Image 输出尺寸，例如 1024x1024；省略使用服务配置。',
    },
    aspect_ratio: {
      type: 'string',
      description: '可选。Gemini 图片比例，例如 1:1、16:9、9:16；省略使用服务配置。',
    },
    image_size: {
      type: 'string',
      description: '可选。Gemini 图片清晰度，例如 1K、2K、4K；省略使用服务配置。',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
}

export function getImageGenerationAnthropicTools(): Array<Record<string, unknown>> {
  return [normalizeAnthropicToolSchema({
    name: 'generate_image',
    description: IMAGE_GENERATION_DESCRIPTION,
    input_schema: IMAGE_GENERATION_INPUT_SCHEMA,
  })]
}

export function getImageGenerationOpenAITools(): Array<Record<string, unknown>> {
  return [normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: 'generate_image',
      description: IMAGE_GENERATION_DESCRIPTION,
      parameters: IMAGE_GENERATION_INPUT_SCHEMA,
    },
  })]
}
