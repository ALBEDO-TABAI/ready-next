import { useEffect } from 'react'
import type { AgentScheduleOccurrence } from '../../../../shared/scheduled-tasks'
import { beginPersistentBrowserMask, endPersistentBrowserMask } from '../../../modules/overlay/browserViewMask'
import type { ScheduledTaskAgentOption } from './ScheduledTaskEditor'
import { ScheduledTasksPanel, type ScheduledTasksSummary } from './ScheduledTasksPanel'

interface ScheduledTasksWorkspaceProps {
  open: boolean
  onClose: () => void
  currentScopeId: string | null
  currentAgentId: string
  workspaceRoots: string[]
  agentOptions: ScheduledTaskAgentOption[]
  onSummaryChange: (summary: ScheduledTasksSummary) => void
  onOpenOccurrence: (occurrence: AgentScheduleOccurrence) => void
}

export function ScheduledTasksWorkspace(props: ScheduledTasksWorkspaceProps) {
  useEffect(() => {
    if (!props.open) return
    beginPersistentBrowserMask()
    return () => { void endPersistentBrowserMask() }
  }, [props.open])

  if (!props.open) return null

  return (
    <div className="scheduled-tasks-workspace" data-scheduled-tasks-workspace="true">
      <ScheduledTasksPanel {...props} presentation="workspace" />
    </div>
  )
}
