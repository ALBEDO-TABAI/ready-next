import { useEffect, type MutableRefObject } from 'react'
import { registerModuleAgentHandler } from '../../utils/moduleAgentBridge'
import type { Editor } from 'tldraw'
import { createDesignAgentHandler } from './design-agent-handler'

interface UseDesignAgentAdapterParams {
  editorRef: MutableRefObject<Editor | null>
  activeFileRef: MutableRefObject<string | null>
  isDirty: boolean
  saveStatus: string
  loadDesignFileIntoEditor: (path: string) => Promise<boolean>
  flushSave: (path?: string) => Promise<boolean>
  exportCurrentDesign: (payload: { format: 'png' | 'svg'; path?: string; defaultName?: string }) => Promise<string>
  markDirty: () => void
  markSaved: () => void
  selectWorkspaceFile: (path: string | null) => void
  setActiveFile: (file: string | null) => void
}

export function useDesignAgentAdapter(params: UseDesignAgentAdapterParams): void {
  const {
    editorRef,
    activeFileRef,
    isDirty,
    saveStatus,
    loadDesignFileIntoEditor,
    flushSave,
    exportCurrentDesign,
    markDirty,
    markSaved,
    selectWorkspaceFile,
    setActiveFile,
  } = params

  useEffect(() => {
    return registerModuleAgentHandler('design', createDesignAgentHandler({
      editorRef,
      activeFileRef,
      isDirty,
      saveStatus,
      loadDesignFileIntoEditor,
      flushSave,
      exportCurrentDesign,
      markDirty,
      markSaved,
      selectWorkspaceFile,
      setActiveFile,
    }))
  }, [
    activeFileRef,
    editorRef,
    exportCurrentDesign,
    flushSave,
    isDirty,
    loadDesignFileIntoEditor,
    markDirty,
    markSaved,
    saveStatus,
    selectWorkspaceFile,
    setActiveFile,
  ])
}
