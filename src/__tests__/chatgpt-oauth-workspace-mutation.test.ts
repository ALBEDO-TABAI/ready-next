import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDefaultAIWorkspace,
  type AIProviderWorkspace,
} from '../shared/ai-providers'
import {
  CHATGPT_OAUTH_PROFILE_ID,
  removeChatGptOAuthProfile,
  upsertChatGptOAuthProfile,
} from '../shared/chatgpt-oauth'
import {
  ChatGptOAuthService,
  type ChatGptOAuthServiceDeps,
} from '../main/modules/settings-engine/chatgpt-oauth-service'
import {
  disconnectChatGptOAuthWithWorkspaceLifecycle,
  persistAIWorkspaceWithChatGptOAuthLifecycle,
} from '../main/modules/settings-engine/chatgpt-oauth-workspace-mutation'
import { createCodexProviderReadinessPort } from '../main/modules/agent-control/codex-runtime/codex-provider-readiness'
import { classifyCodexIngressPreparationError } from '../main/modules/agent-control/codex-runtime/codex-ingress-preparation-error'
import { runConfirmedSendScoped } from '../main/modules/agent-control/send-scoped-confirmation'

const PROXY_API_KEY = 'ready-oauth-proxy-key-12345678901234567890'
const ROTATED_PROXY_API_KEY = 'ready-oauth-proxy-key-rotated-12345678901234567890'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function oauthWorkspace(): AIProviderWorkspace {
  return upsertChatGptOAuthProfile(
    createDefaultAIWorkspace(),
    ['gpt-5.6-sol', 'gpt-5.6-terra'],
    PROXY_API_KEY,
  )
}

function createHarness() {
  let credential = true
  let workspace = oauthWorkspace()
  let serverStarts = 0
  let closeAttempts = 0
  let blockClose = false
  let blockRemove = false
  let failLogin = false
  let closeError: Error | null = null
  let removeError: Error | null = null
  let removeCredentialBeforeError = false
  let workspaceWriteError: Error | null = null
  const closeStarted = deferred()
  const closeAllowed = deferred()
  const removeStarted = deferred()
  const removeAllowed = deferred()
  const loginStarted = deferred()
  const loginAllowed = deferred()
  const deps: ChatGptOAuthServiceDeps = {
    credentialExists: () => credential,
    login: async () => {
      loginStarted.resolve()
      await loginAllowed.promise
      if (failLogin) throw new Error('browser_login_failed')
      credential = true
    },
    startServer: async (models) => {
      serverStarts += 1
      return {
        models: models || ['gpt-5.6-sol'],
        close: async () => {
          closeAttempts += 1
          closeStarted.resolve()
          if (blockClose) await closeAllowed.promise
          if (closeError) {
            const error = closeError
            closeError = null
            throw error
          }
        },
      }
    },
    removeCredential: async () => {
      removeStarted.resolve()
      if (blockRemove) await removeAllowed.promise
      if (removeError) {
        const error = removeError
        removeError = null
        if (removeCredentialBeforeError) credential = false
        throw error
      }
      credential = false
    },
  }
  const service = new ChatGptOAuthService(deps)
  const repository = {
    getAIWorkspace: () => structuredClone(workspace),
    setAIWorkspace: (next: AIProviderWorkspace) => {
      if (workspaceWriteError) {
        const error = workspaceWriteError
        workspaceWriteError = null
        throw error
      }
      workspace = structuredClone(next)
    },
  }
  const persist = (requestedWorkspace: AIProviderWorkspace) => (
    persistAIWorkspaceWithChatGptOAuthLifecycle({
      requestedWorkspace,
      repository,
      profileMutationGuard: { assertWorkspaceMutationAllowed: () => undefined },
      chatGptOAuth: service,
    })
  )
  const disconnect = () => disconnectChatGptOAuthWithWorkspaceLifecycle({
    repository,
    profileMutationGuard: { assertProfileMutationAllowed: () => undefined },
    chatGptOAuth: service,
  })
  return {
    service,
    repository,
    persist,
    disconnect,
    readWorkspace: () => structuredClone(workspace),
    hasCredential: () => credential,
    serverCounts: () => ({ serverStarts, closeAttempts }),
    blockClose: () => { blockClose = true },
    allowClose: () => closeAllowed.resolve(),
    closeStarted: closeStarted.promise,
    blockRemove: () => { blockRemove = true },
    allowRemove: () => removeAllowed.resolve(),
    removeStarted: removeStarted.promise,
    failNextLogin: () => { failLogin = true },
    failNextClose: () => { closeError = new Error('server_close_failed') },
    failNextCredentialRemoval: () => { removeError = new Error('credential_remove_failed') },
    failNextCredentialRemovalAfterDelete: () => {
      removeCredentialBeforeError = true
      removeError = new Error('credential_remove_failed_after_delete')
    },
    failNextWorkspaceWrite: () => { workspaceWriteError = new Error('workspace_commit_failed') },
    allowLogin: () => loginAllowed.resolve(),
    loginStarted: loginStarted.promise,
  }
}

