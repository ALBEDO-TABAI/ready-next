/**
 * Tests for the centralized Puppeteer browser registry.
 *
 * The module is dependency-free (no `puppeteer-core` import) and accepts any
 * structurally-compatible `Browser` handle. Tests use a hand-rolled fake.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __resetBrowserRegistryForTests,
  closeAllBrowsers,
  getLiveBrowserCount,
  launchManagedBrowser,
  registerBrowser,
  type ManagedBrowserHandle,
} from '../main/modules/browser-engine/browser-cleanup'

interface FakeBrowserOpts {
  /** Override the close behaviour. Default: resolves immediately. */
  close?: () => Promise<void>
  /** Override process(); return null to simulate no live chromium pid. */
  process?: () => { kill: (signal: NodeJS.Signals | number) => boolean } | null
}

interface FakeBrowser extends ManagedBrowserHandle {
  killCalls: Array<NodeJS.Signals | number>
  closed: boolean
  fireDisconnected: () => void
}

function makeFakeBrowser(opts: FakeBrowserOpts = {}): FakeBrowser {
  const killCalls: Array<NodeJS.Signals | number> = []
  let disconnectedListener: (() => void) | null = null
  const fake: FakeBrowser = {
    closed: false,
    killCalls,
    fireDisconnected: () => {
      disconnectedListener?.()
    },
    close: async () => {
      if (opts.close) {
        await opts.close()
      }
      fake.closed = true
    },
    on: (event, listener) => {
      if (event === 'disconnected') disconnectedListener = listener
      return fake
    },
    process: () => {
      if (opts.process) return opts.process()
      return {
        kill: (signal) => {
          killCalls.push(signal)
          return true
        },
      }
    },
  }
  return fake
}

test('launchManagedBrowser registers the browser in the live set', async () => {
  __resetBrowserRegistryForTests()
  const fake = makeFakeBrowser()
  const launched = await launchManagedBrowser(async () => fake)
  assert.equal(launched, fake)
  assert.equal(getLiveBrowserCount(), 1)
  __resetBrowserRegistryForTests()
})

test("'disconnected' event auto-removes the browser from the registry", async () => {
  __resetBrowserRegistryForTests()
  const fake = makeFakeBrowser()
  await launchManagedBrowser(async () => fake)
  assert.equal(getLiveBrowserCount(), 1)
  fake.fireDisconnected()
  assert.equal(getLiveBrowserCount(), 0)
  __resetBrowserRegistryForTests()
})

test('closeAllBrowsers awaits browser.close() and clears the registry', async () => {
  __resetBrowserRegistryForTests()
  const a = makeFakeBrowser()
  const b = makeFakeBrowser()
  await launchManagedBrowser(async () => a)
  await launchManagedBrowser(async () => b)
  assert.equal(getLiveBrowserCount(), 2)

  const result = await closeAllBrowsers(1_000)
  assert.equal(result.closed, 2)
  assert.deepEqual(result.errors, [])
  assert.equal(a.closed, true)
  assert.equal(b.closed, true)
  assert.equal(getLiveBrowserCount(), 0)
  __resetBrowserRegistryForTests()
})

test('closeAllBrowsers escalates to SIGKILL on per-browser timeout', async () => {
  __resetBrowserRegistryForTests()
  const stuck = makeFakeBrowser({
    // close() never resolves — simulates a hung chromium.
    close: () => new Promise<void>(() => {}),
  })
  await launchManagedBrowser(async () => stuck)

  const result = await closeAllBrowsers(20)
  assert.equal(result.closed, 0)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /timeout/i)
  assert.deepEqual(stuck.killCalls, ['SIGKILL'])
  // Registry must be drained even when close() hung — otherwise a second
  // shutdown attempt would leak the same handle again.
  assert.equal(getLiveBrowserCount(), 0)
  __resetBrowserRegistryForTests()
})

test('closeAllBrowsers tolerates a browser whose process() returns null', async () => {
  __resetBrowserRegistryForTests()
  const stuck = makeFakeBrowser({
    close: () => new Promise<void>(() => {}),
    process: () => null,
  })
  await launchManagedBrowser(async () => stuck)

  const result = await closeAllBrowsers(20)
  assert.equal(result.closed, 0)
  assert.equal(result.errors.length, 1)
  // No pid to kill, no kill recorded — but no throw either.
  assert.deepEqual(stuck.killCalls, [])
  assert.equal(getLiveBrowserCount(), 0)
  __resetBrowserRegistryForTests()
})

test('closeAllBrowsers swallows per-browser close() rejections and continues with the rest', async () => {
  __resetBrowserRegistryForTests()
  const bad = makeFakeBrowser({
    close: async () => {
      throw new Error('close boom')
    },
  })
  const good = makeFakeBrowser()
  await launchManagedBrowser(async () => bad)
  await launchManagedBrowser(async () => good)

  const result = await closeAllBrowsers(1_000)
  assert.equal(result.closed, 1)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /close boom/)
  // Good browser closed cleanly even though `bad` failed first.
  assert.equal(good.closed, true)
  // Bad browser still SIGKILLed as escape valve.
  assert.deepEqual(bad.killCalls, ['SIGKILL'])
  assert.equal(getLiveBrowserCount(), 0)
  __resetBrowserRegistryForTests()
})

test('registerBrowser supports puppeteer.connect-style attach (non-thunk)', async () => {
  __resetBrowserRegistryForTests()
  const fake = makeFakeBrowser()
  registerBrowser(fake)
  assert.equal(getLiveBrowserCount(), 1)
  fake.fireDisconnected()
  assert.equal(getLiveBrowserCount(), 0)
  __resetBrowserRegistryForTests()
})

test('closeAllBrowsers on an empty registry is a no-op', async () => {
  __resetBrowserRegistryForTests()
  const result = await closeAllBrowsers(50)
  assert.equal(result.closed, 0)
  assert.deepEqual(result.errors, [])
})
