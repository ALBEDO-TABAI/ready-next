import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Bold,
  Italic,
  Strikethrough,
  Code2,
  Link as LinkIcon,
  Quote,
  List,
  ListOrdered,
  CheckSquare,
  ChevronDown,
  Type,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SelectionRange {
  start: number
  end: number
}

export interface MarkdownSelectionToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  content: string
  selectionRange: SelectionRange
  /**
   * Preferred anchor in viewport coordinates (e.g. mouseup position). When
   * present, the toolbar is placed just below this point. Falls back to a
   * mirror-div caret lookup at `selectionRange.end` when null/undefined.
   */
  anchor?: { x: number; y: number } | null
  onChange: (nextContent: string, nextSelection: SelectionRange) => void
}

// ---------------------------------------------------------------------------
// Mirror-div caret coordinates helper
// (Compact implementation of the textarea-caret-position algorithm.)
// ---------------------------------------------------------------------------

const MIRROR_STYLE_PROPS = [
  'boxSizing',
  'width',
  'height',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderTopStyle',
  'borderRightStyle',
  'borderBottomStyle',
  'borderLeftStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'whiteSpace',
  'wordBreak',
  'overflowWrap',
] as const

function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number,
): { left: number; top: number; lineHeight: number } {
  const taRect = textarea.getBoundingClientRect()
  const computed = window.getComputedStyle(textarea)
  const mirror = document.createElement('div')

  mirror.style.position = 'absolute'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.visibility = 'hidden'

  for (const prop of MIRROR_STYLE_PROPS) {
    const value = (computed as unknown as Record<string, string>)[prop]
    if (value) {
      ;(mirror.style as unknown as Record<string, string>)[prop] = value
    }
  }
  // textarea wraps; ensure mirror does the same regardless of computed shortcut
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'

  mirror.textContent = textarea.value.substring(0, position)
  const marker = document.createElement('span')
  // A trailing char gives layout even at end-of-line; clamp to current line.
  const remainder = textarea.value.substring(position)
  marker.textContent = remainder.split('\n')[0] || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  const markerTop = marker.offsetTop
  const markerLeft = marker.offsetLeft
  document.body.removeChild(mirror)

  const lineHeightRaw = parseFloat(computed.lineHeight)
  const fontSize = parseFloat(computed.fontSize) || 14
  const lineHeight = Number.isFinite(lineHeightRaw) && lineHeightRaw > 0
    ? lineHeightRaw
    : fontSize * 1.4

  return {
    left: taRect.left + markerLeft - textarea.scrollLeft,
    top: taRect.top + markerTop - textarea.scrollTop,
    lineHeight,
  }
}

// ---------------------------------------------------------------------------
// Markdown source manipulation helpers
// ---------------------------------------------------------------------------

interface MutationResult {
  next: string
  selection: SelectionRange
}

function wrapSelection(
  content: string,
  start: number,
  end: number,
  prefix: string,
  suffix: string = prefix,
): MutationResult {
  const selected = content.slice(start, end)
  const before = content.slice(0, start)
  const after = content.slice(end)

  // Toggle off: outer prefix/suffix already wrap the current selection.
  if (before.endsWith(prefix) && after.startsWith(suffix)) {
    const next =
      before.slice(0, before.length - prefix.length) +
      selected +
      after.slice(suffix.length)
    return {
      next,
      selection: {
        start: start - prefix.length,
        end: end - prefix.length,
      },
    }
  }

  // Toggle off: prefix/suffix are inside the selection itself.
  if (
    selected.startsWith(prefix) &&
    selected.endsWith(suffix) &&
    selected.length >= prefix.length + suffix.length
  ) {
    const unwrapped = selected.slice(
      prefix.length,
      selected.length - suffix.length,
    )
    return {
      next: before + unwrapped + after,
      selection: {
        start,
        end: end - prefix.length - suffix.length,
      },
    }
  }

  return {
    next: before + prefix + selected + suffix + after,
    selection: {
      start: start + prefix.length,
      end: end + prefix.length,
    },
  }
}

interface LineSpan {
  lineStart: number
  lineEnd: number
}

function getSelectedLineSpan(
  content: string,
  start: number,
  end: number,
): LineSpan {
  let lineStart = start
  while (lineStart > 0 && content[lineStart - 1] !== '\n') {
    lineStart -= 1
  }
  // For a multi-line selection ending exactly at a newline boundary, the
  // trailing empty line shouldn't be included in line-level operations.
  let effectiveEnd = end
  if (end > start && end > 0 && content[end - 1] === '\n') {
    effectiveEnd = end - 1
  }
  let lineEnd = effectiveEnd
  while (lineEnd < content.length && content[lineEnd] !== '\n') {
    lineEnd += 1
  }
  return { lineStart, lineEnd }
}

