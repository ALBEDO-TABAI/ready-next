import type { ProcessMetric } from 'electron'

import type { BrowserTabLoadState } from './browser-tab-load-governor'

interface BrowserMetricsTab {
  id: string
  domain?: string
  url?: string
  view?: {
    webContents: {
      getOSProcessId(): number
      isDestroyed?: () => boolean
    }
  }
}

export interface BrowserRendererProcessMetric {
  pid: number
  tabIds: string[]
  domains: string[]
  loadStates: BrowserTabLoadState[]
  cpuPercent: number
  memoryKB: number
  processType: ProcessMetric['type']
  creationTime: number
}

interface BrowserMetricsServiceDeps {
  getAppMetrics: () => ProcessMetric[]
  getTabs: () => Iterable<BrowserMetricsTab>
  getLoadState: (tabId: string) => BrowserTabLoadState | null
}

export class BrowserMetricsService {
  constructor(private readonly deps: BrowserMetricsServiceDeps) {}

  sample(): BrowserRendererProcessMetric[] {
    const tabsByPid = new Map<number, BrowserMetricsTab[]>()
    for (const tab of this.deps.getTabs()) {
      const contents = tab.view?.webContents
      if (!contents) continue
      try {
        if (contents.isDestroyed?.()) continue
        const pid = contents.getOSProcessId()
        if (!Number.isInteger(pid) || pid <= 0) continue
        const group = tabsByPid.get(pid) ?? []
        group.push(tab)
        tabsByPid.set(pid, group)
      } catch {
        // A renderer may exit while app metrics are being sampled.
      }
    }

    return this.deps.getAppMetrics()
      .filter((metric) => tabsByPid.has(metric.pid))
      .map((metric) => {
        const tabs = tabsByPid.get(metric.pid) ?? []
        return {
          pid: metric.pid,
          tabIds: tabs.map((tab) => tab.id),
          domains: [...new Set(tabs.map((tab) => tab.domain || this.domainFromUrl(tab.url)).filter(Boolean))],
          loadStates: [...new Set(tabs.map((tab) => this.deps.getLoadState(tab.id)).filter((state): state is BrowserTabLoadState => state !== null))],
          cpuPercent: Number(metric.cpu?.percentCPUUsage || 0),
          memoryKB: Number(metric.memory?.workingSetSize || 0),
          processType: metric.type,
          creationTime: metric.creationTime,
        }
      })
  }

  private domainFromUrl(value?: string): string {
    try {
      return value ? new URL(value).hostname : ''
    } catch {
      return ''
    }
  }
}
