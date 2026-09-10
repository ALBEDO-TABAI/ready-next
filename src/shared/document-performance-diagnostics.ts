export type DocumentPerformanceCounter =
  | 'outlineBuilds'
  | 'widgetFenceScans'
  | 'widgetStateParses'
  | 'previewParses'
  | 'markdownParses'
  | 'previewBlockRenders'
  | 'widgetBlockRenders'
  | 'widgetCompiles'
  | 'boardDragCommits'
  | 'boardInteractionFrames'
  | 'directoryBroadcasts'
  | 'metadataWrites'

export type DocumentPerformanceMaximum = 'pdfMountedPagesPeak'

const counterNames: DocumentPerformanceCounter[] = [
  'outlineBuilds',
  'widgetFenceScans',
  'widgetStateParses',
  'previewParses',
  'markdownParses',
  'previewBlockRenders',
  'widgetBlockRenders',
  'widgetCompiles',
  'boardDragCommits',
  'boardInteractionFrames',
  'directoryBroadcasts',
  'metadataWrites',
]

let enabled = false
let counters = createCounters()
let maxima: Record<DocumentPerformanceMaximum, number> = { pdfMountedPagesPeak: 0 }

function createCounters(): Record<DocumentPerformanceCounter, number> {
  return Object.fromEntries(counterNames.map((name) => [name, 0])) as Record<DocumentPerformanceCounter, number>
}

export function setDocumentPerformanceDiagnosticsEnabled(nextEnabled: boolean): void {
  enabled = nextEnabled
}

export function recordDocumentPerformanceCounter(
  name: DocumentPerformanceCounter,
  amount = 1,
): void {
  if (!enabled) return
  counters[name] += amount
}

export function recordDocumentPerformanceMaximum(
  name: DocumentPerformanceMaximum,
  value: number,
): void {
  if (!enabled || !Number.isFinite(value)) return
  maxima[name] = Math.max(maxima[name], value)
}

export function resetDocumentPerformanceDiagnostics(): void {
  counters = createCounters()
  maxima = { pdfMountedPagesPeak: 0 }
}

export function getDocumentPerformanceDiagnosticsSnapshot(): {
  enabled: boolean
  counters: Record<DocumentPerformanceCounter, number>
  maxima: Record<DocumentPerformanceMaximum, number>
} {
  return {
    enabled,
    counters: { ...counters },
    maxima: { ...maxima },
  }
}

export interface DocumentPerformanceDiagnosticsControl {
  enable(nextEnabled?: boolean): void
  reset(): void
  snapshot(): ReturnType<typeof getDocumentPerformanceDiagnosticsSnapshot>
}

const diagnosticsControl: DocumentPerformanceDiagnosticsControl = {
  enable: (nextEnabled = true) => setDocumentPerformanceDiagnosticsEnabled(nextEnabled),
  reset: resetDocumentPerformanceDiagnostics,
  snapshot: getDocumentPerformanceDiagnosticsSnapshot,
}

try {
  Object.defineProperty(globalThis, '__READY_DOCUMENT_PERFORMANCE__', {
    value: diagnosticsControl,
    configurable: true,
  })
} catch {
  // Diagnostics stay available through module exports when the host global is sealed.
}
