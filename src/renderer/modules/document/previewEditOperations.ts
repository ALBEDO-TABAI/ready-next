import {
  normalizePreviewNoteText,
  type PreviewBlock,
  type PreviewBlockSourceRange,
} from '../../components/document/note-preview-parser'

/**
 * Pure text operations behind preview-edit mode (文档预览内编辑).
 *
 * All operations run on the SAME normalization the preview parser used
 * (`normalizePreviewNoteText`, CRLF→LF) because block source ranges refer to
 * offsets inside that normalized text. Every operation returns the full next
 * document text, or `null` when the block has no trustworthy source range —
 * callers must treat `null` as "not editable here", never fall back to a
 * guessed position.
 */

function isValidRange(text: string, range: PreviewBlockSourceRange | null | undefined): range is PreviewBlockSourceRange {
  return Boolean(
    range &&
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end >= range.start &&
    range.end <= text.length,
  )
}

/** Strip trailing newline runs (including whitespace-only lines). */
function trimEndNewlines(value: string): string {
  return value.replace(/(?:[ \t]*\n)+[ \t]*$/, '')
}

/** Strip leading newline runs (including whitespace-only lines). */
function trimStartNewlines(value: string): string {
  return value.replace(/^[ \t]*(?:\n[ \t]*)+/, '')
}

/** Trim blank lines around user-entered block text so range splices never double separators. */
function trimOuterBlankLines(value: string): string {
  return trimStartNewlines(trimEndNewlines(value))
}

interface RangeRemoval {
  text: string
  /** Map a position of the ORIGINAL text (outside the removed seam) to the new text. */
  mapPosition: (position: number) => number
}

/**
 * Remove a block's range together with the blank-line seam around it, keeping
 * the neighbours' separation as tight (single `\n`) or loose (blank line) as
 * it was in the source.
 */
function removeRangeWithSeam(text: string, range: PreviewBlockSourceRange): RangeRemoval {
  const before = text.slice(0, range.start)
  const afterRaw = text.slice(range.end)
  const left = trimEndNewlines(before)
  const afterLead = afterRaw.length - trimStartNewlines(afterRaw).length
  const rightStart = range.end + afterLead
  const right = text.slice(rightStart)

  const hadBlankBefore = /\n[ \t]*\n[ \t]*$/.test(before) || left.length === 0
  const hadBlankAfter = /^[ \t]*\n[ \t]*\n/.test(afterRaw) || right.length === 0
  const separator = left.length === 0 || right.length === 0
    ? ''
    : (hadBlankBefore || hadBlankAfter ? '\n\n' : '\n')

  const nextText = right.length === 0
    ? (left.length === 0 ? '' : `${left}\n`)
    : `${left}${separator}${right}`

  const mapPosition = (position: number): number => {
    if (position <= left.length) return position
    if (position >= rightStart) return left.length + separator.length + (position - rightStart)
    // Positions inside the removed seam have no image; clamp to the seam join.
    return left.length
  }

  return { text: nextText, mapPosition }
}

/** Insert `blockText` as a standalone blank-line-separated block before/after the target range. */
function insertBlockText(
  text: string,
  blockText: string,
  target: PreviewBlockSourceRange,
  position: 'before' | 'after',
): string {
  if (position === 'before') {
    const prefix = trimEndNewlines(text.slice(0, target.start))
    const rest = text.slice(target.start)
    return prefix.length === 0
      ? `${blockText}\n\n${rest}`
      : `${prefix}\n\n${blockText}\n\n${rest}`
  }

  const head = text.slice(0, target.end)
  const suffix = trimStartNewlines(text.slice(target.end))
  return suffix.length === 0
    ? `${head}\n\n${blockText}\n`
    : `${head}\n\n${blockText}\n\n${suffix}`
}

/** The raw source text a block spans, as the seed for in-place editing. */
export function getPreviewBlockSourceText(content: string, block: PreviewBlock): string | null {
  const text = normalizePreviewNoteText(content)
  if (!isValidRange(text, block.source)) return null
  return text.slice(block.source.start, block.source.end)
}

/**
 * Replace a block's source with user-entered text. Empty replacement removes
 * the block (seam-collapsed). Returns the full next document text.
 */
export function replacePreviewBlockSource(content: string, block: PreviewBlock, nextText: string): string | null {
  const text = normalizePreviewNoteText(content)
  if (!isValidRange(text, block.source)) return null
  const replacement = trimOuterBlankLines(normalizePreviewNoteText(nextText))
  if (replacement.trim().length === 0) {
    return removeRangeWithSeam(text, block.source).text
  }
  return `${text.slice(0, block.source.start)}${replacement}${text.slice(block.source.end)}`
}

/**
 * Move one block before/after another (preview-edit image drag). Both blocks
 * need valid, non-overlapping ranges; otherwise the move is refused.
 */
export function movePreviewBlockSource(
  content: string,
  movedBlock: PreviewBlock,
  targetBlock: PreviewBlock,
  position: 'before' | 'after',
): string | null {
  const text = normalizePreviewNoteText(content)
  const moved = movedBlock.source
  const target = targetBlock.source
  if (!isValidRange(text, moved) || !isValidRange(text, target)) return null
  if (moved.start === target.start && moved.end === target.end) return null
  const overlaps = moved.start < target.end && target.start < moved.end
  if (overlaps) return null

  const movedText = trimOuterBlankLines(text.slice(moved.start, moved.end))
  if (movedText.trim().length === 0) return null

  const removal = removeRangeWithSeam(text, moved)
  const adjustedTarget: PreviewBlockSourceRange = {
    start: removal.mapPosition(target.start),
    end: removal.mapPosition(target.end),
  }
  if (!isValidRange(removal.text, adjustedTarget)) return null
  return insertBlockText(removal.text, movedText, adjustedTarget, position)
}

/** Append a new paragraph at the end of the document (preview-edit "添加文字"). */
export function appendPreviewParagraph(content: string, text: string): string | null {
  const paragraph = trimOuterBlankLines(normalizePreviewNoteText(text))
  if (paragraph.trim().length === 0) return null
  const current = normalizePreviewNoteText(content)
  const head = trimEndNewlines(current)
  return head.length === 0 ? `${paragraph}\n` : `${head}\n\n${paragraph}\n`
}