test('ordinary profile switching preserves OAuth while fresh model and reasoning edits still save', async () => {
  const harness = createHarness()
  await harness.service.ensureReady(['gpt-5.6-sol', 'gpt-5.6-terra'], PROXY_API_KEY)
  const original = harness.readWorkspace()
  const switched = {
    ...original,
    activeProfileId: 'builtin-openai',
  }
  await harness.persist(switched)
  assert.deepEqual(
    harness.readWorkspace().profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID),
    original.profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID),
  )

  const current = harness.readWorkspace()
  const edited = {
    ...current,
    activeProfileId: CHATGPT_OAUTH_PROFILE_ID,
    profiles: current.profiles.map((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID
      ? {
          ...profile,
          name: 'ChatGPT OAuth 个人预设',
          config: {
            ...profile.config,
            model: 'gpt-5.6-terra',
            reasoningEffort: 'xhigh' as const,
            displayName: 'ChatGPT OAuth 个人预设',
          },
        }
      : profile),
  }
  await harness.persist(edited)
  const saved = harness.readWorkspace().profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID)
  assert.equal(saved?.config.model, 'gpt-5.6-terra')
  assert.equal(saved?.config.reasoningEffort, 'xhigh')
  assert.equal(saved?.config.displayName, 'ChatGPT OAuth 个人预设')
})

test('ordinary workspace persistence rejects a different proxy key while the OAuth service is running', async () => {
  const harness = createHarness()
  await harness.service.ensureReady(['gpt-5.6-sol', 'gpt-5.6-terra'], PROXY_API_KEY)
  const original = harness.readWorkspace()
  const requested = {
    ...original,
    profiles: original.profiles.map((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID
      ? {
          ...profile,
          config: {
            ...profile.config,
            apiKey: ROTATED_PROXY_API_KEY,
          },
        }
      : profile),
  }

  await assert.rejects(
    harness.persist(requested),
    /chatgpt_oauth_proxy_key_requires_reconnect/,
  )

  assert.deepEqual(harness.readWorkspace(), original)
  assert.equal(harness.service.getStatus().running, true)
  assert.equal(harness.service.getProxyApiKey(), PROXY_API_KEY)
  assert.equal(harness.hasCredential(), true)
})

test('explicit OAuth reconnect can rotate the proxy key and commit the matching profile', async () => {
  const harness = createHarness()
  await harness.service.ensureReady(['gpt-5.6-sol'], PROXY_API_KEY)
  const reconnecting = harness.service.connect(undefined, {
    beforeRestart: () => {
      harness.repository.setAIWorkspace(removeChatGptOAuthProfile(harness.repository.getAIWorkspace()))
      return {
        existingProxyApiKey: ROTATED_PROXY_API_KEY,
      }
    },
    afterReady: (status) => {
      harness.repository.setAIWorkspace(upsertChatGptOAuthProfile(
        harness.repository.getAIWorkspace(),
        status.models,
        harness.service.getProxyApiKey(),
      ))
    },
  })
  await harness.loginStarted
  harness.allowLogin()
  await reconnecting

  const saved = harness.readWorkspace().profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID)
  assert.equal(harness.service.getStatus().running, true)
  assert.equal(harness.service.getProxyApiKey(), ROTATED_PROXY_API_KEY)
  assert.equal(saved?.config.apiKey, ROTATED_PROXY_API_KEY)
  assert.equal(harness.hasCredential(), true)
})

