export interface BrowserTabContextData {
  title: string
  url: string
  domain: string
  heading: string
  selection: string
  excerpt: string
  capturedAt: number
}

export type BrowserCDPErrorCode =
  | 'NO_ACTIVE_TAB'
  | 'TAB_NOT_FOUND'
  | 'DEBUGGER_ATTACH_FAILED'
  | 'CDP_COMMAND_FAILED'
  | 'FRAME_NOT_FOUND'

export interface BrowserContentFrameInfo {
  /** '0' = 主帧；子帧为 `${processId}-${routingId}`（随帧实例存亡，可嵌入 targetId）。 */
  frameKey: string
  url: string
  main: boolean
}

export interface BrowserViewportMetrics {
  width: number
  height: number
  pageX: number
  pageY: number
  scale: number
}

export interface BrowserMouseEventPayload {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'
  x: number
  y: number
  button?: 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward'
  buttons?: number
  clickCount?: number
  deltaX?: number
  deltaY?: number
  modifiers?: number
}

export interface BrowserKeyEventPayload {
  type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char'
  key?: string
  code?: string
  text?: string
  modifiers?: number
  windowsVirtualKeyCode?: number
  nativeVirtualKeyCode?: number
  isKeypad?: boolean
  autoRepeat?: boolean
  unmodifiedText?: string
  location?: number
  commands?: string[]
  emulateFocus?: boolean
}

export interface BrowserScreenshotOptions {
  mode?: 'viewport' | 'clip' | 'full_page'
  clip?: {
    x: number
    y: number
    width: number
    height: number
  }
}

export interface BrowserUploadTarget {
  id: string
  kind: 'input' | 'launcher' | 'dropzone'
  selectorHint: string
  label: string
  accepts: string
  multiple: boolean
  hidden: boolean
  confidence?: number
  evidence?: string[]
  associatedInputSelector?: string
  x?: number
  y?: number
}
