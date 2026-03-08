import type { Session } from 'electron'
import { BrowserDataService } from './data-service'

interface BrowserDownloadServiceDeps {
  dataService: BrowserDataService
  sendToRenderer: (channel: string, data: unknown) => void
}

export class BrowserDownloadService {
  private registeredSessions = new WeakSet<Session>()

  constructor(private readonly deps: BrowserDownloadServiceDeps) {}

  ensureRegistered(targetSession: Session): void {
    if (this.registeredSessions.has(targetSession)) return

    targetSession.on('will-download', (_event, item) => {
      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const filename = item.getFilename()
      const totalBytes = item.getTotalBytes()
      const startedAt = Math.floor(Date.now() / 1000)
      const mimeType = typeof item.getMimeType === 'function' ? item.getMimeType() : null
      const canResume = typeof item.canResume === 'function' ? item.canResume() : false

      try {
        this.deps.dataService.addDownload({
          id: downloadId,
          url: item.getURL(),
          filename,
          save_path: item.getSavePath() || '',
          total_bytes: totalBytes,
          received_bytes: 0,
          state: 'progressing',
          mime_type: mimeType,
          end_time: null,
          can_resume: canResume,
        })
      } catch {
        /* ignore */
      }

      item.on('updated', (_ev, state) => {
        if (state !== 'progressing') return
        const received = item.getReceivedBytes()
        try { this.deps.dataService.updateDownloadProgress(downloadId, received) } catch { /* ignore */ }
        try {
          this.deps.dataService.updateDownloadState(downloadId, 'progressing', {
            savePath: item.getSavePath() || '',
            mimeType,
            canResume: typeof item.canResume === 'function' ? item.canResume() : canResume,
          })
        } catch {
          /* ignore */
        }
        this.deps.sendToRenderer('browser:downloadUpdate', {
          id: downloadId,
          filename,
          totalBytes,
          receivedBytes: received,
          state: 'progressing',
        })
      })

      item.once('done', (_ev, state) => {
        const finalPath = item.getSavePath()
        if (state === 'completed') {
          try {
            this.deps.dataService.updateDownloadProgress(downloadId, item.getReceivedBytes())
            this.deps.dataService.updateDownloadState(downloadId, 'completed', {
              savePath: finalPath,
              mimeType,
              endTime: Math.max(startedAt, Math.floor(Date.now() / 1000)),
              error: null,
              canResume: typeof item.canResume === 'function' ? item.canResume() : canResume,
            })
          } catch {
            /* ignore */
          }
        } else {
          try {
            this.deps.dataService.updateDownloadProgress(downloadId, item.getReceivedBytes())
            this.deps.dataService.updateDownloadState(downloadId, state, {
              savePath: finalPath,
              mimeType,
              endTime: Math.max(startedAt, Math.floor(Date.now() / 1000)),
              error: state,
              canResume: typeof item.canResume === 'function' ? item.canResume() : canResume,
            })
          } catch {
            /* ignore */
          }
        }
        this.deps.sendToRenderer('browser:downloadUpdate', {
          id: downloadId,
          filename,
          totalBytes,
          receivedBytes: item.getReceivedBytes(),
          state,
        })
      })
    })

    this.registeredSessions.add(targetSession)
  }
}
