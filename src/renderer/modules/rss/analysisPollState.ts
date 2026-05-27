export interface RSSAnalysisProgressPollResult {
  ok: boolean
  hasActiveWork: boolean
}

const RSS_BACKGROUND_SYNC_WARNING = 'RSS 后台同步失败，部分状态可能过期。'

export function getRSSAnalysisPollState(
  progress: RSSAnalysisProgressPollResult,
  jobsOk: boolean,
): { backgroundWarning: string | null; nextDelayMs: number } {
  return {
    backgroundWarning: progress.ok && jobsOk ? null : RSS_BACKGROUND_SYNC_WARNING,
    nextDelayMs: progress.hasActiveWork ? 1400 : 9000,
  }
}
