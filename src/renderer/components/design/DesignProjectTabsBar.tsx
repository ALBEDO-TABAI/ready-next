import type { DragEvent } from 'react'
import WorkbenchProjectTabs from '../workbench/WorkbenchProjectTabs'
import type { DesignLayoutBounds, DesignLayoutDigest, DesignRepairScope } from '../../../shared/design-agent'

interface DesignProjectTabsBarProps {
  projectTabs: string[]
  activeDesignPath: string | null
  isDirty: boolean
  saveStatus: string
  snapshotHash: string | null
  selectionSummary: string | null
  selectedElementCount: number
  selectionBounds: DesignLayoutBounds | null
  layoutDigest: DesignLayoutDigest | null
  currentToolContext: string | null
  latestReviewSummary: string | null
  repairScope: DesignRepairScope
  getPathBasename: (path: string) => string
  onSelectProjectTab: (path: string) => void
  onCloseProjectTab: (path: string) => void
  onProjectTabDragStart: (e: DragEvent, path: string) => void
  onCreateNewDraft: () => void | Promise<void>
}

export default function DesignProjectTabsBar({
  projectTabs,
  activeDesignPath,
  isDirty,
  saveStatus,
  snapshotHash,
  selectionSummary,
  selectedElementCount,
  selectionBounds,
  layoutDigest,
  currentToolContext,
  latestReviewSummary,
  repairScope,
  getPathBasename,
  onSelectProjectTab,
  onCloseProjectTab,
  onProjectTabDragStart,
  onCreateNewDraft,
}: DesignProjectTabsBarProps) {
  const tabs = projectTabs.length > 0
    ? projectTabs.map((path) => ({
        id: path,
        label: getPathBasename(path),
        title: path,
        dotColor: activeDesignPath === path ? 'var(--color-purple)' : undefined,
        active: activeDesignPath === path,
        dirty: activeDesignPath === path && isDirty,
      }))
    : [{
        id: '__design-draft__',
        label: '设计草稿',
        title: '设计草稿',
        dotColor: isDirty ? 'var(--color-purple)' : undefined,
        active: true,
        dirty: isDirty,
      }]

  return (
    <WorkbenchProjectTabs
      layoutId="design-tabs"
      tabs={tabs}
      onTabClick={(id) => {
        if (id === '__design-draft__') return
        onSelectProjectTab(id)
      }}
      onTabClose={projectTabs.length > 0 ? (id) => onCloseProjectTab(id) : undefined}
      onNewTab={onCreateNewDraft}
      onTabDragStart={(event, id) => {
        if (id === '__design-draft__') {
          const payload = JSON.stringify({
            type: 'design-project' as const,
            name: '设计草稿',
            dirty: isDirty,
            saveStatus,
            snapshotHash,
            selectionSummary,
            selectedElementCount,
            selectionBounds,
            layoutDigest,
            currentToolContext,
            latestReviewSummary,
            repairScope,
            draggedAt: Date.now(),
          })
          event.dataTransfer.setData('application/x-ready-drag', payload)
          event.dataTransfer.effectAllowed = 'copy'
          return
        }
        onProjectTabDragStart(event as DragEvent, id)
      }}
    />
  )
}
