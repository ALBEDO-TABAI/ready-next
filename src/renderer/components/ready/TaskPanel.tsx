import { useMemo } from 'react'
import { Plus, Send } from 'lucide-react'
import { useAgent, type ScopeRunState, type ToolTraceEvent } from '../../stores/useAgent'
import AgentSelector from './AgentSelector'
import AgentTagRow from './AgentTagRow'

interface Task {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed'
}

function extractTasksFromMessages(messages: { id: string; content: string; type: string }[]): Task[] {
  const tasks: Task[] = []
  let taskIndex = 0

  for (const msg of messages) {
    if (msg.type !== 'agent') continue
    const lines = msg.content.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      const checkboxMatch = trimmed.match(/^[-*]\s*\[([ xX])\]\s+(.+)/)
      if (checkboxMatch) {
        tasks.push({
          id: `task-${msg.id}-${taskIndex++}`,
          title: checkboxMatch[2].trim(),
          status: checkboxMatch[1].toLowerCase() === 'x' ? 'completed' : 'pending',
        })
        continue
      }
      const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)/)
      if (numberedMatch && numberedMatch[1].length > 2 && numberedMatch[1].length < 60) {
        tasks.push({
          id: `task-${msg.id}-${taskIndex++}`,
          title: numberedMatch[1].trim(),
          status: 'pending',
        })
      }
    }
  }

  return tasks
}

function phaseLabel(phase: ScopeRunState['phase'] | undefined): string {
  switch (phase) {
    case 'queued':
      return '排队中'
    case 'planning':
      return '规划'
    case 'tool_running':
      return '执行工具'
    case 'checkpoint':
      return '检查点'
    case 'takeover':
      return '人工接管'
    case 'resuming':
      return '恢复中'
    case 'responding':
      return '生成回复'
    case 'done':
      return '完成'
    case 'error':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return '待命'
  }
}

function phaseTone(phase: ScopeRunState['phase'] | undefined): { bg: string; color: string } {
  switch (phase) {
    case 'done':
      return { bg: 'var(--color-green-light)', color: 'var(--color-green)' }
    case 'error':
    case 'cancelled':
      return { bg: 'rgba(224, 69, 72, 0.12)', color: 'var(--color-red)' }
    case 'takeover':
    case 'checkpoint':
      return { bg: 'var(--color-orange-light)', color: 'var(--color-orange)' }
    default:
      return { bg: 'var(--color-blue-light)', color: 'var(--color-blue)' }
  }
}

function summarizeTraceItem(item: ToolTraceEvent): string {
  return item.text.replace(/\s+/g, ' ').trim().slice(0, 180)
}

