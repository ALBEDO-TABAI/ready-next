import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { readDocumentSource } from '../../../shared/document-operations'
import { parseReadyUri } from '../../../shared/ready-ref'
import type { ExtractedObjectLink, ObjectLinkKind } from '../../../shared/object-links'

export function linkTarget(rawTarget: string, kind: ObjectLinkKind, sourceLine: number | null, sourceOffset: number | null): ExtractedObjectLink {
  const hash = rawTarget.indexOf('#')
  return { kind, rawTarget, targetText: hash < 0 ? rawTarget : rawTarget.slice(0, hash),
    fragment: hash < 0 ? null : rawTarget.slice(hash + 1), sourceLine, sourceOffset }
}

/** Positions refer to original UTF-16 source, never normalized search text. */
export function extractObjectLinks(raw: string): ExtractedObjectLink[] {
  const result: ExtractedObjectLink[] = []
  let bodyStart = 0
  try { bodyStart = readDocumentSource(raw).bodyStart } catch { /* Malformed YAML remains searchable prose. */ }
  const lineAt = (offset: number) => raw.slice(0, offset).split('\n').length
  const extract = (text: string, start: number, frontmatter = false) => {
    const re = /(`+)[^\n]*?\1|(!?)\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]|(!?)\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|<?(ready:\/\/[^\s<>"')\]]+)>?/g
    for (const m of text.matchAll(re)) {
      if (m[1]) continue
      const target = (m[3] ?? m[6] ?? m[7]).trim()
      const parsed = parseReadyUri(target)
      const kind: ObjectLinkKind = frontmatter ? 'frontmatter'
        : m[2] || m[4] ? 'embed'
          : m[5] === '原文' && parsed.ok && parsed.ref.kind === 'book-location' ? 'annotation-source'
            : target.startsWith('ready://') ? 'ready-ref'
              : m[3] ? target.includes('#^') ? 'block-ref' : 'wikilink' : 'mdlink'
      result.push(linkTarget(target, kind, lineAt(start + m.index!), start + m.index!))
    }
  }
  if (bodyStart) {
    const opening = /^(?:\uFEFF)?---[^\n]*\n/.exec(raw)
    if (opening) {
      const end = raw.lastIndexOf('\n---', bodyStart)
      const yaml = parseDocument(raw.slice(opening[0].length, end))
      // Existing relation convention: explicit [[...]] / ready:// values, including arrays.
      // Plain metadata (title, tags, ready_project, etc.) never becomes a guessed link.
      const visit = (node: unknown): void => {
        if (isScalar(node) && typeof node.value === 'string' && node.range) extract(raw.slice(opening[0].length + node.range[0], opening[0].length + node.range[1]), opening[0].length + node.range[0], true)
        else if (isMap(node)) for (const pair of node.items) visit(pair.value)
        else if (isSeq(node)) for (const item of node.items) visit(item)
      }
      if (!yaml.errors.length) visit(yaml.contents)
    }
  }
  let offset = bodyStart, fence: string | null = null
  for (const line of raw.slice(bodyStart).match(/[^\n]*(?:\n|$)/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null }
    else if (!fence && !/^(?: {4}|\t)/.test(line)) extract(line, offset)
    offset += line.length
  }
  return result
}

/** Fragments select a location within an object; they do not change its rename binding. */
export function repairBinding(kind: string, rawTarget: string): { kind: string; rawTarget: string } {
  const wiki = ['wikilink', 'block-ref', 'embed', 'frontmatter'].includes(kind)
  return { kind: wiki ? 'wikilink' : kind, rawTarget: wiki ? rawTarget.split('#')[0] : rawTarget }
}
