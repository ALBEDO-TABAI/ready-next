import { AIModelConfig, normalizeAIConfig } from '../../../shared/ai-providers'
import { logAgentMetric } from '../agent-control/metrics'

/**
 * Detailed result of loading the runtime AI model config from settings.
 *
 * Distinguishes "config absent" (user hasn't set up an API key yet) from
 * "config corrupt" (JSON parse failed) from "config DB error" (settings
 * repo threw). Stage 2.4 — see plans/codex-agent-toasty-starfish.md §5.2.
 */
export type AIConfigLoad =
  | { ok: true; config: AIModelConfig | null; reason: 'absent' | 'present' }
  | { ok: false; reason: 'json_corrupt' | 'db_error'; message: string }

/**
 * Pure helper for AI-config loading + categorisation.
 *
 * Lives in its own module (no Electron dependencies) so unit tests can
 * exercise all four shapes (absent / present / json_corrupt / db_error)
 * under plain Node without booting the main-process import graph.
 *
 * Emits `ai_config_corrupt` / `ai_config_db_error` via `logAgentMetric` so
 * operators see config-related regressions even when the caller chooses to
 * mask the failure (e.g. the legacy `getAIConfig() -> null` adapter).
 */
export function readAIConfigDetailed(
  getSetting: () => string | null | undefined,
): AIConfigLoad {
  let raw: string | null | undefined
  try {
    raw = getSetting()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logAgentMetric('ai_config_db_error', { message: message.slice(0, 200) })
    return { ok: false, reason: 'db_error', message }
  }
  if (!raw) return { ok: true, config: null, reason: 'absent' }
  try {
    const parsed = JSON.parse(raw) as AIModelConfig
    return { ok: true, config: normalizeAIConfig(parsed), reason: 'present' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logAgentMetric('ai_config_corrupt', { sample: raw.slice(0, 80) })
    return { ok: false, reason: 'json_corrupt', message }
  }
}