export default function TaskPanel() {
  const {
    inputValue,
    isStreaming,
    messages,
    currentScopeId,
    scopeRunStates,
    setInputValue,
    sendMessage,
  } = useAgent()

  const activeRun = currentScopeId ? scopeRunStates[currentScopeId] || null : null
  const fallbackTasks = useMemo(() => {
    const extracted = extractTasksFromMessages(messages)
    if (extracted.length > 0) return extracted
    return [
      { id: 'default-1', title: '等待结构化任务运行数据', status: 'running' as const },
      { id: 'default-2', title: '接收新的用户指令', status: 'pending' as const },
    ]
  }, [messages])

  const timelineItems = useMemo(() => {
    if (!activeRun) return []
    return activeRun.toolTrace.slice(-14).map((item) => ({
      ...item,
      summary: summarizeTraceItem(item),
    }))
  }, [activeRun])

  const handleSend = async () => {
    if (!inputValue.trim() || isStreaming) return
    await sendMessage(inputValue)
    setInputValue('')
  }

  const phaseColors = phaseTone(activeRun?.phase)

  return (
    <div
      className="flex-shrink-0 flex flex-col"
      style={{
        width: 240,
        background: 'var(--bg-panel)',
        borderRight: '1px solid var(--border-default)',
      }}
    >
      <div
        className="flex items-center justify-between"
        style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-default)' }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>Agent</span>
      </div>

      <div style={{ padding: '8px 6px', borderBottom: '1px solid var(--border-default)' }}>
        <AgentSelector />
      </div>

      <div
        className="flex items-center justify-between"
        style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-default)' }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>
          {activeRun ? '运行时间线' : '任务'}
        </span>
        <button
          className="flex items-center justify-center rounded-lg hover:bg-black/5 transition-colors"
          style={{ width: 24, height: 24 }}
        >
          <Plus style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
        </button>
      </div>

      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-default)' }}>
        {activeRun ? (
          <div className="flex flex-col" style={{ gap: 8 }}>
            <div className="flex items-center justify-between">
              <span
                className="rounded-full px-2 py-1 text-[10px] font-semibold"
                style={{ background: phaseColors.bg, color: phaseColors.color }}
              >
                {phaseLabel(activeRun.phase)}
              </span>
              <span className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                工具 {activeRun.stepMetrics?.toolCalls || 0}/{activeRun.stepMetrics?.toolResults || 0}
              </span>
            </div>
            {activeRun.blockedReason && (
              <div
                className="rounded-[10px] border px-2.5 py-2"
                style={{
                  borderColor: 'var(--color-orange)',
                  background: 'var(--color-orange-light)',
                }}
              >
                <div className="text-[10px] font-semibold" style={{ color: 'var(--color-orange)' }}>
                  当前阻塞
                </div>
                <div className="mt-1 text-[11px]" style={{ color: 'var(--text-body)', lineHeight: 1.5 }}>
                  {activeRun.blockedReason}
                </div>
              </div>
            )}
            {activeRun.latestText && !activeRun.blockedReason && (
              <div className="text-[11px]" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {activeRun.latestText.slice(0, 120)}
              </div>
            )}
          </div>
        ) : (
          <span style={{ fontSize: 11, color: '#8A8A8A' }}>{fallbackTasks.length} 个任务</span>
        )}
      </div>

      <div className="flex-1 overflow-auto" style={{ padding: 8 }}>
        {activeRun ? (
          timelineItems.length === 0 ? (
            <div className="rounded-[12px] border px-3 py-3" style={{ borderColor: 'var(--border-default)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-light)' }}>
                当前还没有工具轨迹，等待运行事件。
              </div>
            </div>
          ) : (
            <div className="flex flex-col" style={{ gap: 8 }}>
              {timelineItems.map((item) => (
                <div
                  key={item.id}
                  className="rounded-[12px] border px-3 py-2.5"
                  style={{
                    borderColor: item.kind === 'call' ? 'rgba(57, 128, 255, 0.18)' : 'var(--border-default)',
                    background: item.kind === 'call' ? 'rgba(57, 128, 255, 0.06)' : 'var(--surface-card-bg)',
                  }}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                      style={{
                        background: item.kind === 'call' ? 'var(--color-blue-light)' : 'rgba(16, 185, 129, 0.12)',
                        color: item.kind === 'call' ? 'var(--color-blue)' : 'var(--color-green)',
                      }}
                    >
                      {item.kind === 'call' ? 'Tool' : 'Result'}
                    </span>
                    <span className="text-[9px]" style={{ color: 'var(--text-light)' }}>
                      {item.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--text-body)', lineHeight: 1.5 }}>
                    {item.summary}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="flex flex-col" style={{ gap: 6 }}>
            {fallbackTasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center rounded-lg transition-colors hover:bg-black/5"
                style={{ padding: '8px 10px', gap: 8 }}
              >
                <span
                  className={`
                    w-2 h-2 rounded-full flex-shrink-0
                    ${task.status === 'completed' ? 'bg-[var(--color-green)]' : ''}
                    ${task.status === 'running' ? 'bg-[var(--color-blue)] animate-pulse' : ''}
                    ${task.status === 'pending' ? 'bg-[var(--text-light)]' : ''}
                  `}
                />
                <span
                  className={task.status === 'completed' ? 'line-through' : ''}
                  style={{
                    fontSize: 12,
                    color: task.status === 'completed' ? '#8A8A8A' : 'var(--text-body)',
                  }}
                >
                  {task.title}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          padding: '10px 10px',
          borderTop: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <AgentTagRow />

        <div className="flex items-center" style={{ gap: 6 }}>
          <div
            className="flex-1 flex items-center"
            style={{
              borderRadius: 10,
              border: '1px solid var(--border-input)',
              padding: '6px 10px',
              background: 'var(--bg-primary)',
            }}
          >
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="给 Agent 发指令..."
              className="flex-1 bg-transparent border-none outline-none"
              style={{ fontSize: 11, color: 'var(--text-body)' }}
            />
          </div>
          <button
            onClick={handleSend}
            disabled={!inputValue.trim() || isStreaming}
            className="flex items-center justify-center text-white hover:brightness-95 disabled:opacity-40 transition-all"
            style={{ width: 26, height: 26, borderRadius: 13, background: 'var(--color-green)', flexShrink: 0 }}
          >
            <Send style={{ width: 11, height: 11 }} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  )
}