test('a server-close failure restores the OAuth workspace and exposes a recoverable error state', async () => {
  const harness = createHarness()
  await harness.service.ensureReady(['gpt-5.6-sol'], PROXY_API_KEY)
  const original = harness.readWorkspace()
  const stale = { ...original, activeProfileId: 'builtin-openai' }
  const ordinary = removeChatGptOAuthProfile(stale)
  harness.blockClose()
  harness.failNextClose()
  const disconnecting = harness.disconnect()
  await harness.closeStarted
  const saving = harness.persist(stale)
  const ordinarySaving = harness.persist(ordinary)
  let saveSettled = false
  void saving.finally(() => { saveSettled = true }).catch(() => undefined)
  await Promise.resolve()
  assert.equal(saveSettled, false)
  harness.allowClose()

  await assert.rejects(disconnecting, /server_close_failed/)
  await assert.rejects(saving, /chatgpt_oauth_profile_requires_connect/)
  await ordinarySaving

  assert.equal(harness.readWorkspace().activeProfileId, 'builtin-openai')
  assert.deepEqual(
    harness.readWorkspace().profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID),
    original.profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID),
  )
  assert.equal(harness.service.getStatus().state, 'error')
  assert.equal(harness.service.getStatus().connected, true)
  assert.equal(harness.service.getStatus().running, false)
  assert.equal(harness.hasCredential(), true)
  const oauthProfile = harness.readWorkspace().profiles.find(
    (profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID,
  )!
  await assert.rejects(
    createCodexProviderReadinessPort(harness.service).ensureReady({
      profileId: oauthProfile.id,
      config: oauthProfile.config,
    }),
    /codex_chatgpt_oauth_runtime_unavailable/,
  )
  assert.deepEqual(harness.serverCounts(), { serverStarts: 1, closeAttempts: 1 })

  const edited = {
    ...harness.readWorkspace(),
    profiles: harness.readWorkspace().profiles.map((profile) => (
      profile.id === CHATGPT_OAUTH_PROFILE_ID
        ? { ...profile, config: { ...profile.config, model: 'gpt-5.6-terra' } }
        : profile
    )),
  }
  await harness.persist(edited)
  assert.equal(
    harness.readWorkspace().profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID)
      ?.config.model,
    'gpt-5.6-terra',
  )

  const rotated = {
    ...harness.readWorkspace(),
    profiles: harness.readWorkspace().profiles.map((profile) => (
      profile.id === CHATGPT_OAUTH_PROFILE_ID
        ? { ...profile, config: { ...profile.config, apiKey: ROTATED_PROXY_API_KEY } }
        : profile
    )),
  }
  await assert.rejects(
    harness.persist(rotated),
    /chatgpt_oauth_proxy_key_requires_reconnect/,
  )
  assert.equal(harness.service.getProxyApiKey(), PROXY_API_KEY)
  assert.equal(
    harness.readWorkspace().profiles.find((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID)
      ?.config.apiKey,
    PROXY_API_KEY,
  )

  await harness.disconnect()
  assert.deepEqual(harness.serverCounts(), { serverStarts: 1, closeAttempts: 2 })
  assert.equal(harness.service.getStatus().state, 'signed_out')
  assert.equal(harness.hasCredential(), false)
  assert.equal(
    harness.readWorkspace().profiles.some((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID),
    false,
  )
})

test('a credential-removal failure restores the OAuth workspace and can restart from the retained credential', async () => {
  const harness = createHarness()
  await harness.service.ensureReady(['gpt-5.6-sol'], PROXY_API_KEY)
  const original = harness.readWorkspace()
  harness.failNextCredentialRemoval()

  await assert.rejects(
    harness.disconnect(),
    /credential_remove_failed/,
  )

  assert.deepEqual(harness.readWorkspace(), original)
  assert.equal(harness.service.getStatus().state, 'error')
  assert.equal(harness.service.getStatus().connected, true)
  assert.equal(harness.service.getStatus().running, false)
  assert.equal(harness.hasCredential(), true)
  const active = harness.readWorkspace().profiles.find(
    (profile) => profile.id === harness.readWorkspace().activeProfileId,
  )!
  await createCodexProviderReadinessPort(harness.service).ensureReady({
    profileId: active.id,
    config: active.config,
  })
  assert.equal(harness.service.getStatus().state, 'ready')
})

