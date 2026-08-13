import { useCallback, useEffect, useRef, useState } from 'react'

import { useAgent } from '../../../../stores/useAgent'
import type { ReferenceSkillHintData } from '../../../../types/electron'
import {
  captureComposerAuthority,
  isComposerAuthorityCurrent,
} from '../../../../modules/agent/composer-authority'

interface UseReferenceSkillHintParams {
  activeSessionId: string | null
  currentScopeId: string | null
  composerAuthorityRevision: number
  aliasGeneration: number | null | undefined
  messageVisibilityEpoch: number | undefined
  currentScopeRunUpdatedAt: string | null
  isStreaming: boolean
}

export function useReferenceSkillHint({
  activeSessionId,
  currentScopeId,
  composerAuthorityRevision,
  aliasGeneration,
  messageVisibilityEpoch,
  currentScopeRunUpdatedAt,
  isStreaming,
}: UseReferenceSkillHintParams): ReferenceSkillHintData | null {
  const [referenceSkillHint, setReferenceSkillHint] = useState<ReferenceSkillHintData | null>(null)
  const requestRevision = useRef(0)

  const refresh = useCallback(async (scopeId?: string | null) => {
    const request = ++requestRevision.current
    if (!scopeId || !window.electronAPI?.agent?.getReferenceSkillHint) {
      setReferenceSkillHint(null)
      return
    }
    const composerAuthority = captureComposerAuthority(useAgent.getState())
    const result = await window.electronAPI.agent
      .getReferenceSkillHint(scopeId)
      .catch(() => null)
    if (
      request !== requestRevision.current
      || composerAuthority.scopeId !== scopeId
      || !isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)
    ) return
    if (!result?.success || !result.data) {
      setReferenceSkillHint(null)
      return
    }
    setReferenceSkillHint(result.data as ReferenceSkillHintData)
  }, [])

  useEffect(() => {
    requestRevision.current += 1
    setReferenceSkillHint(null)
  }, [
    activeSessionId,
    aliasGeneration,
    composerAuthorityRevision,
    currentScopeId,
    messageVisibilityEpoch,
  ])

  useEffect(() => {
    void refresh(currentScopeId)
  }, [
    activeSessionId,
    aliasGeneration,
    composerAuthorityRevision,
    currentScopeId,
    currentScopeRunUpdatedAt,
    isStreaming,
    messageVisibilityEpoch,
    refresh,
  ])

  useEffect(() => {
    if (!window.electronAPI?.agent?.onReferenceSkillHintChanged) return
    const unsubscribe = window.electronAPI.agent.onReferenceSkillHintChanged((data) => {
      if (!currentScopeId || data.scopeId !== currentScopeId) return
      void refresh(currentScopeId)
    })
    return unsubscribe
  }, [currentScopeId, refresh])

  return referenceSkillHint
}
