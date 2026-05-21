import { AgentTaskState } from './contracts/types'

export interface AgentTaskSnapshot {
  agent: string
  state: AgentTaskState
  updatedAt: string
  error?: string
}

export class AgentSessionManager {
  private readonly tasks = new Map<string, AgentTaskSnapshot>()

  setState(agent: string, state: AgentTaskState, error?: string): AgentTaskSnapshot {
    const next: AgentTaskSnapshot = {
      agent,
      state,
      updatedAt: new Date().toISOString(),
      error,
    }
    this.tasks.set(agent, next)
    return next
  }

  getState(agent: string): AgentTaskSnapshot | null {
    return this.tasks.get(agent) || null
  }

  getActiveCount(): number {
    let count = 0
    for (const task of this.tasks.values()) {
      if (task.state === 'queued' || task.state === 'planning' || task.state === 'tool_running' || task.state === 'responding') {
        count += 1
      }
    }
    return count
  }

  listStates(): AgentTaskSnapshot[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}