function applyPerLineTransform(
  content: string,
  start: number,
  end: number,
  transform: (line: string, index: number) => string,
): MutationResult {
  const { lineStart, lineEnd } = getSelectedLineSpan(content, start, end)
  const before = content.slice(0, lineStart)
  const block = content.slice(lineStart, lineEnd)
  const after = content.slice(lineEnd)
  const lines = block.split('\n')
  const transformedLines = lines.map(transform)
  const transformed = transformedLines.join('\n')
  const totalDelta = transformed.length - block.length
  const firstLineDelta = transformedLines[0].length - lines[0].length
  return {
    next: before + transformed + after,
    selection: {
      start: Math.max(lineStart, start + firstLineDelta),
      end: end + totalDelta,
    },
  }
}

function prefixSelectedLines(
  content: string,
  start: number,
  end: number,
  linePrefix: string,
): MutationResult {
  const { lineStart, lineEnd } = getSelectedLineSpan(content, start, end)
  const block = content.slice(lineStart, lineEnd)
  const lines = block.split('\n')
  const nonEmptyLines = lines.filter((line) => line.length > 0)
  const allPrefixed =
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((line) => line.startsWith(linePrefix))
  if (allPrefixed) {
    return applyPerLineTransform(content, start, end, (line) =>
      line.startsWith(linePrefix) ? line.slice(linePrefix.length) : line,
    )
  }
  return applyPerLineTransform(content, start, end, (line) =>
    line.length === 0 ? line : linePrefix + line,
  )
}

function applyOrderedList(
  content: string,
  start: number,
  end: number,
): MutationResult {
  const { lineStart, lineEnd } = getSelectedLineSpan(content, start, end)
  const block = content.slice(lineStart, lineEnd)
  const lines = block.split('\n')
  const olRegex = /^(\d+)\.\s/
  const nonEmptyLines = lines.filter((line) => line.length > 0)
  const allOrdered =
    nonEmptyLines.length > 0 && nonEmptyLines.every((line) => olRegex.test(line))
  if (allOrdered) {
    return applyPerLineTransform(content, start, end, (line) =>
      line.replace(olRegex, ''),
    )
  }
  let counter = 1
  return applyPerLineTransform(content, start, end, (line) => {
    if (line.length === 0) return line
    const next = `${counter}. ${line.replace(olRegex, '')}`
    counter += 1
    return next
  })
}

