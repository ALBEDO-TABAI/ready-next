'use strict'

/**
 * Stage Q (Stage 11) — shared utility for cjs gate scripts.
 *
 * Replaces the contents of string / template literals AND line / block
 * comments with spaces, while preserving newline positions so byte
 * offsets in the result map back to the same line numbers as the
 * original source.
 *
 * This is intentionally a small state machine, not a full parser.
 * Limits (accepted):
 *   - JSX content inside `>...<` is treated as code (not strings)
 *   - regex literals are not separately tokenized; a /.../ immediately
 *     after `=` or `(` won't be confused with a block comment because
 *     the latter requires the slash-star sequence not just a slash
 *   - `${...}` template expressions return to code state and recursively
 *     re-enter the scanner; backtick-inside-expression is supported
 */
function stripCodeStringsAndComments(src) {
  const len = src.length
  const out = new Array(len)
  // Pre-fill with original chars so `code` segments are byte-identical.
  for (let i = 0; i < len; i++) out[i] = src[i]
  // States
  const STATE_CODE = 0
  const STATE_LINE_COMMENT = 1
  const STATE_BLOCK_COMMENT = 2
  const STATE_SQ = 3 // single-quote string
  const STATE_DQ = 4 // double-quote string
  const STATE_TMPL = 5 // template literal (backtick body)
  // Stack so `${...}` expressions can re-enter code, and nested templates work.
  const stack = [STATE_CODE]
  // Track template-expression brace depth per template frame so a `}` only
  // exits expression at depth 0.
  const exprDepthStack = []
  let i = 0
  function top() { return stack[stack.length - 1] }
  function blank(idx) {
    const ch = src[idx]
    if (ch === '\n') return // preserve newlines for line accounting
    out[idx] = ' '
  }
  while (i < len) {
    const state = top()
    const ch = src[i]
    const next = i + 1 < len ? src[i + 1] : ''
    switch (state) {
      case STATE_CODE: {
        if (ch === '/' && next === '/') {
          stack.push(STATE_LINE_COMMENT)
          blank(i); blank(i + 1)
          i += 2
          break
        }
        if (ch === '/' && next === '*') {
          stack.push(STATE_BLOCK_COMMENT)
          blank(i); blank(i + 1)
          i += 2
          break
        }
        if (ch === "'") {
          stack.push(STATE_SQ)
          blank(i)
          i += 1
          break
        }
        if (ch === '"') {
          stack.push(STATE_DQ)
          blank(i)
          i += 1
          break
        }
        if (ch === '`') {
          stack.push(STATE_TMPL)
          exprDepthStack.push(0)
          blank(i)
          i += 1
          break
        }
        // Track brace depth for any template expression below this code frame.
        if (exprDepthStack.length > 0) {
          const tlen = exprDepthStack.length - 1
          if (ch === '{') exprDepthStack[tlen] += 1
          else if (ch === '}') {
            if (exprDepthStack[tlen] > 0) {
              exprDepthStack[tlen] -= 1
            } else {
              // Closing the template expression — pop back into the surrounding TMPL state.
              // We popped CODE earlier when we entered ${; mirror that.
              // Blank the closing `}` so brace-counting in downstream
              // gates doesn't confuse it with a real code brace
              // (the matching opening `{` of `${` was already blanked).
              blank(i)
              exprDepthStack.pop()
              stack.pop() // pop CODE frame
              // We're now back in the TMPL state which remains on the stack.
              i += 1
              break
            }
          }
        }
        i += 1
        break
      }
      case STATE_LINE_COMMENT: {
        if (ch === '\n') {
          stack.pop()
          i += 1
        } else {
          blank(i)
          i += 1
        }
        break
      }
      case STATE_BLOCK_COMMENT: {
        if (ch === '*' && next === '/') {
          blank(i); blank(i + 1)
          stack.pop()
          i += 2
        } else {
          blank(i)
          i += 1
        }
        break
      }
      case STATE_SQ: {
        if (ch === '\\' && i + 1 < len) {
          blank(i); blank(i + 1)
          i += 2
        } else if (ch === "'") {
          blank(i)
          stack.pop()
          i += 1
        } else if (ch === '\n') {
          // Single-quote literals shouldn't span lines; if we see one,
          // bail safely back to code at the newline.
          stack.pop()
          i += 1
        } else {
          blank(i)
          i += 1
        }
        break
      }
      case STATE_DQ: {
        if (ch === '\\' && i + 1 < len) {
          blank(i); blank(i + 1)
          i += 2
        } else if (ch === '"') {
          blank(i)
          stack.pop()
          i += 1
        } else if (ch === '\n') {
          stack.pop()
          i += 1
        } else {
          blank(i)
          i += 1
        }
        break
      }
      case STATE_TMPL: {
        if (ch === '\\' && i + 1 < len) {
          blank(i); blank(i + 1)
          i += 2
        } else if (ch === '`') {
          blank(i)
          stack.pop()
          exprDepthStack.pop()
          i += 1
        } else if (ch === '$' && next === '{') {
          blank(i); blank(i + 1)
          stack.push(STATE_CODE)
          exprDepthStack.push(0)
          i += 2
        } else {
          blank(i)
          i += 1
        }
        break
      }
      default:
        i += 1
    }
  }
  return out.join('')
}

