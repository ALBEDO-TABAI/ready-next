import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ChatGptOAuthService,
  type ChatGptOAuthServiceDeps,
} from '../main/modules/settings-engine/chatgpt-oauth-service'

const PROXY_API_KEY = 'ready-oauth-proxy-key-12345678901234567890'

function createHarness() {
  let credential = false
  let startCount = 0
  let closeCount = 0
  let loginCount = 0
  let removeCount = 0
  let startError: Error | null = null
  let loginError: Error | null = null
  const startedKeys: string[] = []
  const startedModels: Array<string[] | undefined> = []
  let resolveStart: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    resolveStart = resolve
  })
  const deps: ChatGptOAuthServiceDeps = {
    credentialExists: () => credential,
    login: async () => {
      loginCount += 1
      if (loginError) throw loginError
      credential = true
    },
    startServer: async (models, proxyApiKey) => {
      startCount += 1
      startedKeys.push(proxyApiKey)
      startedModels.push(models)
      await gate
      if (startError) throw startError
      return {
        models: models || ['gpt-5.6-terra'],
        close: async () => {
          closeCount += 1
        },
      }
    },
    removeCredential: async () => {
      removeCount += 1
      credential = false
    },
  }
  return {
    service: new ChatGptOAuthService(deps),
    setCredential: (value: boolean) => { credential = value },
    setStartError: (error: Error | null) => { startError = error },
    setLoginError: (error: Error | null) => { loginError = error },
    resolveStart: () => resolveStart?.(),
    counts: () => ({ startCount, closeCount, loginCount, removeCount }),
    startedKeys,
    startedModels,
  }
}

test('concurrent ready requests join one server start', async () => {
  const harness = createHarness()
  harness.setCredential(true)
  const first = harness.service.ensureReady(['gpt-5.6-terra'], PROXY_API_KEY)
  const second = harness.service.ensureReady(['gpt-5.6-terra'], PROXY_API_KEY)
  assert.equal(harness.counts().startCount, 1)

  harness.resolveStart()
  const [firstStatus, secondStatus] = await Promise.all([first, second])
  assert.equal(firstStatus.state, 'ready')
  assert.equal(secondStatus.running, true)
  assert.equal(harness.counts().startCount, 1)
})

test('connect logs in before starting and disconnect closes and removes only its credential', async () => {
  const harness = createHarness()
  const connecting = harness.service.connect(PROXY_API_KEY, ['gpt-5.6-terra'])
  harness.resolveStart()
  const connected = await connecting

  assert.equal(connected.connected, true)
  assert.equal(harness.service.getProxyApiKey(), PROXY_API_KEY)
  assert.deepEqual(harness.startedKeys, [PROXY_API_KEY])
  assert.deepEqual(harness.startedModels, [['gpt-5.6-terra']])
  assert.deepEqual(harness.counts(), {
    startCount: 1,
    closeCount: 0,
    loginCount: 1,
    removeCount: 0,
  })

  const disconnected = await harness.service.disconnect()
  assert.equal(disconnected.state, 'signed_out')
  assert.deepEqual(harness.counts(), {
    startCount: 1,
    closeCount: 1,
    loginCount: 1,
    removeCount: 1,
  })
})

test('server failures remain visible and never report ready', async () => {
  const harness = createHarness()
  harness.setCredential(true)
  harness.setStartError(new Error('port already in use'))
  const starting = harness.service.ensureReady([], PROXY_API_KEY)
  harness.resolveStart()

  await assert.rejects(starting, /port already in use/)
  const status = harness.service.getStatus()
  assert.equal(status.state, 'error')
  assert.equal(status.running, false)
  assert.match(status.error || '', /port already in use/)
})

test('a saved credential cannot start an unauthenticated loopback server', async () => {
  const harness = createHarness()
  harness.setCredential(true)

  await assert.rejects(
    harness.service.ensureReady(['gpt-5.6-terra'], 'openai-oauth'),
    /访问口令无效/,
  )
  assert.equal(harness.counts().startCount, 0)
  assert.equal(harness.service.getStatus().state, 'error')
})

test('stopping only the local service keeps its credential available', async () => {
  const harness = createHarness()
  harness.setCredential(true)
  const starting = harness.service.ensureReady(['gpt-5.6-terra'], PROXY_API_KEY)
  harness.resolveStart()
  await starting

  await harness.service.stop()

  assert.equal(harness.service.getStatus().state, 'signed_in')
  assert.deepEqual(harness.counts(), {
    startCount: 1,
    closeCount: 1,
    loginCount: 0,
    removeCount: 0,
  })
})

test('an existing credential resumes with cached models without browser login', async () => {
  const harness = createHarness()
  harness.setCredential(true)
  harness.resolveStart()

  await harness.service.ensureReady(['gpt-5.6-terra'], PROXY_API_KEY)
  await harness.service.stop()
  const resumed = await harness.service.ensureReady(['gpt-5.6-terra'], PROXY_API_KEY)

  assert.equal(resumed.state, 'ready')
  assert.deepEqual(harness.startedModels, [
    ['gpt-5.6-terra'],
    ['gpt-5.6-terra'],
  ])
  assert.deepEqual(harness.counts(), {
    startCount: 2,
    closeCount: 1,
    loginCount: 0,
    removeCount: 0,
  })
})

test('a failed explicit reauthorization leaves an already running session available', async () => {
  const harness = createHarness()
  harness.setCredential(true)
  harness.resolveStart()
  await harness.service.ensureReady(['gpt-5.6-terra'], PROXY_API_KEY)
  harness.setLoginError(new Error('browser login timed out'))

  await assert.rejects(
    harness.service.connect(PROXY_API_KEY, ['gpt-5.6-terra']),
    /browser login timed out/,
  )

  assert.equal(harness.service.getStatus().state, 'ready')
  assert.deepEqual(harness.counts(), {
    startCount: 1,
    closeCount: 0,
    loginCount: 1,
    removeCount: 0,
  })
})
