import {
  resolveAIConfigCapabilities,
  type AIModelConfig
} from '../../../shared/ai-providers'

export interface ToolUseModePresentation {
  autoOptionLabel: string
  description: string
  effectiveEnabled: boolean
  autoEnabled: boolean
}

export function resolveToolUseModePresentation(
  config: AIModelConfig
): ToolUseModePresentation {
  const effectiveEnabled = resolveAIConfigCapabilities(config)?.supportsToolCalls === true
  const autoEnabled = resolveAIConfigCapabilities({
    ...config,
    toolUseMode: 'auto'
  })?.supportsToolCalls === true
  const mode = config.toolUseMode || 'auto'
  const autoOptionLabel = mode === 'auto'
    ? `自动（当前=${autoEnabled ? '开启' : '关闭'}）`
    : `自动（切换后=${autoEnabled ? '开启' : '关闭'}）`
  const compatibilityHint = mode === 'auto'
    && config.provider === 'openai-compatible'
    && !effectiveEnabled
      ? ' 此类兼容端点默认不宣称支持工具；若端点支持 function calling，可选择“强制开启”。'
      : ''
  return {
    autoOptionLabel,
    description: `当前为${effectiveEnabled ? '开启' : '关闭'}。${compatibilityHint}`,
    effectiveEnabled,
    autoEnabled
  }
}