function indexToLine(src, idx) {
  let line = 1
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src[i] === '\n') line++
  }
  return line
}

/**
 * Strip ONLY comments (line + block), preserving string and template
 * literal contents intact. Use this when scanning for patterns that
 * legitimately appear inside string content (e.g. import path strings
 * `from '../foo'` — the `'../foo'` body must be preserved for matching).
 *
 * Uses the same state machine but does NOT blank string/template
 * literal characters.
 */
function stripCommentsOnly(src) {
  const len = src.length
  const out = new Array(len)
  for (let i = 0; i < len; i++) out[i] = src[i]
  const STATE_CODE = 0
  const STATE_LINE_COMMENT = 1
  const STATE_BLOCK_COMMENT = 2
  const STATE_SQ = 3
  const STATE_DQ = 4
  const STATE_TMPL = 5
  const stack = [STATE_CODE]
  const exprDepthStack = []
  let i = 0
  function top() { return stack[stack.length - 1] }
  function blank(idx) {
    if (src[idx] === '\n') return
    out[idx] = ' '
  }
  while (i < len) {
    const state = top()
    const ch = src[i]
    const next = i + 1 < len ? src[i + 1] : ''
    switch (state) {
      case STATE_CODE: {
        if (ch === '/' && next === '/') { stack.push(STATE_LINE_COMMENT); blank(i); blank(i + 1); i += 2; break }
        if (ch === '/' && next === '*') { stack.push(STATE_BLOCK_COMMENT); blank(i); blank(i + 1); i += 2; break }
        if (ch === "'") { stack.push(STATE_SQ); i += 1; break }
        if (ch === '"') { stack.push(STATE_DQ); i += 1; break }
        if (ch === '`') { stack.push(STATE_TMPL); exprDepthStack.push(0); i += 1; break }
        if (exprDepthStack.length > 0) {
          const tlen = exprDepthStack.length - 1
          if (ch === '{') exprDepthStack[tlen] += 1
          else if (ch === '}') {
            if (exprDepthStack[tlen] > 0) exprDepthStack[tlen] -= 1
            else { exprDepthStack.pop(); stack.pop(); i += 1; break }
          }
        }
        i += 1; break
      }
      case STATE_LINE_COMMENT: {
        if (ch === '\n') { stack.pop(); i += 1 } else { blank(i); i += 1 }
        break
      }
      case STATE_BLOCK_COMMENT: {
        if (ch === '*' && next === '/') { blank(i); blank(i + 1); stack.pop(); i += 2 }
        else { blank(i); i += 1 }
        break
      }
      case STATE_SQ: {
        if (ch === '\\' && i + 1 < len) { i += 2 }
        else if (ch === "'") { stack.pop(); i += 1 }
        else if (ch === '\n') { stack.pop(); i += 1 }
        else { i += 1 }
        break
      }
      case STATE_DQ: {
        if (ch === '\\' && i + 1 < len) { i += 2 }
        else if (ch === '"') { stack.pop(); i += 1 }
        else if (ch === '\n') { stack.pop(); i += 1 }
        else { i += 1 }
        break
      }
      case STATE_TMPL: {
        if (ch === '\\' && i + 1 < len) { i += 2 }
        else if (ch === '`') { stack.pop(); exprDepthStack.pop(); i += 1 }
        else if (ch === '$' && next === '{') { stack.push(STATE_CODE); exprDepthStack.push(0); i += 2 }
        else { i += 1 }
        break
      }
      default: i += 1
    }
  }
  return out.join('')
}