function setHeadingLevel(
  content: string,
  start: number,
  end: number,
  level: 0 | 1 | 2 | 3,
): MutationResult {
  const headingRegex = /^(#{1,6})\s+/
  return applyPerLineTransform(content, start, end, (line) => {
    const stripped = line.replace(headingRegex, '')
    if (level === 0) return stripped
    return `${'#'.repeat(level)} ${stripped}`
  })
}

function wrapAsLink(
  content: string,
  start: number,
  end: number,
  url: string,
): MutationResult {
  const selected = content.slice(start, end) || 'link'
  const before = content.slice(0, start)
  const after = content.slice(end)
  const insertion = `[${selected}](${url})`
  return {
    next: before + insertion + after,
    selection: {
      start: start + 1,
      end: start + 1 + selected.length,
    },
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const TOOLBAR_HEIGHT = 36
const TOOLBAR_VERTICAL_GAP = 8
const ICON_COLOR = 'var(--text-body, #333)'

// Approximate toolbar width — used to nudge `left` so the bar's center sits
// near the anchor instead of starting from it. Keep in rough sync with the
// rendered button row (~10 buttons × 30 + paddings).
const TOOLBAR_APPROX_WIDTH = 330

export default function MarkdownSelectionToolbar({
  textareaRef,
  content,
  selectionRange,
  anchor,
  onChange,
}: MarkdownSelectionToolbarProps): ReactNode {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  )
  const [showHeadingMenu, setShowHeadingMenu] = useState(false)
  const [linkInputVisible, setLinkInputVisible] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const linkInputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) {
      setPosition(null)
      return
    }
    const viewportWidth = window.innerWidth
    const taRect = ta.getBoundingClientRect()

    // Primary: place directly below the mouseup anchor (matches user gaze).
    if (anchor) {
      const rawLeft = anchor.x - TOOLBAR_APPROX_WIDTH / 2
      const left = Math.min(
        Math.max(8, rawLeft),
        Math.max(8, viewportWidth - TOOLBAR_APPROX_WIDTH - 8),
      )
      setPosition({ left, top: anchor.y + TOOLBAR_VERTICAL_GAP })
      return
    }

    // Fallback: keyboard selection (Shift+arrow) — anchor on selection end.
    const coords = getCaretCoordinates(ta, selectionRange.end)
    const rawLeft = coords.left - TOOLBAR_APPROX_WIDTH / 2
    const maxLeft = Math.max(8, taRect.right - TOOLBAR_APPROX_WIDTH - 8)
    const left = Math.min(Math.max(8, rawLeft), maxLeft)
    const top = coords.top + coords.lineHeight + TOOLBAR_VERTICAL_GAP
    setPosition({ left, top })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the anchor coordinates (which also flip to undefined when anchor becomes null); a new anchor object with the same x/y must not recompute the position
  }, [
    anchor?.x,
    anchor?.y,
    selectionRange.start,
    selectionRange.end,
    content,
    textareaRef,
  ])

  // Reset dropdown state whenever the selection changes.
  useEffect(() => {
    setShowHeadingMenu(false)
    setLinkInputVisible(false)
    setLinkUrl('')
  }, [selectionRange.start, selectionRange.end])

  useEffect(() => {
    if (linkInputVisible) {
      requestAnimationFrame(() => linkInputRef.current?.focus())
    }
  }, [linkInputVisible])

  if (!position) return null
  if (typeof document === 'undefined') return null

  const applyWrap = (prefix: string, suffix?: string) => {
    const result = wrapSelection(
      content,
      selectionRange.start,
      selectionRange.end,
      prefix,
      suffix ?? prefix,
    )
    onChange(result.next, result.selection)
  }

  const applyLinePrefix = (prefix: string) => {
    const result = prefixSelectedLines(
      content,
      selectionRange.start,
      selectionRange.end,
      prefix,
    )
    onChange(result.next, result.selection)
  }

  const applyOl = () => {
    const result = applyOrderedList(
      content,
      selectionRange.start,
      selectionRange.end,
    )
    onChange(result.next, result.selection)
  }

  const applyHeading = (level: 0 | 1 | 2 | 3) => {
    const result = setHeadingLevel(
      content,
      selectionRange.start,
      selectionRange.end,
      level,
    )
    onChange(result.next, result.selection)
    setShowHeadingMenu(false)
  }

  const confirmLink = () => {
    const url = linkUrl.trim()
    if (!url) {
      setLinkInputVisible(false)
      setLinkUrl('')
      return
    }
    const result = wrapAsLink(
      content,
      selectionRange.start,
      selectionRange.end,
      url,
    )
    onChange(result.next, result.selection)
    setLinkInputVisible(false)
    setLinkUrl('')
  }

  return createPortal(
    <div
      data-ready-md-toolbar=""
      data-ready-native-overlay=""
      role="toolbar"
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        zIndex: 999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
      }}
      onMouseDown={(e) => {
        // Prevent textarea blur on toolbar mousedown — but allow the link
        // input to receive focus naturally.
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT') return
        e.preventDefault()
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          background: 'color-mix(in srgb, var(--bg-primary, #FFFFFF) 90%, transparent)',
          border: '1px solid var(--surface-border, #E0E0E0)',
          borderRadius: 8,
          boxShadow: 'var(--surface-shadow, 0 2px 10px rgba(0,0,0,0.094))',
          padding: '4px 6px',
          height: TOOLBAR_HEIGHT,
          boxSizing: 'border-box',
        }}
      >
        <TbButton
          onClick={() => setShowHeadingMenu((v) => !v)}
          active={showHeadingMenu}
          title="标题"
        >
          <Type size={14} color={ICON_COLOR} />
          <ChevronDown
            size={10}
            color="var(--text-light, #999)"
            style={{ marginLeft: 1 }}
          />
        </TbButton>
        <Separator />
        <TbButton onClick={() => applyWrap('**')} title="加粗">
          <Bold size={14} color={ICON_COLOR} />
        </TbButton>
        <TbButton onClick={() => applyWrap('*')} title="斜体">
          <Italic size={14} color={ICON_COLOR} />
        </TbButton>
        <TbButton onClick={() => applyWrap('~~')} title="删除线">
          <Strikethrough size={14} color={ICON_COLOR} />
        </TbButton>
        <TbButton onClick={() => applyWrap('`')} title="行内代码">
          <Code2 size={14} color={ICON_COLOR} />
        </TbButton>
        <Separator />
        <TbButton
          onClick={() => setLinkInputVisible((v) => !v)}
          active={linkInputVisible}
          title="链接"
        >
          <LinkIcon size={14} color={ICON_COLOR} />
        </TbButton>
        <Separator />
        <TbButton onClick={() => applyLinePrefix('> ')} title="引用">
          <Quote size={14} color={ICON_COLOR} />
        </TbButton>
        <TbButton onClick={() => applyLinePrefix('- ')} title="无序列表">
          <List size={14} color={ICON_COLOR} />
        </TbButton>
        <TbButton onClick={() => applyOl()} title="有序列表">
          <ListOrdered size={14} color={ICON_COLOR} />
        </TbButton>
        <TbButton
          onClick={() => applyLinePrefix('- [ ] ')}
          title="任务列表"
        >
          <CheckSquare size={14} color={ICON_COLOR} />
        </TbButton>
      </div>

      {showHeadingMenu && (
        <div
          style={{
            background: 'color-mix(in srgb, var(--bg-primary, #FFFFFF) 90%, transparent)',
            border: '1px solid var(--surface-border, #E0E0E0)',
            borderRadius: 8,
            boxShadow: 'var(--surface-shadow, 0 2px 10px rgba(0,0,0,0.094))',
            padding: '4px 0',
            minWidth: 140,
          }}
        >
          <HeadingMenuItem label="正文" onClick={() => applyHeading(0)} />
          <HeadingMenuItem
            label="标题 1"
            onClick={() => applyHeading(1)}
            sample="H1"
            sampleSize={18}
          />
          <HeadingMenuItem
            label="标题 2"
            onClick={() => applyHeading(2)}
            sample="H2"
            sampleSize={16}
          />
          <HeadingMenuItem
            label="标题 3"
            onClick={() => applyHeading(3)}
            sample="H3"
            sampleSize={14}
          />
        </div>
      )}

      {linkInputVisible && (
        <div
          style={{
            background: 'color-mix(in srgb, var(--bg-primary, #FFFFFF) 90%, transparent)',
            border: '1px solid var(--surface-border, #E0E0E0)',
            borderRadius: 8,
            boxShadow: 'var(--surface-shadow, 0 2px 10px rgba(0,0,0,0.094))',
            padding: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <input
            ref={linkInputRef}
            type="text"
            placeholder="输入 URL,回车确认"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                confirmLink()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setLinkInputVisible(false)
                setLinkUrl('')
              }
            }}
            style={{
              border: '1px solid var(--border-default, #E0E0E0)',
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 13,
              width: 240,
              outline: 'none',
              background: 'var(--input-bg, #FFFFFF)',
              color: 'var(--text-body, #333)',
            }}
          />
        </div>
      )}
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

