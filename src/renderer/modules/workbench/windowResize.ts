type ResizeSubscriber = () => void

const resizeSubscribers = new Set<ResizeSubscriber>()
let resizeListening = false
let resizeRafId: number | null = null

function flushResizeSubscribers() {
  resizeRafId = null
  resizeSubscribers.forEach((subscriber) => {
    subscriber()
  })
}

function handleWindowResize() {
  if (resizeRafId !== null) return
  resizeRafId = window.requestAnimationFrame(flushResizeSubscribers)
}

function ensureResizeListener() {
  if (resizeListening || typeof window === 'undefined') return
  resizeListening = true
  window.addEventListener('resize', handleWindowResize)
}

function cleanupResizeListener() {
  if (typeof window === 'undefined') return
  if (resizeSubscribers.size === 0) {
    window.removeEventListener('resize', handleWindowResize)
    resizeListening = false
    if (resizeRafId !== null) {
      window.cancelAnimationFrame(resizeRafId)
      resizeRafId = null
    }
  }
}

export function subscribeWorkbenchWindowResize(subscriber: ResizeSubscriber) {
  resizeSubscribers.add(subscriber)
  ensureResizeListener()

  return () => {
    resizeSubscribers.delete(subscriber)
    cleanupResizeListener()
  }
}
