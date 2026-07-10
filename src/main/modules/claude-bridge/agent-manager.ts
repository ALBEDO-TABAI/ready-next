import { spawn, spawnSync, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { WorktreePool } from './worktree-pool'
import { type AIModelConfig } from '../../../shared/ai-providers'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import {
  readAIConfigDetailed,
  unwrapAIConfigOrThrow,
  type AIConfigLoad,
} from './direct-chat-ai-config'

export interface AgentInstance {
  name: string
  process: ChildProcess
  worktree: string
  status: 'idle' | 'working' | 'done' | 'error' | 'timeout'
  task?: string
  isMock: boolean
  spawnTime: number
  exitCode?: number | null
  errorMessage?: string
}

export interface AgentOutput {
  agent: string
  chunk: string
  type: 'stdout' | 'stderr' | 'error' | 'text' | 'done' | 'tool_use'
}

export interface AgentStatusEvent {
  agent: string
  status: AgentInstance['status']
  exitCode?: number | null
  errorMessage?: string
  isMock: boolean
}

export interface AgentSpawnResult {
  success: boolean
  agent: string
  mock: boolean
  pid?: number
  error?: string
  exitCode?: number | null
  reused?: boolean
}

export interface OrchestrateResult {
  success: boolean
  mock: boolean
  error?: string
}

export interface AgentErrorEvent {
  agent: string
  error: string
  type: 'spawn' | 'runtime' | 'timeout' | 'exit'
  exitCode?: number | null
}

// ---------------------------------------------------------------------------
// Agent Tool Definitions
// These are passed to Claude via --allowedTools and system prompt so the agent
// can call back into the app.
// ---------------------------------------------------------------------------

export interface AgentToolDef {
  name: string
  description: string
  parameters: Record<string, { type: string; description: string; required?: boolean }>
}

const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: 'calendar.createEvent',
    description: 'Create a new calendar event in the user\'s calendar',
    parameters: {
      title: { type: 'string', description: 'Event title', required: true },
      startTime: { type: 'string', description: 'ISO 8601 start time', required: true },
      endTime: { type: 'string', description: 'ISO 8601 end time', required: true },
      description: { type: 'string', description: 'Event description' }
    }
  },
  {
    name: 'calendar.listEvents',
    description: 'List calendar events within a date range',
    parameters: {
      startDate: { type: 'string', description: 'ISO 8601 start date', required: true },
      endDate: { type: 'string', description: 'ISO 8601 end date', required: true }
    }
  },
  {
    name: 'document.openFile',
    description: 'Open a file in the document editor',
    parameters: {
      path: { type: 'string', description: 'Absolute file path to open', required: true }
    }
  },
  {
    name: 'document.writeFile',
    description: 'Write content to a file',
    parameters: {
      path: { type: 'string', description: 'Absolute file path', required: true },
      content: { type: 'string', description: 'File content to write', required: true }
    }
  },
  {
    name: 'app.switchMode',
    description: 'Switch the app to a different workspace mode',
    parameters: {
      mode: { type: 'string', description: 'Mode name: browser, document, image, video, rss, calendar', required: true }
    }
  },
  {
    name: 'app.notify',
    description: 'Show a notification message to the user',
    parameters: {
      message: { type: 'string', description: 'Notification message text', required: true }
    }
  }
]

const settingsRepository = new AppSettingsRepository()

function buildToolSystemPrompt(): string {
  const toolDescriptions = AGENT_TOOLS.map(t => {
    const params = Object.entries(t.parameters)
      .map(([k, v]) => `  - ${k} (${v.type}${v.required ? ', required' : ''}): ${v.description}`)
      .join('\n')
    return `### ${t.name}\n${t.description}\nParameters:\n${params}`
  }).join('\n\n')

  return `\n\n---\nYou have access to the following tools in the Ready app. To invoke a tool, output a JSON block with this exact format on its own line:\n\n:::tool_call\n{"tool": "<tool_name>", "args": { ... }}\n:::\n\nAvailable tools:\n\n${toolDescriptions}\n`
}

// ---------------------------------------------------------------------------
// Session tracking for persistent processes
// ---------------------------------------------------------------------------

interface AgentSession {
  process: ChildProcess
  worktreePath: string
  isMock: boolean
  spawnTime: number
  lineBuffer: string
  timeoutId: ReturnType<typeof setTimeout> | null
}

