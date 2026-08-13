import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useAgent, type ConversationScope } from '../../../../stores/useAgent'
import type { Agent } from '../../../../modules/agent/types'
import type { SessionRecallCapsule, SessionRecallHit } from '../../../../../shared/session-recall'
import { mapScopeToConversation } from '../helpers/projection'
import {
  captureComposerAuthority,
  isComposerAuthorityCurrent,
} from '../../../../modules/agent/composer-authority'

const SESSION_RECALL_HISTORY_LIMIT = 60

// Map a live conversation scope onto the SessionRecallHit shape the history
// list renders. Lets a live session (e.g. a freshly created remote `/new`)
// appear in the per-channel list immediately, without waiting for the recall
// search index. `sessionStatus: null` keeps the row dot unlit unless the live
// status map lights it; the dedicated search path still supplies real hits.
function scopeToSessionRow(scope: ConversationScope): SessionRecallHit {
  return {
    conversationId: scope.id,
    lineageRootId: scope.lineageRootId || scope.id,
    resumeTitle: scope.resumeTitle || scope.title,
    title: scope.title,
    sourceKind: scope.sourceKind,
    sourceId: scope.sourceId,
    threadKey: scope.threadKey,
    agentId: scope.agent,
    activeAgentId: scope.activeAgentId,
    matchedBy: ['recent'],
    score: 0,
    attachmentNames: [],
    updatedAt: scope.lastMessageAt || scope.updatedAt,
    sessionStatus: null,
  }
}

// Stage V V1.9a — channel + session-recall state, derivations, effects and
// callbacks extracted from ChatPanel.tsx (original L396-664 + L1011-1018
// region after V1.7-V1.9c extractions). All store/IPC deps are injected via
// params; behavior preserved byte-for-byte. The hook owns its own React
// state (no leakage back to ChatPanel) and exposes 8 explicit return
// surfaces per plan v6/v7.

export interface ConversationChannelOption {
  key: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  label: string
  caption: string
}

export interface UseChannelSessionRecallParams {
  agents: Agent[]
  currentAgent: string
  scopes: ConversationScope[]
  currentScope: ConversationScope | null
  currentScopeId: string | null
  composerAuthorityRevision: number
}

export interface RecallStateHandle {
  capsules: SessionRecallCapsule[]
  conversationIds: string[]
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  results: SessionRecallHit[]
  searching: boolean
  error: string | null
  setResults: Dispatch<SetStateAction<SessionRecallHit[]>>
  runSearch: (query: string) => Promise<void>
  attach: (conversationId: string) => Promise<void>
  detach: (conversationId: string) => Promise<void>
}

export interface ChannelEffectsHandle {
  setSelectedChannelKey: Dispatch<SetStateAction<string>>
  getScopeChannelKey: (scope: ConversationScope) => string
  refreshAttachedSessionRecall: (scopeId?: string | null) => Promise<void>
}

export interface UseChannelSessionRecallReturn {
  selectedChannelKey: string
  filteredScopes: ConversationScope[]
  currentAgentData: Agent | undefined
  currentChannel: ConversationChannelOption
  channelOptions: ConversationChannelOption[]
  sessionsByChannelKey: Record<string, SessionRecallHit[]>
  recallState: RecallStateHandle
  detachCallback: (conversationId: string) => Promise<void>
  channelEffects: ChannelEffectsHandle
}