/**
 * Build a per-byte boolean array: `result[i] === true` iff the byte at
 * index `i` of `src` is inside a string OR template literal body
 * (NOT inside `${...}` expressions, which return to code state).
 *
 * Used by gate scanners that need to keep string contents visible (for
 * import-path matching) but still want to ignore matches that are
 * actually inside a literal string of the original source.
 *
 * Only positions inside the literal body are flagged true; the
 * delimiters (`'`, `"`, `` ` ``) themselves are flagged false. Comments
 * are also flagged false.
 */
function buildIsInsideStringMask(src) {
  const len = src.length
  const mask = new Array(len).fill(false)
  const STATE_CODE = 0
  const STATE_LINE_COMMENT = 1
  const STATE_BLOCK_COMMENT = 2
  const STATE_SQ = 3
  const STATE_DQ = 4
  const STATE_TMPL = 5
  const stack = [STATE_CODE]
  const exprDepthStack = []
  let i = 0
  function top() { return stack[stack.length - 1] }
  while (i < len) {
    const state = top()
    const ch = src[i]
    const next = i + 1 < len ? src[i + 1] : ''
    switch (state) {
      case STATE_CODE: {
        if (ch === '/' && next === '/') { stack.push(STATE_LINE_COMMENT); i += 2; break }
        if (ch === '/' && next === '*') { stack.push(STATE_BLOCK_COMMENT); i += 2; break }
        if (ch === "'") { stack.push(STATE_SQ); i += 1; break }
        if (ch === '"') { stack.push(STATE_DQ); i += 1; break }
        if (ch === '`') { stack.push(STATE_TMPL); exprDepthStack.push(0); i += 1; break }
        if (exprDepthStack.length > 0) {
          const tlen = exprDepthStack.length - 1
          if (ch === '{') exprDepthStack[tlen] += 1
          else if (ch === '}') {
            if (exprDepthStack[tlen] > 0) exprDepthStack[tlen] -= 1
            else { exprDepthStack.pop(); stack.pop(); i += 1; break }
          }
        }
        i += 1; break
      }
      case STATE_LINE_COMMENT: {
        if (ch === '\n') { stack.pop() }
        i += 1; break
      }
      case STATE_BLOCK_COMMENT: {
        if (ch === '*' && next === '/') { stack.pop(); i += 2 }
        else { i += 1 }
        break
      }
      case STATE_SQ: {
        if (ch === '\\' && i + 1 < len) { mask[i] = true; mask[i + 1] = true; i += 2 }
        else if (ch === "'") { stack.pop(); i += 1 }
        else if (ch === '\n') { stack.pop(); i += 1 }
        else { mask[i] = true; i += 1 }
        break
      }
      case STATE_DQ: {
        if (ch === '\\' && i + 1 < len) { mask[i] = true; mask[i + 1] = true; i += 2 }
        else if (ch === '"') { stack.pop(); i += 1 }
        else if (ch === '\n') { stack.pop(); i += 1 }
        else { mask[i] = true; i += 1 }
        break
      }
      case STATE_TMPL: {
        if (ch === '\\' && i + 1 < len) { mask[i] = true; mask[i + 1] = true; i += 2 }
        else if (ch === '`') { stack.pop(); exprDepthStack.pop(); i += 1 }
        else if (ch === '$' && next === '{') { stack.push(STATE_CODE); exprDepthStack.push(0); i += 2 }
        else { mask[i] = true; i += 1 }
        break
      }
      default: i += 1
    }
  }
  return mask
}

module.exports = {
  stripCodeStringsAndComments,
  stripCommentsOnly,
  indexToLine,
  buildIsInsideStringMask,
}
