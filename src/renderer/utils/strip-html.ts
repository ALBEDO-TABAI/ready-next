/**
 * Minimal HTML → plain-text helper for renderer-only use.
 *
 * Wired by team L5-B-RSS-Time-Detection. The RSS reader uses this to
 * feed `electronAPI.calendar.detectTimeExpressions(...)` a body that
 * chrono-node can scan without tripping on tags / entities.
 *
 * Behavior:
 *   - Uses `DOMParser` when available (always true in the renderer);
 *     falls back to a regex strip for environments that don't have
 *     one (e.g. host-Node tests). The regex fallback is intentionally
 *     simple — it strips tag bodies but does NOT decode HTML entities
 *     beyond a small common set, which is OK because the consumer
 *     only does pattern matching on dates and we already drop tag
 *     internals before any text reaches chrono-node.
 *   - Collapses runs of whitespace into a single space — chrono-node
 *     is happy with that, and the offsets it returns map back to the
 *     normalised string (not the original HTML). Callers that need
 *     to highlight matches in the *original* HTML must do their own
 *     offset translation; the RSS hint just shows the matched
 *     substring verbatim so this is fine.
 *
 * Not exported as a general-purpose sanitizer: there is no XSS
 * protection here. It's strictly an extraction helper for downstream
 * NLP and must not be used to render untrusted HTML.
 */

const COMMON_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
}

function decodeCommonEntities(text: string): string {
  return text.replace(/&[a-z#0-9]+;/gi, (entity) => {
    const lower = entity.toLowerCase()
    return Object.prototype.hasOwnProperty.call(COMMON_ENTITIES, lower)
      ? COMMON_ENTITIES[lower]
      : entity
  })
}

function regexStrip(html: string): string {
  // Drop <script> / <style> bodies entirely so their JS / CSS contents
  // don't bleed into the extracted text.
  const noScript = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
  const noStyle = noScript.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
  // Replace every remaining tag with a single space so adjacent text
  // nodes don't get glued together.
  const noTags = noStyle.replace(/<[^>]+>/g, ' ')
  return decodeCommonEntities(noTags).replace(/\s+/g, ' ').trim()
}

export function stripHtml(html: string | null | undefined): string {
  if (typeof html !== 'string' || html.length === 0) return ''
  if (typeof DOMParser === 'undefined') return regexStrip(html)
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    // Drop <script> / <style> nodes before reading textContent so their
    // bodies don't leak into the plain-text output.
    doc.querySelectorAll('script,style').forEach((node) => node.remove())
    const text = doc.body?.textContent ?? ''
    return text.replace(/\s+/g, ' ').trim()
  } catch {
    return regexStrip(html)
  }
}
