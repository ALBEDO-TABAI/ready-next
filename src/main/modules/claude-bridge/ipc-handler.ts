import { ipcMain, BrowserWindow, dialog } from 'electron'
import { AgentManager } from './agent-manager'
import type { MultimodalBlock } from './direct-chat'
import { BrowserController } from '../browser-engine/ipc-handler'
import { getDatabase } from '../database'
import { appendFileSync, readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import { AgentControlRuntime } from '../agent-control/runtime'
import { ChatRepository } from '../repositories/chat-repository'

let mammothLib: typeof import('mammoth') | null = null
let xlsxLib: typeof import('xlsx') | null = null

async function getMammoth(): Promise<typeof import('mammoth') | null> {
  if (mammothLib) return mammothLib
  try {
    mammothLib = await import('mammoth')
    return mammothLib
  } catch {
    return null
  }
}

async function getXlsx(): Promise<typeof import('xlsx') | null> {
  if (xlsxLib) return xlsxLib
  try {
    xlsxLib = await import('xlsx')
    return xlsxLib
  } catch {
    return null
  }
}

function normalizeCell(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function looksLikeReadableText(value: string): boolean {
  if (!value || value.trim().length === 0) return false
  const sample = value.slice(0, 4000)
  let printable = 0
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i)
    const isControl = code < 32 && code !== 9 && code !== 10 && code !== 13
    if (!isControl) printable += 1
  }
  return printable / sample.length > 0.88
}

const LOG = '/tmp/ready-directchat.log'
function log(msg: string) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch { /* */ }
}

export interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  mock?: boolean
}

let runtime: AgentControlRuntime | null = null
const chatRepository = new ChatRepository()

export async function cleanupAgentRuntime(): Promise<void> {
  if (!runtime) return
  await runtime.stop()
  runtime = null
}

