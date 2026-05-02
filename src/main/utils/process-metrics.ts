export const PROCESS_METRICS = {
  processUnhandledRejection: 'process_unhandled_rejection',
  processUncaughtException: 'process_uncaught_exception',
  renderProcessGone: 'render_process_gone',
  childProcessGone: 'child_process_gone',
  logRotationFailed: 'log_rotation_failed',
} as const

export type ProcessMetricName = typeof PROCESS_METRICS[keyof typeof PROCESS_METRICS]