interface TbButtonProps {
  onClick?: () => void
  active?: boolean
  title?: string
  children: ReactNode
}

function TbButton({ onClick, active, title, children }: TbButtonProps): ReactNode {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 26,
        minWidth: 26,
        padding: '0 6px',
        border: 'none',
        borderRadius: 4,
        background: active
          ? 'var(--bg-hover-strong, rgba(0,0,0,0.08))'
          : hover
            ? 'var(--bg-hover, rgba(0,0,0,0.04))'
            : 'transparent',
        cursor: 'pointer',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </button>
  )
}

function Separator(): ReactNode {
  return (
    <div
      style={{
        width: 1,
        height: 18,
        background: 'var(--border-default, #E0E0E0)',
        flexShrink: 0,
        margin: '0 2px',
      }}
    />
  )
}

interface HeadingMenuItemProps {
  label: string
  onClick: () => void
  sample?: string
  sampleSize?: number
}

function HeadingMenuItem({
  label,
  onClick,
  sample,
  sampleSize = 14,
}: HeadingMenuItemProps): ReactNode {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        width: '100%',
        height: 30,
        padding: '0 12px',
        border: 'none',
        background: hover ? 'var(--bg-hover, rgba(0,0,0,0.04))' : 'transparent',
        cursor: 'pointer',
        fontSize: 13,
        color: 'var(--text-body, #333)',
        textAlign: 'left',
      }}
    >
      <span>{label}</span>
      {sample && (
        <span
          style={{
            fontWeight: 600,
            fontSize: sampleSize,
            color: 'var(--text-secondary, #666)',
          }}
        >
          {sample}
        </span>
      )}
    </button>
  )
}