test('a credential-removal error after deletion never restores a stale OAuth profile', async () => {
  const harness = createHarness()
  await harness.service.ensureReady(['gpt-5.6-sol'], PROXY_API_KEY)
  const oauthProfile = harness.readWorkspace().profiles.find(
    (profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID,
  )!
  harness.failNextCredentialRemovalAfterDelete()

  await assert.rejects(harness.disconnect(), /credential_remove_failed_after_delete/)

  assert.equal(harness.hasCredential(), false)
  assert.equal(harness.service.getStatus().state, 'error')
  assert.equal(harness.service.getStatus().connected, false)
  assert.equal(harness.service.getStatus().running, false)
  assert.throws(() => harness.service.getProxyApiKey(), /口令尚未建立/)
  assert.equal(
    harness.readWorkspace().profiles.some((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID),
    false,
  )
  await assert.rejects(
    createCodexProviderReadinessPort(harness.service).ensureReady({
      profileId: oauthProfile.id,
      config: oauthProfile.config,
    }),
    /codex_chatgpt_oauth_not_connected/,
  )
})

test('a workspace-commit failure leaves the ready service and its recoverable profile untouched', async () => {
  const harness = createHarness()
  await harness.service.ensureReady(['gpt-5.6-sol'], PROXY_API_KEY)
  const original = harness.readWorkspace()
  harness.failNextWorkspaceWrite()

  await assert.rejects(
    harness.disconnect(),
    /workspace_commit_failed/,
  )

  assert.deepEqual(harness.readWorkspace(), original)
  assert.equal(harness.service.getStatus().state, 'ready')
  assert.equal(harness.service.getStatus().connected, true)
  assert.equal(harness.service.getStatus().running, true)
  assert.equal(harness.service.getProxyApiKey(), PROXY_API_KEY)
  assert.equal(harness.hasCredential(), true)
  const active = harness.readWorkspace().profiles.find(
    (profile) => profile.id === harness.readWorkspace().activeProfileId,
  )!
  await createCodexProviderReadinessPort(harness.service).ensureReady({
    profileId: active.id,
    config: active.config,
  })
  assert.equal(harness.service.getStatus().state, 'ready')
})

test('disconnect cleanup and a stale non-OAuth-active save cannot resurrect OAuth', async () => {
  const harness = createHarness()
  await harness.service.ensureReady(['gpt-5.6-sol'], PROXY_API_KEY)
  const stale = {
    ...harness.readWorkspace(),
    activeProfileId: 'builtin-openai',
  }
  harness.blockClose()
  harness.blockRemove()
  const disconnecting = harness.disconnect()
  await harness.closeStarted

  const saving = harness.persist(stale)
  let saveSettled = false
  void saving.finally(() => { saveSettled = true }).catch(() => undefined)
  await Promise.resolve()
  assert.equal(saveSettled, false)

  harness.allowClose()
  await harness.removeStarted
  assert.equal(saveSettled, false)
  harness.allowRemove()
  await disconnecting
  await assert.rejects(saving, /chatgpt_oauth_profile_requires_connect/)

  assert.equal(harness.hasCredential(), false)
  assert.equal(harness.service.getStatus().running, false)
  assert.equal(
    harness.readWorkspace().profiles.some((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID),
    false,
  )
})

test('failed reconnect cleanup and a stale non-OAuth-active save cannot restore OAuth', async () => {
  const harness = createHarness()
  await harness.service.ensureReady(['gpt-5.6-sol'], PROXY_API_KEY)
  const stale = {
    ...harness.readWorkspace(),
    activeProfileId: 'builtin-openai',
  }
  harness.failNextLogin()
  harness.blockRemove()
  const reconnecting = harness.service.connect(undefined, {
    beforeRestart: () => {
      const latest = harness.repository.getAIWorkspace()
      harness.repository.setAIWorkspace(removeChatGptOAuthProfile(latest))
      return { existingProxyApiKey: PROXY_API_KEY }
    },
    afterReady: () => { throw new Error('must_not_commit_failed_connect') },
  })
  await harness.loginStarted
  const saving = harness.persist(stale)
  harness.allowLogin()
  await harness.removeStarted
  harness.allowRemove()

  await assert.rejects(reconnecting, /browser_login_failed/)
  await assert.rejects(saving, /chatgpt_oauth_profile_requires_connect/)
  assert.equal(harness.hasCredential(), false)
  assert.equal(harness.service.getStatus().running, false)
  assert.equal(
    harness.readWorkspace().profiles.some((profile) => profile.id === CHATGPT_OAUTH_PROFILE_ID),
    false,
  )
})

test('a paused OAuth reconnect rejects send before persistence and admission reopens after commit', async () => {
  const harness = createHarness()
  await harness.service.ensureReady(['gpt-5.6-sol'], PROXY_API_KEY)
  const reconnecting = harness.service.connect(undefined, {
    beforeRestart: () => {
      const latest = harness.repository.getAIWorkspace()
      harness.repository.setAIWorkspace(removeChatGptOAuthProfile(latest))
      return { existingProxyApiKey: PROXY_API_KEY }
    },
    afterReady: (status) => {
      harness.repository.setAIWorkspace(upsertChatGptOAuthProfile(
        harness.repository.getAIWorkspace(),
        status.models,
        harness.service.getProxyApiKey(),
      ))
    },
  })
  await harness.loginStarted
  const readiness = createCodexProviderReadinessPort(harness.service)
  let persistedMessages = 0
  let nativeRuns = 0
  let sequence = 0
  const send = async () => {
    sequence += 1
    const requestId = `request-${sequence}`
    return runConfirmedSendScoped({
      scopeId: 'scope-1',
      requestId,
      userMessage: {
        id: `user-${sequence}`,
        content: 'hello',
        timestamp: '2026-08-11T00:00:00.000Z',
        meta: {},
        attachmentConfirmation: {
          selectedCount: 0,
          metadataCount: 0,
          inputIncludedCount: 0,
          inputFailedCount: 0,
        },
      },
      getScope: () => ({ id: 'scope-1' }),
      resolveStartIdentityMethods: () => ['turn/start'],
      reserveStartIdentitySet: async () => ({
        ok: true,
        reservation: {
          reservationSetId: `reservation-${sequence}`,
          scopeId: 'scope-1',
          existingThread: true,
          members: [{ method: 'turn/start', reservationId: `turn-${sequence}` }],
          reservationEvidenceDigest: `reservation-digest-${sequence}`,
        },
      }),
      reconcileReservationContractFailure: async () => undefined,
      prepareDispatch: async () => {
        const workspace = harness.repository.getAIWorkspace()
        const profile = workspace.profiles.find((candidate) => candidate.id === workspace.activeProfileId)!
        try {
          await readiness.ensureReady({ profileId: profile.id, config: profile.config })
          return { ok: true as const, dispatchContext: { requestId } }
        } catch (error) {
          const failure = classifyCodexIngressPreparationError(error)
          return {
            ok: false as const,
            ...failure,
            admissionEvidenceDigest: `readiness-${sequence}`,
          }
        }
      },
      validateDispatchContext: (value): value is { requestId: string } => (
        Boolean(value)
        && typeof value === 'object'
        && (value as { requestId?: unknown }).requestId === requestId
      ),
      persistIngressAtomic: async () => {
        persistedMessages += 1
        return {
          persistence: {
            scope: 'pre-existing' as const,
            message: 'persisted' as const,
            attachments: 'none' as const,
            inputAttachments: 'none' as const,
          },
          event: {
            type: 'ingress_admitted' as const,
            requestId,
            scopeId: 'scope-1',
            originUserMessageId: `user-${sequence}`,
            aliasGeneration: 1,
            ingressAdmittedRevision: 1,
            ingressAdmittedDigest: `ingress-${sequence}`,
            admittedAt: '2026-08-11T00:00:00.000Z',
          },
        }
      },
      emitIngressAdmitted: () => undefined,
      releaseReservationAfterIngressFailure: async () => undefined,
      releaseReservationAfterPrePersistenceRejection: async () => undefined,
      runConfirmed: async ({ persistence }) => {
        nativeRuns += 1
        return {
          success: true as const,
          disposition: 'terminal_success' as const,
          ownerRunId: requestId,
          shouldClearInput: true as const,
          preserveInput: false as const,
          retryableByUser: false as const,
          persistence,
          responseText: 'ok',
          canonicalMessage: {
            id: `assistant-${sequence}`,
            conversationId: 'scope-1',
            role: 'assistant' as const,
            content: 'ok',
            timestamp: '2026-08-11T00:00:00.000Z',
            meta: {},
          },
          canonicalMessageDigest: `assistant-digest-${sequence}`,
        }
      },
    })
  }

  const rejected = await send()
  assert.equal(rejected.disposition, 'rejected_before_persistence')
  assert.equal(rejected.errorKind, 'external_service_unavailable')
  assert.equal(rejected.retryableByUser, true)
  assert.equal(persistedMessages, 0)
  assert.equal(nativeRuns, 0)

  harness.allowLogin()
  await reconnecting
  const admitted = await send()
  assert.equal(admitted.disposition, 'terminal_success')
  assert.equal(persistedMessages, 1)
  assert.equal(nativeRuns, 1)
})