export class AgentManager extends EventEmitter {
  private agents = new Map<string, AgentInstance>()
  private sessions = new Map<string, AgentSession>()
  private worktreePool: WorktreePool
  private maxAgents = 4
  private useMock: boolean
  private agentTimeoutMs: number
  private claudeAvailable: boolean | null = null

  constructor(useMock = false, agentTimeoutMs = 5 * 60 * 1000) {
    super()
    this.useMock = useMock
    this.agentTimeoutMs = agentTimeoutMs
    this.worktreePool = new WorktreePool(useMock)
    // claudeAvailable 保持 null，首次 shouldUseMock() 时再懒检查：
    // 构造发生在主进程启动路径上，这里的同步 spawnSync 会拖慢启动。
  }

  /**
   * Check if Claude CLI is available (with timeout)
   */
  private checkClaudeAvailability(): boolean {
    try {
      const result = spawnSync('claude', ['--version'], {
        stdio: 'ignore',
        timeout: 5000
      })
      return result.status === 0
    } catch {
      return false
    }
  }

  /**
   * Determine if we should use mock mode for this agent
   */
  private shouldUseMock(): boolean {
    if (this.useMock) return true
    if (this.claudeAvailable === null) {
      this.claudeAvailable = this.checkClaudeAvailability()
    }
    return !this.claudeAvailable
  }

