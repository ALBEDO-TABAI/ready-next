import type { AIModelConfig } from '../../../../shared/ai-providers'
import { requestCodexProviderText } from './codex-provider-text'

/** Private, tool-free diagnostic gateway. No settings writes or retries. */
export async function testCodexProviderConnection(config: AIModelConfig): Promise<{ latencyMs: number }> {
  try {
    const { latencyMs } = await requestCodexProviderText(config, { system: 'This is a connection test. Reply OK.', user: 'Reply OK.', maxTokens: 4096, timeoutMs: 45000 })
    return { latencyMs }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.startsWith('连接失败') ? message : `连接失败: ${message}`)
  }
}
