import { JSDOM } from 'jsdom'
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: (cb: FrameRequestCallback) => { cb(0); return 0 }, configurable: true })
;(globalThis.window as unknown as { electronAPI?: unknown }).electronAPI = {
  agent: {
    listScopeRuns: async () => ({ success: false }),
    listTaskProjections: async () => ({ success: false }),
    listActiveChildRuns: async () => ({ success: false }),
    onTaskProjectionsChanged: () => () => {},
    onReferenceSkillHintChanged: () => () => {},
  },
}

async function main() {
  const m1 = await import('../src/renderer/components/agent/ChatMessages')
  console.log('ChatMessages loaded:', typeof m1.default)
  const m2 = await import('../src/renderer/components/agent/SoftFailureCapsule')
  console.log('SoftFailureCapsule loaded:', typeof m2.SoftFailureCapsule)
  const m3 = await import('../src/renderer/components/agent/ChatAttachments')
  console.log('ChatAttachments loaded:', typeof m3.default)
}

main().catch(e => {
  console.error('FAILED:', e?.message || e)
  console.error(e?.stack)
  process.exit(1)
})
