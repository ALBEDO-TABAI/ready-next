import { appendFile } from 'fs/promises'
import { getLogPath } from '../../utils/platform'

export const BROWSER_DIAGNOSTICS_LOG_PATH = getLogPath('ready-browser.log')

export interface BrowserTaskDiagnosticsSnapshot {
  sessionId?: string
  taskTitle: string
  taskSummary: string
  currentStepId: string | null
  blockedReason?: string | null
  recentEvidence: string[]
  resumableActions: string[]
  targetUrl?: string | null
  updatedAt: string
}

export interface BrowserPageDiagnosticsSnapshot {
  url: string
  title: string
  domain: string
  targetMatched: boolean
  uploadComplete: boolean
  promptComplete: boolean
  running: boolean
  modeSelection: boolean
  modalVisible: boolean
  canReuseCurrentPage: boolean
  updatedAt: string
}

export interface BrowserContinuityDiagnosticsSnapshot {
  sessionId?: string
  workflowKind: string
  stage: string
  canResume: boolean
  lastFailureReason?: string | null
  lastEvidence: string[]
  targetUrl?: string | null
  updatedAt: string
}

export class BrowserDiagnosticsService {
  private readonly recentEntries: string[] = []
  private currentTask: BrowserTaskDiagnosticsSnapshot | null = null
  private pageState: BrowserPageDiagnosticsSnapshot | null = null
  private continuity: BrowserContinuityDiagnosticsSnapshot | null = null
  private lastFailure: { reason: string; updatedAt: string } | null = null

  log(message: string): void {
    const line = `${new Date().toISOString()} ${message}\n`
    this.recentEntries.push(line.trimEnd())
    if (this.recentEntries.length > 80) {
      this.recentEntries.splice(0, this.recentEntries.length - 80)
    }
    void appendFile(BROWSER_DIAGNOSTICS_LOG_PATH, line, 'utf-8').catch(() => {
      // ignore file logging failures
    })
    console.log(message)
  }

  getRecentEntries(limit = 20): string[] {
    return this.recentEntries.slice(-Math.max(1, limit))
  }

  recordTask(snapshot: BrowserTaskDiagnosticsSnapshot | null): void {
    this.currentTask = snapshot
    if (snapshot?.blockedReason) {
      this.lastFailure = { reason: snapshot.blockedReason, updatedAt: snapshot.updatedAt }
    }
  }

  recordPageState(snapshot: BrowserPageDiagnosticsSnapshot | null): void {
    this.pageState = snapshot
  }

  recordContinuity(snapshot: BrowserContinuityDiagnosticsSnapshot | null): void {
    this.continuity = snapshot
    if (snapshot?.lastFailureReason) {
      this.lastFailure = { reason: snapshot.lastFailureReason, updatedAt: snapshot.updatedAt }
    }
  }

  getAgentSnapshot(): {
    currentTask: BrowserTaskDiagnosticsSnapshot | null
    pageState: BrowserPageDiagnosticsSnapshot | null
    continuity: BrowserContinuityDiagnosticsSnapshot | null
    lastFailure: { reason: string; updatedAt: string } | null
    availableActions: string[]
  } {
    const availableActions = Array.from(new Set([
      ...(this.currentTask?.resumableActions || []),
      this.currentTask?.targetUrl ? 'open_target' : '',
      'refresh',
    ].filter(Boolean)))
    return {
      currentTask: this.currentTask,
      pageState: this.pageState,
      continuity: this.continuity,
      lastFailure: this.lastFailure,
      availableActions,
    }
  }
}