export function useChannelSessionRecall(
  params: UseChannelSessionRecallParams,
): UseChannelSessionRecallReturn {
  const {
    agents,
    currentAgent,
    scopes,
    currentScope,
    currentScopeId,
    composerAuthorityRevision,
  } = params

  const [selectedChannelKey, setSelectedChannelKey] = useState('local:app')
  const [sessionRecallQuery, setSessionRecallQuery] = useState('')
  const [sessionRecallResults, setSessionRecallResults] = useState<SessionRecallHit[]>([])
  const [attachedSessionRecallCapsules, setAttachedSessionRecallCapsules] = useState<
    SessionRecallCapsule[]
  >([])
  const [sessionRecallSearching, setSessionRecallSearching] = useState(false)
  const [sessionRecallError, setSessionRecallError] = useState<string | null>(null)
  const attachedRecallRequestRevision = useRef(0)
  const recallSearchRequestRevision = useRef(0)

  const currentAgentData = agents.find((a) => a.name === currentAgent)

  const getScopeChannelKey = useCallback((scope: ConversationScope) => {
    const sourceId = scope.sourceKind === 'local' ? 'app' : scope.sourceId
    return `${scope.sourceKind}:${sourceId}`
  }, [])

  const channelOptions = useMemo<ConversationChannelOption[]>(() => {
    const options = new Map<string, ConversationChannelOption>()
    options.set('local:app', {
      key: 'local:app',
      sourceKind: 'local',
      sourceId: 'app',
      label: '应用内',
      caption: '本地会话'
    })

    for (const scope of scopes) {
      const key = getScopeChannelKey(scope)
      if (options.has(key)) continue

      const channelType = String(scope.meta?.channelType || '')
      const sourceLabel = String(scope.meta?.sourceLabel || '')
      let label = sourceLabel || '远程会话'
      let caption = sourceLabel || '频道会话'

      if (
        channelType === 'feishu-app' ||
        channelType === 'feishu-bot' ||
        /飞书/.test(sourceLabel)
      ) {
        label = '飞书会话'
        caption = sourceLabel || '飞书频道'
      } else if (channelType === 'telegram-bot' || /telegram/i.test(sourceLabel)) {
        label = 'Telegram'
        caption = sourceLabel || 'Telegram 频道'
      } else if (channelType === 'wechat-openclaw' || /微信|wechat|weixin/i.test(sourceLabel)) {
        label = '微信会话'
        caption = sourceLabel || '微信频道'
      }

      options.set(key, {
        key,
        sourceKind: scope.sourceKind,
        sourceId: scope.sourceId,
        label,
        caption
      })
    }

    return Array.from(options.values())
  }, [getScopeChannelKey, scopes])

  // Live sessions grouped by the same key channelOptions dedupes on. The
  // history menu expands a channel into these so every distinct session under
  // one source (each remote `/new` is its own scope) is selectable, newest
  // first — the channel row alone only ever shows one entry per source.
  const sessionsByChannelKey = useMemo<Record<string, SessionRecallHit[]>>(() => {
    const grouped: Record<string, SessionRecallHit[]> = {}
    for (const scope of scopes) {
      const key = getScopeChannelKey(scope)
      ;(grouped[key] ||= []).push(scopeToSessionRow(scope))
    }
    for (const key of Object.keys(grouped)) {
      grouped[key].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
    }
    return grouped
  }, [getScopeChannelKey, scopes])

  const currentChannel = useMemo<ConversationChannelOption>(() => {
    return (
      channelOptions.find((option) => option.key === selectedChannelKey) ||
      channelOptions[0] || {
        key: 'local:app',
        sourceKind: 'local',
        sourceId: 'app',
        label: '应用内',
        caption: '本地会话'
      }
    )
  }, [channelOptions, selectedChannelKey])

  const filteredScopes = useMemo(() => {
    return scopes
      .filter((scope) => getScopeChannelKey(scope) === selectedChannelKey)
      .sort((a, b) => {
        const aTime = new Date(a.lastMessageAt || a.updatedAt).getTime()
        const bTime = new Date(b.lastMessageAt || b.updatedAt).getTime()
        return bTime - aTime
      })
  }, [getScopeChannelKey, scopes, selectedChannelKey])

  const attachedSessionRecallConversationIds = useMemo(
    () => attachedSessionRecallCapsules.map((capsule) => capsule.conversationId),
    [attachedSessionRecallCapsules]
  )

  const refreshAttachedSessionRecall = useCallback(async (scopeId?: string | null) => {
    const requestRevision = ++attachedRecallRequestRevision.current
    if (!scopeId || !window.electronAPI?.agent?.listAttachedSessionRecallContexts) {
      setAttachedSessionRecallCapsules([])
      return
    }
    const composerAuthority = captureComposerAuthority(useAgent.getState())
    const result = await window.electronAPI.agent
      .listAttachedSessionRecallContexts(scopeId)
      .catch(() => null)
    if (
      requestRevision !== attachedRecallRequestRevision.current
      || composerAuthority.scopeId !== scopeId
      || !isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)
    ) return
    if (!result?.success || !Array.isArray(result.data)) {
      setAttachedSessionRecallCapsules([])
      return
    }
    setAttachedSessionRecallCapsules(result.data as SessionRecallCapsule[])
  }, [])

  const runSessionRecallSearch = useCallback(
    async (query: string) => {
      if (!window.electronAPI?.agent?.searchSessionRecall) return
      const normalized = query.trim()
      const requestRevision = ++recallSearchRequestRevision.current
      const composerAuthority = captureComposerAuthority(useAgent.getState())
      setSessionRecallSearching(true)
      setSessionRecallError(null)
      try {
        const result = await window.electronAPI.agent
          .searchSessionRecall({
            query: normalized || undefined,
            currentScopeId: currentScopeId || undefined,
            limit: SESSION_RECALL_HISTORY_LIMIT
          })
          .catch(() => null)
        if (
          requestRevision !== recallSearchRequestRevision.current
          || !isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)
        ) return
        if (!result?.success || !Array.isArray(result.data)) {
          setSessionRecallResults([])
          setSessionRecallError(result?.error || '旧会话搜索失败')
          return
        }
        setSessionRecallResults(result.data as SessionRecallHit[])
      } finally {
        if (
          requestRevision === recallSearchRequestRevision.current
          && isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)
        ) setSessionRecallSearching(false)
      }
    },
    [currentScopeId]
  )

  const handleAttachSessionRecall = useCallback(
    async (conversationId: string) => {
      if (!currentScopeId || !window.electronAPI?.agent?.attachSessionRecallContext) return
      const composerAuthority = captureComposerAuthority(useAgent.getState())
      setSessionRecallError(null)
      const result = await window.electronAPI.agent
        .attachSessionRecallContext(
          currentScopeId,
          conversationId,
          composerAuthority.messageVisibilityEpoch,
        )
        .catch(() => null)
      if (!isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)) return
      if (!result?.success || !result.data) {
        setSessionRecallError(result?.error || '引用旧会话失败')
        return
      }
      const payload = result.data as { scope: ConversationScope; capsule: SessionRecallCapsule }
      useAgent.setState((state) => {
        if (!isComposerAuthorityCurrent(state, composerAuthority)) return state
        const nextScopes = state.scopes.map((scope) =>
          scope.id === payload.scope.id ? payload.scope : scope
        )
        return {
          scopes: nextScopes,
          currentScope:
            state.currentScope?.id === payload.scope.id ? payload.scope : state.currentScope,
          conversations: nextScopes.map(mapScopeToConversation)
        }
      })
      setAttachedSessionRecallCapsules((current) => {
        if (!isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)) return current
        const filtered = current.filter(
          (item) => item.conversationId !== payload.capsule.conversationId
        )
        return [...filtered, payload.capsule]
      })
    },
    [currentScopeId]
  )

  const handleDetachSessionRecall = useCallback(
    async (conversationId: string) => {
      if (!currentScopeId || !window.electronAPI?.agent?.detachSessionRecallContext) return
      const composerAuthority = captureComposerAuthority(useAgent.getState())
      setSessionRecallError(null)
      const result = await window.electronAPI.agent
        .detachSessionRecallContext(
          currentScopeId,
          conversationId,
          composerAuthority.messageVisibilityEpoch,
        )
        .catch(() => null)
      if (!isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)) return
      if (!result?.success || !result.data) {
        setSessionRecallError(result?.error || '移除旧会话引用失败')
        return
      }
      const payload = result.data as { scope: ConversationScope }
      useAgent.setState((state) => {
        if (!isComposerAuthorityCurrent(state, composerAuthority)) return state
        const nextScopes = state.scopes.map((scope) =>
          scope.id === payload.scope.id ? payload.scope : scope
        )
        return {
          scopes: nextScopes,
          currentScope:
            state.currentScope?.id === payload.scope.id ? payload.scope : state.currentScope,
          conversations: nextScopes.map(mapScopeToConversation)
        }
      })
      setAttachedSessionRecallCapsules((current) => (
        isComposerAuthorityCurrent(useAgent.getState(), composerAuthority)
          ? current.filter((item) => item.conversationId !== conversationId)
          : current
      ))
    },
    [currentScopeId]
  )

  // Sync selected channel to the current scope's channel when scope changes.
  useEffect(() => {
    if (!currentScope) return
    setSelectedChannelKey(getScopeChannelKey(currentScope))
  }, [currentScope, getScopeChannelKey])

  // Refresh attached session-recall capsules whenever the active scope flips.
  useEffect(() => {
    void refreshAttachedSessionRecall(currentScopeId)
  }, [
    composerAuthorityRevision,
    currentScope?.aliasGeneration,
    currentScope?.messageVisibilityEpoch,
    currentScopeId,
    refreshAttachedSessionRecall,
  ])

  useEffect(() => {
    recallSearchRequestRevision.current += 1
    setSessionRecallResults([])
    setSessionRecallSearching(false)
    setSessionRecallError(null)
  }, [
    composerAuthorityRevision,
    currentScope?.aliasGeneration,
    currentScope?.messageVisibilityEpoch,
    currentScopeId,
  ])

  const recallState: RecallStateHandle = {
    capsules: attachedSessionRecallCapsules,
    conversationIds: attachedSessionRecallConversationIds,
    query: sessionRecallQuery,
    setQuery: setSessionRecallQuery,
    results: sessionRecallResults,
    searching: sessionRecallSearching,
    error: sessionRecallError,
    setResults: setSessionRecallResults,
    runSearch: runSessionRecallSearch,
    attach: handleAttachSessionRecall,
    detach: handleDetachSessionRecall,
  }

  const channelEffects: ChannelEffectsHandle = {
    setSelectedChannelKey,
    getScopeChannelKey,
    refreshAttachedSessionRecall,
  }

  return {
    selectedChannelKey,
    filteredScopes,
    currentAgentData,
    currentChannel,
    channelOptions,
    sessionsByChannelKey,
    recallState,
    detachCallback: handleDetachSessionRecall,
    channelEffects,
  }
}
