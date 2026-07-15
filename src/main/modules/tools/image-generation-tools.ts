import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'
import { getImageGenerationService } from '../image-generation/image-generation-service'

export interface ImageGenerationToolContext {
  requestEnvelope?: unknown
  abortSignal?: AbortSignal
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalIntegerArray(value: unknown): number[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('reference_image_orders 必须是数组')
  return value.map((item) => {
    if (typeof item !== 'number' || !Number.isInteger(item)) {
      throw new Error('reference_image_orders 只能包含整数')
    }
    return item
  })
}

export async function executeImageGenerationTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ImageGenerationToolContext,
): Promise<ToolExecutionOutput> {
  if (toolName !== 'generate_image') throw new Error(`Unknown image generation tool: ${toolName}`)
  const artifact = await getImageGenerationService().generate({
    prompt: String(args.prompt || ''),
    serviceId: optionalString(args.service_id),
    referenceImageOrders: optionalIntegerArray(args.reference_image_orders),
    size: optionalString(args.size),
    aspectRatio: optionalString(args.aspect_ratio),
    imageSize: optionalString(args.image_size),
    requestEnvelope: context.requestEnvelope,
    signal: context.abortSignal,
  })
  const references = artifact.meta.referenceImages.length
  const summary = references > 0
    ? `已生成图片，并按顺序使用 ${references} 张参考图。`
    : '已生成图片。'
  return createToolExecutionOutput(summary, {
    projectionPatch: {
      taskTitle: 'AI 生图',
      taskSummary: summary,
      recentArtifacts: [artifact],
    },
    data: {
      artifact,
    },
  })
}
