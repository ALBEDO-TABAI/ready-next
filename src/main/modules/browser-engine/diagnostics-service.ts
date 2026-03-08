import { appendFile } from 'fs/promises'

export const BROWSER_DIAGNOSTICS_LOG_PATH = '/tmp/ready-browser.log'

export class BrowserDiagnosticsService {
  private readonly recentEntries: string[] = []

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
}