  /**
   * Send a message to an existing agent session, or spawn a new one.
   * This is the main entry point — it reuses a running Claude process
   * if one exists for the given agent name, otherwise spawns fresh.
   */
  async spawnAgent(name: string, task: string): Promise<AgentSpawnResult> {
    // Check for an existing live session
    const existing = this.sessions.get(name)
    if (existing && !existing.process.killed && existing.process.exitCode === null) {
      // Reuse the existing process — write the new message to stdin
      try {
        existing.process.stdin?.write(task + '\n')
        this.emit('status', { agent: name, status: 'working', isMock: existing.isMock })

        // Reset timeout
        if (existing.timeoutId) clearTimeout(existing.timeoutId)
        existing.timeoutId = this.createSessionTimeout(name)

        return {
          success: true,
          agent: name,
          mock: existing.isMock,
          pid: existing.process.pid,
          reused: true
        }
      } catch {
        // stdin write failed — kill and respawn below
        this.destroySession(name)
      }
    }

    // Limit check
    if (this.sessions.size >= this.maxAgents) {
      const error = `Maximum agent limit (${this.maxAgents}) reached.`
      this.emit('output', {
        agent: name,
        chunk: `Error: ${error}`,
        type: 'error'
      })
      return { success: false, agent: name, mock: false, error }
    }

    // Kill any leftover session with same name
    this.destroySession(name)

    let isMock = this.shouldUseMock()
    const spawnTime = Date.now()

    try {
      const wt = await this.worktreePool.acquire(name)

      let proc: ChildProcess
      try {
        proc = isMock
          ? this.createMockProcess(task)
          : this.createClaudeProcess(wt.path, task)
      } catch (processError) {
        // If Claude process creation fails, fall back to mock
        if (!isMock) {
          isMock = true
          this.emit('output', {
            agent: name,
            chunk: `Claude process creation failed, falling back to mock mode: ${processError instanceof Error ? processError.message : String(processError)}`,
            type: 'stderr'
          })
          proc = this.createMockProcess(task)
        } else {
          throw processError
        }
      }

      const agent: AgentInstance = {
        name,
        process: proc,
        worktree: wt.path,
        status: 'working',
        task,
        isMock,
        spawnTime
      }

      this.agents.set(name, agent)
      this.emit('status', { agent: name, status: 'working', isMock: agent.isMock })

      // Setup timeout handler
      const timeoutId = this.createSessionTimeout(name)

      // Create session tracking
      const session: AgentSession = {
        process: proc,
        worktreePath: wt.path,
        isMock,
        spawnTime,
        lineBuffer: '',
        timeoutId
      }
      this.sessions.set(name, session)

      // Buffer for incomplete JSON lines
      proc.stdout?.on('data', (chunk: Buffer) => {
        session.lineBuffer += chunk.toString()
        const lines = session.lineBuffer.split('\n')
        // Keep the last potentially incomplete line in the buffer
        session.lineBuffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const json = JSON.parse(trimmed)
            // Extract text content from stream-json format
            if (json.type === 'assistant' && json.message?.content) {
              for (const block of json.message.content) {
                if (block.type === 'text' && block.text) {
                  this.emit('output', { agent: name, chunk: block.text, type: 'text' })
                  // Check for tool_call patterns in the text
                  this.parseToolCalls(name, block.text)
                }
                if (block.type === 'tool_use') {
                  this.emit('output', {
                    agent: name,
                    chunk: `${block.name}(${JSON.stringify(block.input || {})})`,
                    type: 'tool_use'
                  })
                  this.handleToolUse(name, block.name, block.input || {}, block.id)
                }
              }
            } else if (json.type === 'result') {
              // Stream completed — send the final result text
              if (json.result) {
                this.emit('output', { agent: name, chunk: '', type: 'done' })
              }
            }
            // Ignore 'system' init messages and thinking blocks
          } catch {
            // Non-JSON line — forward raw text (e.g. mock process output)
            this.emit('output', { agent: name, chunk: trimmed, type: 'stdout' })
          }
        }
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) {
          this.emit('output', { agent: name, chunk: text, type: 'stderr' })
        }
      })

      proc.on('close', (code) => {
        if (session.timeoutId) clearTimeout(session.timeoutId)
        agent.exitCode = code
        const status = code === 0 ? 'done' : 'error'
        agent.status = status

        if (code !== 0 && code !== null) {
          agent.errorMessage = `Process exited with code ${code}`
          this.emit('error', {
            agent: name,
            error: agent.errorMessage,
            type: 'exit',
            exitCode: code
          } as AgentErrorEvent)
        }

        this.emit('status', {
          agent: name,
          status,
          exitCode: code,
          isMock: agent.isMock
        } as AgentStatusEvent)
        this.agents.delete(name)
        this.sessions.delete(name)
        this.worktreePool.release(wt.path).catch(console.error)
      })

      proc.on('error', (error) => {
        if (session.timeoutId) clearTimeout(session.timeoutId)
        agent.status = 'error'
        agent.errorMessage = `Process error: ${error.message}`

        this.emit('output', {
          agent: name,
          chunk: agent.errorMessage,
          type: 'error'
        })
        this.emit('error', {
          agent: name,
          error: error.message,
          type: 'runtime'
        } as AgentErrorEvent)
        this.emit('status', {
          agent: name,
          status: 'error',
          errorMessage: agent.errorMessage,
          isMock: agent.isMock
        } as AgentStatusEvent)
        this.agents.delete(name)
        this.sessions.delete(name)
        this.worktreePool.release(wt.path).catch(console.error)
      })

      return {
        success: true,
        agent: name,
        mock: agent.isMock,
        pid: proc.pid,
        reused: false
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.emit('output', {
        agent: name,
        chunk: `Failed to spawn agent: ${errorMessage}`,
        type: 'error'
      })
      this.emit('error', {
        agent: name,
        error: errorMessage,
        type: 'spawn'
      } as AgentErrorEvent)
      return {
        success: false,
        agent: name,
        mock: isMock,
        error: errorMessage
      }
    }
  }

  /**
   * Create a timeout for a session that fires if no activity for agentTimeoutMs
   */
  private createSessionTimeout(name: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const agent = this.agents.get(name)
      if (agent && agent.status === 'working') {
        agent.status = 'timeout'
        agent.errorMessage = `Agent timed out after ${this.agentTimeoutMs}ms`
        this.emit('output', {
          agent: name,
          chunk: agent.errorMessage,
          type: 'error'
        })
        this.emit('error', {
          agent: name,
          error: agent.errorMessage,
          type: 'timeout'
        })
        this.emit('status', {
          agent: name,
          status: 'timeout',
          errorMessage: agent.errorMessage,
          isMock: agent.isMock
        })
        this.destroySession(name)
      }
    }, this.agentTimeoutMs)
  }

  /**
   * Destroy an agent session (kill process, release worktree)
   */
  private destroySession(name: string): void {
    const session = this.sessions.get(name)
    if (session) {
      if (session.timeoutId) clearTimeout(session.timeoutId)
      try {
        session.process.kill('SIGTERM')
        setTimeout(() => {
          if (!session.process.killed) {
            session.process.kill('SIGKILL')
          }
        }, 5000)
      } catch {
        // Process may already be dead
      }
      this.sessions.delete(name)
      this.worktreePool.release(session.worktreePath).catch(console.error)
    }
    this.agents.delete(name)
  }

  /**
   * Start a new session for an agent (kill existing, clear state)
   */
  newSession(name: string): void {
    this.destroySession(name)
    this.emit('status', { agent: name, status: 'idle', isMock: this.shouldUseMock() })
  }

  /**
   * Parse tool_call patterns from agent text output
   * Looks for :::tool_call\n{...}\n::: blocks
   */
  private parseToolCalls(agentName: string, text: string): void {
    const toolCallRegex = /:::tool_call\s*\n\s*({[\s\S]*?})\s*\n\s*:::/g
    let match: RegExpExecArray | null
    while ((match = toolCallRegex.exec(text)) !== null) {
      try {
        const call = JSON.parse(match[1])
        if (call.tool && typeof call.tool === 'string') {
          this.handleToolUse(agentName, call.tool, call.args || {})
        }
      } catch {
        // Invalid JSON in tool call — skip
      }
    }
  }

  /**
   * Handle a tool_use block from Claude's output.
   *
   * Stage U0.1 — the legacy `tool_execute` event and its consumer in
   * `claude-bridge/ipc-handler.ts` are gone. AgentManager retains only the
   * renderer-visible `tool_use` trace; real tool execution flows through the
   * Agent SDK runtime. `feedToolResult` was removed as part of the bridge
   * retirement.
   */
  private handleToolUse(
    agentName: string,
    toolName: string,
    args: Record<string, unknown>,
    _toolId?: string
  ): void {
    // Emit tool_use event so the renderer can display it
    this.emit('output', {
      agent: agentName,
      chunk: `${toolName}(${JSON.stringify(args)})`,
      type: 'tool_use'
    })
  }

  /**
   * Read the current AI model config from the database (settings table).
   *
   * Stage 2.4b — replaces the legacy try/catch-and-return-null with a
   * detailed result via `readAIConfigDetailed` so callers can distinguish
   * absent / corrupt / DB-error. The legacy `getAIConfig()` adapter is
   * preserved for callers that don't need the failure mode.
   */
  private getAIConfigDetailed(): AIConfigLoad {
    return readAIConfigDetailed(() => settingsRepository.getSetting('ai_model_config'))
  }

  private getAIConfig(): AIModelConfig | null {
    const detail = this.getAIConfigDetailed()
    if (!detail.ok) return null
    return detail.config
  }

  /**
   * Create Claude Code process — persistent session (stdin stays open)
   */
  private createClaudeProcess(worktreePath: string, task: string): ChildProcess {
    const toolPrompt = buildToolSystemPrompt()

    // Read dynamic AI config from database. Stage 2.4b: refuse to launch
    // when the config is corrupt or the DB throws — the caller in
    // `runWithSession` (try/catch around createClaudeProcess) catches this
    // and falls back to mock mode with the actual reason in the output
    // stream, instead of starting a subprocess with empty creds that fails
    // later as an opaque auth error.
    const aiConfig = unwrapAIConfigOrThrow(this.getAIConfigDetailed())
    const baseUrl = aiConfig?.baseUrl
      || process.env.ANTHROPIC_BASE_URL
      || 'https://api.moonshot.cn/v1'
    const apiKey = aiConfig?.apiKey
      || process.env.ANTHROPIC_API_KEY
      || ''

    // Build a clean env — strip ALL Claude-related env vars to prevent "nested session" detection
    const cleanEnv: Record<string, string | undefined> = {}
    for (const [key, val] of Object.entries(process.env)) {
      if (!key.startsWith('CLAUDE') && key !== 'ANTHROPIC_BASE_URL' && key !== 'ANTHROPIC_API_KEY') {
        cleanEnv[key] = val
      }
    }

    const proc = spawn(
      'claude',
      [
        '-p', task,
        '--verbose',
        '--output-format', 'stream-json',
        '--system-prompt', toolPrompt
      ],
      {
        cwd: worktreePath,
        env: {
          ...cleanEnv,
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: apiKey,
        }
      }
    )

    if (!proc.pid) {
      throw new Error('Failed to spawn Claude process')
    }

    return proc
  }

  /**
   * Create mock process for environments without Claude CLI
   */
  private createMockProcess(task: string): ChildProcess {
    const script = `
const task = ${JSON.stringify(task)};
process.stdin.resume();
process.stdin.setEncoding('utf8');

// Send initial response
const response = {
  type: 'assistant',
  message: {
    content: [{
      type: 'text',
      text: '[Mock Agent] 收到任务: ' + task + '\\n\\nClaude Code 当前不可用，运行在模拟模式。\\n\\n### 模拟回复\\n- **任务已记录**\\n- 等待 Claude CLI 配置\\n- 输入新消息继续对话'
    }]
  }
};
console.log(JSON.stringify(response));

const done = { type: 'result', result: 'done' };
console.log(JSON.stringify(done));

// Listen for follow-up messages on stdin
process.stdin.on('data', (data) => {
  const msg = data.toString().trim();
  if (!msg) return;
  const followUp = {
    type: 'assistant',
    message: {
      content: [{
        type: 'text',
        text: '[Mock Agent] 收到后续消息: ' + msg + '\\n\\n这是模拟的后续回复。在 Electron 环境中配置 Claude CLI 后可使用真实 AI。'
      }]
    }
  };
  console.log(JSON.stringify(followUp));
  console.log(JSON.stringify(done));
});
`
    return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  /**
   * Orchestrate multiple agents for a task
   */
  async orchestrate(task: string, agentNames?: string[]): Promise<OrchestrateResult> {
    const agents = agentNames || ['butler']

    // Check if we're in mock mode upfront
    const isMock = this.shouldUseMock()

    const result = await this.spawnAgent('butler', `Analyze and orchestrate: ${task}`)
    if (!result.success) {
      return { success: false, mock: isMock, error: result.error }
    }

    const onOutput = (data: AgentOutput) => {
      if (data.agent === 'butler' && data.type === 'stdout') {
        const match = data.chunk.match(/SPAWN_AGENT:(\w+):(.+)/)
        if (match) {
          const [, agentName, agentTask] = match
          if (agents.includes(agentName)) {
            this.spawnAgent(agentName, agentTask)
          }
        }
      }
    }

    this.on('output', onOutput)

    // Cleanup listener after orchestration timeout
    setTimeout(() => {
      this.off('output', onOutput)
    }, this.agentTimeoutMs)

    return { success: true, mock: result.mock }
  }

  /**
   * Get agent status
   */
  getAgentStatus(name: string): AgentInstance | undefined {
    return this.agents.get(name)
  }

  /**
   * Get all active agents
   */
  getAllAgents(): AgentInstance[] {
    return Array.from(this.agents.values())
  }

  /**
   * Check if an agent has an active session
   */
  hasActiveSession(name: string): boolean {
    const session = this.sessions.get(name)
    return !!session && !session.process.killed && session.process.exitCode === null
  }

  /**
   * Kill an agent with graceful shutdown (SIGTERM -> SIGKILL)
   */
  killAgent(name: string): boolean {
    const hasSession = this.sessions.has(name)
    if (hasSession) {
      this.destroySession(name)
      return true
    }
    const agent = this.agents.get(name)
    if (agent) {
      try {
        agent.process.kill('SIGTERM')
        // Force kill after 5 seconds if still running
        setTimeout(() => {
          if (!agent.process.killed) {
            agent.process.kill('SIGKILL')
          }
        }, 5000)
      } catch (error) {
        console.error(`Failed to kill agent ${name}:`, error)
      }
      return true
    }
    return false
  }

  /**
   * Cleanup all agents
   */
  cleanup(): void {
    for (const [name] of this.sessions) {
      this.destroySession(name)
    }
    for (const [name, agent] of this.agents) {
      try {
        agent.process.kill('SIGTERM')
        this.worktreePool.release(agent.worktree).catch(console.error)
      } catch (error) {
        console.error(`Failed to cleanup agent ${name}:`, error)
      }
    }
    this.agents.clear()
    this.sessions.clear()
  }

  /**
   * Get the tool definitions (for external use / documentation)
   */
  getToolDefinitions(): AgentToolDef[] {
    return AGENT_TOOLS
  }

  /**
   * Get diagnostic information about the agent manager
   */
  getDiagnostics(): {
    claudeAvailable: boolean
    useMock: boolean
    maxAgents: number
    agentTimeoutMs: number
    activeAgents: number
    activeAgentNames: string[]
    activeSessions: number
    activeSessionNames: string[]
  } {
    return {
      claudeAvailable: this.claudeAvailable ?? false,
      useMock: this.useMock,
      maxAgents: this.maxAgents,
      agentTimeoutMs: this.agentTimeoutMs,
      activeAgents: this.agents.size,
      activeAgentNames: Array.from(this.agents.keys()),
      activeSessions: this.sessions.size,
      activeSessionNames: Array.from(this.sessions.keys())
    }
  }
}