export function setupAgentIPC(agentManager: AgentManager, mainWindow: BrowserWindow, browserController?: BrowserController): void {
  if (!runtime) {
    runtime = new AgentControlRuntime(agentManager, browserController)
    void runtime.start()
  } else if (browserController) {
    runtime.getOrchestrator().setBrowserController(browserController)
  }
  const orchestrator = runtime.getOrchestrator()
  log('setupAgentIPC called, Claude SDK runtime initialized')

  // Send message to agent — use direct HTTP streaming
  ipcMain.handle('agent:send', async (_, { agent, message, sessionId, requestId }: {
    agent: string
    message: string | MultimodalBlock[]
    sessionId?: string
    requestId?: string
  }): Promise<IPCResponse> => {
    log(`agent:send received — agent=${agent}, message=${typeof message === 'string' ? message.slice(0, 50) : `[${message.length} blocks]`}`)
    try {
      const result = await orchestrator.send(agent, message, sessionId, requestId)
      log(`agent:send result — success=${result.success}, error=${result.error}`)
      return {
        success: result.success,
        error: result.success ? undefined : result.error,
        mock: false
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`agent:send exception — ${errorMessage}`)
      return { success: false, error: errorMessage, mock: false }
    }
  })

  // Start a new session
  ipcMain.handle('agent:newSession', (_, payload: string | { agent: string; sessionId?: string }): IPCResponse<{ cleared: boolean }> => {
    try {
      const agent = typeof payload === 'string' ? payload : payload.agent
      const sessionId = typeof payload === 'string' ? undefined : payload.sessionId
      orchestrator.newSession(agent, sessionId)
      return { success: true, data: { cleared: true } }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  // Kill / stop generation
  ipcMain.handle('agent:kill', (_, payload: string | { agent: string; sessionId?: string }): IPCResponse<{ killed: boolean }> => {
    try {
      const agent = typeof payload === 'string' ? payload : payload.agent
      const sessionId = typeof payload === 'string' ? undefined : payload.sessionId
      orchestrator.kill(agent, sessionId)
      return { success: true, data: { killed: true } }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:orchestrate', async (_, { task, agents }: { task: string; agents: string[] }): Promise<IPCResponse> => {
    try {
      const result = await agentManager.orchestrate(task, agents)
      return { success: result.success, mock: result.mock, error: result.error }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:getStatus', (_, agent: string): IPCResponse => {
    try {
      const status = agentManager.getAgentStatus(agent)
      return { success: true, data: status ?? null }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:getAll', (): IPCResponse => {
    try {
      return { success: true, data: agentManager.getAllAgents() }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  // Get agent manager diagnostics
  ipcMain.handle('agent:getDiagnostics', (): IPCResponse<ReturnType<AgentManager['getDiagnostics']>> => {
    try {
      return { success: true, data: agentManager.getDiagnostics() }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:getRuntimeStatus', async (): Promise<IPCResponse> => {
    try {
      const status = await runtime!.getRuntimeStatus()
      return { success: true, data: status }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:listChannels', (): IPCResponse => {
    try {
      return { success: true, data: runtime!.listChannels() }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:listConversationScopes', (_, payload?: { agent?: string }): IPCResponse => {
    try {
      return { success: true, data: runtime!.listConversationScopes(payload?.agent) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agent:getConversationScopeMessages', (_, payload: { scopeId: string }): IPCResponse => {
    try {
      return { success: true, data: runtime!.getConversationScopeMessages(payload.scopeId) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agent:createLocalScope', (_, payload: { agent: string }): IPCResponse => {
    try {
      return { success: true, data: runtime!.createLocalScope(payload.agent) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agent:listScopeAttachments', (_, payload?: { scopeId?: string }): IPCResponse => {
    try {
      const scopeId = String(payload?.scopeId || '').trim()
      if (!scopeId) return { success: true, data: [] }
      return { success: true, data: runtime!.listScopeAttachments(scopeId) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agent:getScopeAttachment', (_, payload: { scopeId: string; attachmentId: string }): IPCResponse => {
    try {
      const attachment = runtime!.getScopeAttachment(payload.scopeId, payload.attachmentId)
      if (!attachment) {
        return { success: false, error: `Attachment not found: ${payload.attachmentId}` }
      }
      return { success: true, data: attachment }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agent:clearRemoteAttachmentCache', (_, payload?: { channelId?: string }): IPCResponse => {
    try {
      return { success: true, data: runtime!.clearRemoteAttachmentCache(payload?.channelId) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agent:getRemoteAttachmentCacheStats', (_, payload?: { channelId?: string }): IPCResponse => {
    try {
      return { success: true, data: runtime!.getRemoteAttachmentCacheStats(payload?.channelId) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agent:sendScoped', async (_, payload: {
    scopeId: string
    message: string | MultimodalBlock[]
    requestId?: string
  }): Promise<IPCResponse> => {
    try {
      const result = await runtime!.sendScoped(payload)
      return { success: result.success, error: result.error }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('agent:upsertChannel', async (_, payload: {
    id?: string
    type: 'local-debug' | 'generic-webhook' | 'feishu-bot' | 'feishu-app' | 'telegram-bot'
    name: string
    enabled?: boolean
    config?: Record<string, unknown>
  }): Promise<IPCResponse> => {
    try {
      const channel = await runtime!.upsertChannel(payload)
      return { success: true, data: channel }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:testChannel', async (_, payload: {
    id?: string
    type: 'local-debug' | 'generic-webhook' | 'feishu-bot' | 'feishu-app' | 'telegram-bot'
    name: string
    enabled?: boolean
    config?: Record<string, unknown>
  }): Promise<IPCResponse> => {
    try {
      const result = await runtime!.testChannel(payload)
      return { success: result.success, error: result.error }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:deleteChannel', async (_, payload: { id: string }): Promise<IPCResponse> => {
    try {
      const ok = await runtime!.deleteChannel(payload.id)
      return { success: ok, error: ok ? undefined : `Channel not found: ${payload.id}` }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:setChannelEnabled', async (_, payload: {
    id: string
    enabled: boolean
  }): Promise<IPCResponse> => {
    try {
      const channel = await runtime!.setChannelEnabled(payload.id, payload.enabled)
      if (!channel) return { success: false, error: `Channel not found: ${payload.id}` }
      return { success: true, data: channel }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:sendChannelProbe', async (_, payload: {
    id: string
    text: string
  }): Promise<IPCResponse> => {
    try {
      const result = await runtime!.sendChannelProbe(payload.id, payload.text)
      return { success: result.success, error: result.error }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:listSchedules', (): IPCResponse => {
    try {
      return { success: true, data: runtime!.listSchedules() }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:upsertSchedule', async (_, payload: {
    id?: string
    name: string
    cronExpr: string
    prompt: string
    channelId?: string | null
    enabled?: boolean
    payload?: Record<string, unknown>
  }): Promise<IPCResponse> => {
    try {
      const schedule = await runtime!.upsertSchedule(payload)
      return { success: true, data: schedule }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:runScheduleNow', async (_, payload: { id: string }): Promise<IPCResponse> => {
    try {
      const result = await runtime!.runScheduleNow(payload.id)
      return { success: result.success, error: result.error }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:pauseSchedule', async (_, payload: { id: string }): Promise<IPCResponse> => {
    try {
      const schedule = await runtime!.pauseSchedule(payload.id)
      if (!schedule) return { success: false, error: `Schedule not found: ${payload.id}` }
      return { success: true, data: schedule }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:resumeSchedule', async (_, payload: { id: string }): Promise<IPCResponse> => {
    try {
      const schedule = await runtime!.resumeSchedule(payload.id)
      if (!schedule) return { success: false, error: `Schedule not found: ${payload.id}` }
      return { success: true, data: schedule }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('agent:deleteSchedule', async (_, payload: { id: string }): Promise<IPCResponse> => {
    try {
      const removed = await runtime!.deleteSchedule(payload.id)
      return { success: removed, error: removed ? undefined : `Schedule not found: ${payload.id}` }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  // ===================== Chat History IPC =====================

  ipcMain.handle('chat:getConversations', (_, agent: string): IPCResponse => {
    try {
      const conversations = chatRepository.getConversations(agent)
      return { success: true, data: conversations }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('chat:getMessages', (_, conversationId: string): IPCResponse => {
    try {
      const messages = chatRepository.getMessages(conversationId)
      return { success: true, data: messages }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('chat:deleteConversation', (_, conversationId: string): IPCResponse => {
    try {
      chatRepository.deleteConversation(conversationId)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('chat:saveMessage', (_, data: {
    id: string; conversationId: string; role: string; content: string; timestamp: string; meta?: Record<string, unknown>
  }): IPCResponse => {
    try {
      chatRepository.saveMessage(data)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('chat:createConversation', (_, data: {
    id: string; agent: string; title: string
  }): IPCResponse => {
    try {
      chatRepository.createConversation(data)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('chat:updateConversationTitle', (_, data: {
    id: string; title: string
  }): IPCResponse => {
    try {
      chatRepository.updateConversationTitle(data)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ===================== File Picker IPC (W3) =====================

  ipcMain.handle('chat:pickFiles', async (): Promise<IPCResponse> => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'All Supported',
            extensions: [
              'png', 'jpg', 'jpeg', 'gif', 'webp',
              'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v',
              'txt', 'md', 'csv', 'json', 'html',
              'docx', 'doc', 'rtf', 'odt',
              'xlsx', 'xls', 'pdf',
            ],
          }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, data: [] }
      }
      const files = result.filePaths.map(filePath => {
        const ext = extname(filePath).toLowerCase()
        const stat = statSync(filePath)
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
        const videoExts = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']
        const textExts = ['.txt', '.md', '.csv', '.json', '.html', '.pdf', '.docx', '.doc', '.rtf', '.odt']
        const spreadExts = ['.xlsx', '.xls']
        let type: string = 'other'
        if (imageExts.includes(ext)) type = 'image'
        else if (videoExts.includes(ext)) type = 'video'
        else if (textExts.includes(ext)) type = 'text'
        else if (spreadExts.includes(ext)) type = 'spreadsheet'

        return {
          name: basename(filePath),
          path: filePath,
          type,
          size: stat.size,
          ext
        }
      })
      return { success: true, data: files }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ===================== File Read for AI (W5) =====================

  ipcMain.handle('chat:readFileForAI', async (_, filePath: string): Promise<IPCResponse> => {
    try {
      const MAX_INLINE_VIDEO_BYTES = 40 * 1024 * 1024 // 40MB
      const ext = extname(filePath).toLowerCase()
      const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.ico', '.avif']
      const videoExts = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']
      const audioExts = ['.mp3', '.wav', '.aac', '.ogg', '.flac', '.m4a', '.wma', '.opus']
      const textExts = ['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.html', '.css', '.csv', '.xml', '.yml', '.yaml', '.log']
      const spreadsheetExts = ['.xlsx', '.xls']

      if (imageExts.includes(ext)) {
        // Return base64 encoded image
        const buffer = readFileSync(filePath)
        const base64 = buffer.toString('base64')
        const mimeMap: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
          '.svg': 'image/svg+xml', '.tiff': 'image/tiff', '.tif': 'image/tiff',
          '.ico': 'image/x-icon', '.avif': 'image/avif',
        }
        return { success: true, data: { type: 'image', base64, mimeType: mimeMap[ext] || 'image/png' } }
      }

      if (videoExts.includes(ext)) {
        const stat = statSync(filePath)
        if (stat.size > MAX_INLINE_VIDEO_BYTES) {
          return {
            success: true,
            data: {
              type: 'text',
              content: `[视频文件过大，已降级为描述: ${basename(filePath)}, ${(stat.size / 1024 / 1024).toFixed(1)}MB。当前内联上传上限 ${(MAX_INLINE_VIDEO_BYTES / 1024 / 1024).toFixed(0)}MB]`,
              name: basename(filePath)
            }
          }
        }

        const buffer = readFileSync(filePath)
        const base64 = buffer.toString('base64')
        const mimeMap: Record<string, string> = {
          '.mp4': 'video/mp4',
          '.mov': 'video/quicktime',
          '.webm': 'video/webm',
          '.mkv': 'video/x-matroska',
          '.avi': 'video/x-msvideo',
          '.m4v': 'video/x-m4v',
        }
        return {
          success: true,
          data: {
            type: 'video',
            base64,
            mimeType: mimeMap[ext] || 'video/mp4',
            name: basename(filePath),
          }
        }
      }

      if (audioExts.includes(ext)) {
        const stat = statSync(filePath)
        return { success: true, data: { type: 'text', content: `[音频文件: ${basename(filePath)}, 大小: ${(stat.size / 1024 / 1024).toFixed(1)}MB]`, name: basename(filePath) } }
      }

      if (ext === '.docx') {
        const mammoth = await getMammoth()
        if (!mammoth) {
          return {
            success: true,
            data: {
              type: 'text',
              content: `[DOCX 文件: ${basename(filePath)}。未检测到 mammoth 解析库，暂无法提取正文内容。]`,
              name: basename(filePath),
            },
          }
        }

        const buffer = readFileSync(filePath)
        const mammothMod = (mammoth as unknown as { default?: typeof import('mammoth') }).default || mammoth
        try {
          const textResult = await mammothMod.extractRawText({ buffer })
          const raw = (textResult.value || '').trim()
          const clipped = raw.slice(0, 20_000)
          const suffix = raw.length > 20_000 ? '\n...[DOCX 内容已截断]' : ''
          return {
            success: true,
            data: {
              type: 'text',
              content: `--- DOCX: ${basename(filePath)} ---\n${clipped}${suffix}`,
              name: basename(filePath),
            },
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/end of central directory|zip file/i.test(message)) {
            const fallbackText = readFileSync(filePath, 'utf-8')
            if (looksLikeReadableText(fallbackText)) {
              const clipped = fallbackText.slice(0, 20_000)
              const suffix = fallbackText.length > 20_000 ? '\n...[DOCX 回退文本已截断]' : ''
              return {
                success: true,
                data: {
                  type: 'text',
                  content: `--- DOCX(结构损坏回退文本): ${basename(filePath)} ---\n${clipped}${suffix}`,
                  name: basename(filePath),
                },
              }
            }
          }
          throw error
        }
      }

      if (spreadsheetExts.includes(ext)) {
        const xlsx = await getXlsx()
        if (!xlsx) {
          return {
            success: true,
            data: {
              type: 'text',
              content: `[表格文件: ${basename(filePath)}。未检测到 xlsx 解析库，暂无法提取内容。]`,
              name: basename(filePath),
            },
          }
        }

        const xlsxMod = (xlsx as unknown as { default?: typeof import('xlsx') }).default || xlsx
        const workbook = xlsxMod.read(readFileSync(filePath), { type: 'buffer' })
        const sheetSummaries: string[] = []

        for (const sheetName of workbook.SheetNames.slice(0, 6)) {
          const sheet = workbook.Sheets[sheetName]
          const rows = xlsxMod.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][]
          const previewRows = rows.slice(0, 40).map((row) =>
            (Array.isArray(row) ? row : [row]).slice(0, 20).map(normalizeCell).join(' | '),
          )
          sheetSummaries.push(
            `### Sheet: ${sheetName}\n${previewRows.length > 0 ? previewRows.join('\n') : '(空表)'}`
          )
        }

        const content = `--- 表格文件: ${basename(filePath)} ---\n${sheetSummaries.join('\n\n')}`.slice(0, 20_000)
        return {
          success: true,
          data: { type: 'text', content, name: basename(filePath) },
        }
      }

      if (textExts.includes(ext)) {
        const content = readFileSync(filePath, 'utf-8')
        return { success: true, data: { type: 'text', content, name: basename(filePath) } }
      }

      const stat = statSync(filePath)
      return {
        success: true,
        data: {
          type: 'text',
          content: `[文件附件: ${basename(filePath)}, 扩展名: ${ext || 'unknown'}, 大小: ${(stat.size / 1024 / 1024).toFixed(2)}MB]`,
          name: basename(filePath),
        },
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Forward Claude SDK orchestrator events to renderer
  orchestrator.on('output', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:stream', data)
      if (data.sessionId) {
        const timestamp = new Date().toISOString()
        if (data.type === 'tool_use' || data.type === 'tool_result') {
          mainWindow.webContents.send('agent:scopeRunEvent', {
            type: 'updated',
            scopeId: data.sessionId,
            agent: data.agent,
            runId: data.runId,
            phase: 'tool_running',
            latestText: data.chunk || '',
            toolEvent: {
              id: `${data.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: data.type === 'tool_use' ? 'call' : 'result',
              text: data.chunk || '',
              timestamp,
            },
            timestamp,
          })
        } else if (data.type === 'done') {
          mainWindow.webContents.send('agent:scopeRunEvent', {
            type: 'finished',
            scopeId: data.sessionId,
            agent: data.agent,
            runId: data.runId,
            phase: 'done',
            timestamp,
          })
        } else if (data.type === 'text') {
          mainWindow.webContents.send('agent:scopeRunEvent', {
            type: 'updated',
            scopeId: data.sessionId,
            agent: data.agent,
            runId: data.runId,
            phase: 'responding',
            latestText: data.chunk || '',
            timestamp,
          })
        }
      }
    }
  })

  orchestrator.on('status', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:status', data)
      if (data.sessionId) {
        const phase = data.status === 'working'
          ? 'planning'
          : data.status === 'done'
            ? 'done'
            : data.status === 'cancelled'
              ? 'cancelled'
              : data.status === 'error'
                ? 'error'
                : 'queued'
        mainWindow.webContents.send('agent:scopeRunEvent', {
          type: data.status === 'working' ? 'started' : data.status === 'done' || data.status === 'cancelled' || data.status === 'error' ? 'finished' : 'updated',
          scopeId: data.sessionId,
          agent: data.agent,
          runId: data.runId,
          phase,
          latestText: typeof data.status === 'string' ? `状态：${data.status}` : undefined,
          timestamp: new Date().toISOString(),
        })
      }
    }
  })

  orchestrator.on('error', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:error', data)
      if (data.sessionId) {
        mainWindow.webContents.send('agent:scopeRunEvent', {
          type: 'finished',
          scopeId: data.sessionId,
          agent: data.agent,
          runId: data.runId,
          phase: 'error',
          error: data.error,
          latestText: data.error,
          timestamp: new Date().toISOString(),
        })
      }
    }
  })

  orchestrator.on('toolAction', (data: { tool: string; args: Record<string, unknown> }) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:toolAction', data)
    }
  })

  runtime.on('conversationEvent', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:conversationEvent', data)
    }
  })

  runtime.on('scopeRunEvent', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:scopeRunEvent', data)
    }
  })

  // Forward legacy agent manager events to renderer (kept for orchestration)
  agentManager.on('output', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:stream', data)
    }
  })

  // Forward agent status changes to renderer
  agentManager.on('status', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:status', data)
    }
  })

  // Forward agent error events to renderer
  agentManager.on('error', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:error', data)
    }
  })

  // Handle tool execution requests from agents
  agentManager.on('tool_execute', async (data: { agent: string; tool: string; args: Record<string, unknown>; toolId?: string }) => {
    let result: unknown = { error: `Unknown tool: ${data.tool}` }

    try {
      switch (data.tool) {
        case 'calendar.createEvent':
          result = await ipcMain.emit('calendar:createEvent', data.args) || { success: true, message: 'Event creation forwarded' }
          break
        case 'calendar.listEvents':
          result = { success: true, message: 'Calendar event listing forwarded' }
          break
        case 'document.openFile':
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent:toolAction', { tool: 'document.openFile', args: data.args })
          }
          result = { success: true, message: `Opening file: ${data.args.path}` }
          break
        case 'document.writeFile':
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent:toolAction', { tool: 'document.writeFile', args: data.args })
          }
          result = { success: true, message: `File written: ${data.args.path}` }
          break
        case 'app.switchMode':
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent:toolAction', { tool: 'app.switchMode', args: data.args })
          }
          result = { success: true, message: `Switched to mode: ${data.args.mode}` }
          break
        case 'app.notify':
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent:toolAction', { tool: 'app.notify', args: data.args })
          }
          result = { success: true, message: 'Notification sent' }
          break
        default:
          result = { error: `Unknown tool: ${data.tool}` }
      }
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) }
    }

    // Feed result back to the agent
    agentManager.feedToolResult(data.agent, data.toolId, result)
  })
}
