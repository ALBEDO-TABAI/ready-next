import { z } from 'zod'
import { extname } from 'node:path'
import { libraryResourceSelectionSchema, type LibraryResourceSelection } from '../../../../shared/ipc-contracts/agent-runtime'
import { parseReadyUri } from '../../../../shared/ready-ref'
import { ReadyCanvasSchema } from '../../../../shared/ready-canvas'
import { parseHighlights } from '../../library-engine/highlight-markdown'
import { libraryHash, libraryFailure, LibraryReadSources } from './library-read-sources'
import { parseLibraryReadCall, type LibraryReadTool } from './library-read-tools'
import type { ResourceVersionReference } from './codex-turn-input-builder'

type LibraryReadSelection = LibraryResourceSelection
export const libraryGrantSchema = z.object({ selection: libraryResourceSelectionSchema, version: z.string().regex(/^[a-f0-9]{64}$/), linksVersion: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
export type LibraryGrant = z.infer<typeof libraryGrantSchema>
export function libraryTools(selection: LibraryReadSelection): LibraryReadTool[] {
  switch (selection.kind) {
    case 'document_selection': return selection.access === 'database' ? ['library_read_database', 'library_query_database']
      : selection.access === 'highlights' ? ['library_read_highlights'] : ['library_list_pages', 'library_read_page', 'library_query_links']
    case 'board_selection': return ['library_read_board']
    case 'book_location': return ['library_read_book']
    case 'calendar_day': return ['library_read_calendar']
  }
}
export function libraryResourceVersion(grant: LibraryGrant): ResourceVersionReference {
  const digest = libraryHash(JSON.stringify(grant))
  return { logicalResourceId: grant.selection.id, currentVersion: `sha256:${digest}`, currentDigest: digest, supersedesVersion: null, policyEpoch: 1 }
}
export function libraryBindingsMatch(grants: readonly LibraryGrant[], refs: readonly ResourceVersionReference[], tools: readonly string[]): boolean {
  return new Set(grants.map(g => g.selection.id)).size === grants.length && grants.every(grant => {
    const expected = libraryResourceVersion(grant), matching = refs.filter(r => r.logicalResourceId === expected.logicalResourceId)
    return matching.length === 1 && matching[0].currentVersion === expected.currentVersion && matching[0].currentDigest === expected.currentDigest
      && matching[0].policyEpoch === 1 && libraryTools(grant.selection).every(tool => tools.includes(tool))
  })
}
function objectId(selection: LibraryReadSelection): string {
  const uri = selection.kind === 'document_selection' ? selection.target.kind === 'object' ? selection.target.uri : '' : 'uri' in selection ? selection.uri : ''
  const parsed = parseReadyUri(uri)
  if (!parsed.ok) libraryFailure()
  const ref = parsed.ref
  if (selection.kind === 'document_selection' && (ref.kind === 'page' || ref.kind === 'file') && !ref.anchor) return ref.id
  if (selection.kind === 'board_selection' && ref.kind === 'canvas' && (!ref.node || selection.nodeIds.length === 1 && selection.nodeIds[0] === ref.node)) return ref.id
  if (selection.kind === 'book_location' && ref.kind === 'book-location' && ref.loc === `c${selection.chapter}:${selection.range.start}+${selection.range.end - selection.range.start}`) return ref.book
  return libraryFailure()
}
function sliceRange(content: string, range: { start: number; end: number }): string {
  if (range.start > range.end || range.end > content.length) libraryFailure()
  return content.slice(range.start, range.end)
}
function paginate<T>(items: T[], offset: number, limit: number) {
  if (offset > items.length) libraryFailure()
  const end = Math.min(offset + limit, items.length)
  return { items: items.slice(offset, end), offset, nextOffset: end < items.length ? end : null, total: items.length, complete: end === items.length }
}

export class LibraryReadResources {
  constructor(readonly sources: LibraryReadSources) {}
  private async snapshot(selection: LibraryReadSelection) {
    if (selection.libraryId !== this.sources.libraryId) libraryFailure()
    if (selection.kind === 'calendar_day') return { kind: 'calendar' as const, ...this.sources.day(selection) }
    if (selection.kind === 'document_selection') {
      if (selection.buffer) libraryFailure()
      let source: { content: string; version: string }
      if (selection.target.kind === 'object') {
        const object = this.sources.object(objectId(selection)), parsed = parseReadyUri(selection.target.uri)
        if (!parsed.ok || object.object.kind === 'canvas' || object.object.kind === 'directory'
          || parsed.ref.kind === 'page' && object.object.kind !== 'markdown'
          || !['.md', '.markdown', '.txt'].includes(extname(object.path).toLowerCase())) libraryFailure()
        source = object
      } else source = this.sources.draft(selection.target.draftId)
      if (source.version !== selection.version) libraryFailure()
      const text = sliceRange(source.content, selection.range)
      if (text.length !== selection.summary.characters || libraryHash(text) !== selection.summary.digest) libraryFailure()
      if (selection.access !== 'text' && (selection.target.kind !== 'object' || selection.range.start !== 0 || selection.range.end !== source.content.length)) libraryFailure()
      if (selection.access === 'database') this.sources.database(objectId(selection), [])
      return { kind: 'text' as const, text, version: source.version }
    }
    if (selection.kind === 'board_selection') {
      if (new Set(selection.nodeIds).size !== selection.nodeIds.length) libraryFailure()
      const source = this.sources.object(objectId(selection))
      if (source.object.kind !== 'canvas' || source.version !== selection.version) libraryFailure()
      const canvas = ReadyCanvasSchema.parse(JSON.parse(source.content))
      const nodes = selection.nodeIds.map(id => {
        const found = canvas.nodes.filter(n => n.id === id && !n.ready.trash)
        if (found.length !== 1) libraryFailure()
        return found[0]
      })
      const edges = canvas.edges.filter(e => selection.nodeIds.includes(e.fromNode) && selection.nodeIds.includes(e.toNode))
      return { kind: 'board' as const, nodes, edges, version: source.version }
    }
    const book = await this.sources.book(objectId(selection)), chapter = book.chapters[selection.chapter]
    if (book.version !== selection.version || !chapter) libraryFailure()
    return { kind: 'text' as const, text: sliceRange(chapter.text, selection.range), version: book.version }
  }
  async admit(raw: unknown): Promise<LibraryGrant> {
    try {
      const selection = libraryResourceSelectionSchema.parse(raw)
      const snapshot = await this.snapshot(selection)
      const linksVersion = selection.kind === 'document_selection' && selection.access === 'text' && selection.target.kind === 'object'
        ? libraryHash(JSON.stringify([this.sources.links(objectId(selection), 'outgoing'), this.sources.links(objectId(selection), 'incoming')])) : undefined
      return { selection, version: snapshot.version, ...(linksVersion ? { linksVersion } : {}) }
    } catch {
      // silent-catch: return a fixed resource failure without disclosing filesystem paths or content.
      return libraryFailure()
    }
  }
  async execute(tool: LibraryReadTool, raw: unknown, grants: readonly LibraryGrant[]): Promise<Record<string, unknown>> {
    try {
      const args = parseLibraryReadCall(tool, raw)
      const matching = grants.filter(g => g.selection.id === args.resourceId)
      if (matching.length !== 1) libraryFailure()
      const grant = libraryGrantSchema.parse(matching[0]), selection = grant.selection
      if (args.expectedVersion !== grant.version || !libraryTools(selection).includes(tool)) libraryFailure()
      const current = await this.snapshot(selection)
      if (current.version !== grant.version) libraryFailure()
      const common = { ok: true, version: grant.version, scope: selection, coverage: 'selected_objects' }
      if (args.tool === 'library_read_page' || args.tool === 'library_read_book') {
        if (current.kind !== 'text' || !('length' in args)) libraryFailure()
        const text = current.text
        if (args.offset > text.length) libraryFailure()
        const end = Math.min(args.offset + args.length, text.length)
        return { ...common, text: text.slice(args.offset, end), offset: args.offset, nextOffset: end < text.length ? end : null, total: text.length, complete: end === text.length }
      }
      if (args.tool === 'library_read_database') {
        const database = this.sources.database(objectId(selection), [])
        return { ...common, definition: database.definition, items: [], offset: 0, nextOffset: null, total: 0, complete: true }
      }
      if (!('limit' in args)) libraryFailure()
      if (args.tool === 'library_list_pages') {
        const items: Array<{ id: string; target: Extract<LibraryResourceSelection, { kind: 'document_selection' }>['target']; name: string; version: string }> = []
        for (const candidate of grants) if (candidate.selection.kind === 'document_selection' && candidate.selection.access === 'text') {
          await this.admit(candidate.selection)
          items.push({ id: candidate.selection.id, target: candidate.selection.target, name: candidate.selection.name, version: candidate.version })
        }
        return { ...common, ...paginate(items, args.offset, args.limit) }
      }
      if (args.tool === 'library_read_board' && current.kind === 'board') {
        const page = paginate(current.nodes, args.offset, args.limit), ids = page.items.map(n => n.id)
        return { ...common, ...page, edges: current.edges.filter(e => ids.includes(e.fromNode)), edgesComplete: page.complete }
      }
      if (args.tool === 'library_read_calendar' && current.kind === 'calendar') return { ...common, ...paginate<unknown>(current.items, args.offset, args.limit) }
      if (args.tool === 'library_read_highlights' && current.kind === 'text') return { ...common, ...paginate(parseHighlights(current.text, objectId(selection)).map(h => h.highlight), args.offset, args.limit) }
      if (args.tool === 'library_query_database' && 'viewId' in args) {
        const rows: Array<{ id: string; version: string }> = []
        for (const candidate of grants) {
          const row = candidate.selection
          if (row.kind !== 'document_selection' || row.access !== 'text' || row.target.kind !== 'object') continue
          await this.admit(row)
          const id = objectId(row), source = this.sources.object(id)
          if (row.range.start === 0 && row.range.end === source.content.length) rows.push({ id, version: source.version })
        }
        const result = this.sources.query(objectId(selection), rows, args.viewId, args.offset, args.limit)
        if (args.offset > result.total) libraryFailure()
        const end = args.offset + result.rows.length
        return { ...common, ...result, items: result.rows, offset: args.offset, nextOffset: end < result.total ? end : null, complete: end === result.total }
      }
      if (args.tool === 'library_query_links' && 'direction' in args && selection.kind === 'document_selection') {
        const id = objectId(selection), source = this.sources.object(id)
        if (selection.range.start !== 0 || selection.range.end !== source.content.length) libraryFailure()
        const outgoing = this.sources.links(id, 'outgoing'), incoming = this.sources.links(id, 'incoming')
        if (libraryHash(JSON.stringify([outgoing, incoming])) !== grant.linksVersion) libraryFailure()
        const items = args.direction === 'outgoing' ? outgoing : incoming
        return { ...common, ...paginate(items, args.offset, args.limit), relationsVersion: grant.linksVersion, relationScope: 'registered_objects_in_selected_library', targetsAuthorized: false }
      }
      return libraryFailure()
    } catch {
      // silent-catch: return a fixed resource failure without disclosing filesystem paths or content.
      return libraryFailure()
    }
  }
}
