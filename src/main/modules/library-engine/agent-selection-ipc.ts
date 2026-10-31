import type { IpcMain } from 'electron'
import { z } from 'zod'
import { assertBoundary } from '../../../shared/document-blocks/positions'
import { toReadyUri } from '../../../shared/ready-ref'
import type { LibraryResourceSelection } from '../../../shared/ipc-contracts/agent-runtime'
import type { LibraryResult } from '../../../shared/library'
import type { LibrarySelectionRequest } from '../../../renderer/modules/agent/libraryResourceSelection'
import type { LibraryReadResources } from '../agent-control/codex-runtime/library-read-resources'
import { libraryHash } from '../agent-control/codex-runtime/library-read-sources'

const identity = { id: z.string().min(1), name: z.string().min(1).max(300) }
const item = z.object({ ...identity, target: z.union([
  z.object({ objectId: z.string().min(1) }).strict(), z.object({ path: z.string().min(1) }).strict(),
]) }).strict()
const requestSchema: z.ZodType<LibrarySelectionRequest> = z.discriminatedUnion('kind', [
  item.extend({ kind: z.literal('board'), nodeIds: z.array(z.string().min(1)).min(1).max(1000) }),
  z.object({ ...identity, kind: z.literal('book'), bookId: z.string().min(1), location: z.object({
    chapter: z.number().int().nonnegative().safe(), from: z.number().int().nonnegative().safe(), to: z.number().int().positive().safe(),
  }).strict() }).strict(),
  item.extend({ kind: z.literal('database'), rows: z.array(item).max(1000) }),
])

/** Only registered objects and existing read admission are used; preparation never grants a turn permission. */
export function registerLibraryAgentSelectionIPC(ipcMain: Pick<IpcMain, 'handle'>, resolve: () => Promise<LibraryReadResources>): void {
  ipcMain.handle('library:prepareAgentSelection', async (_event, raw: unknown): Promise<LibraryResult<LibraryResourceSelection[]>> => {
    try {
      const request = requestSchema.parse(raw), reader = await resolve(), sources = reader.sources
      const object = (target: z.infer<typeof item>['target']) => {
        const id = 'objectId' in target ? target.objectId : sources.registry.find(target.path)?.id
        if (!id) throw new Error('资料尚未登记，请重新打开后选择。')
        return sources.object(id)
      }
      const base = { id: request.id, name: request.name, libraryId: sources.libraryId }
      let selections: LibraryResourceSelection[]
      if (request.kind === 'board') {
        const source = object(request.target)
        selections = [{ ...base, kind: 'board_selection', uri: toReadyUri({ kind: 'canvas', id: source.object.id }), version: source.version, nodeIds: request.nodeIds }]
      } else if (request.kind === 'book') {
        const book = await sources.book(request.bookId), { chapter, from, to } = request.location
        const text = book.chapters[chapter]?.text
        if (text === undefined || from >= to) throw new Error('书内位置无效。')
        // Reader positions count non-whitespace UTF-16 units; admission counts all chapter text units.
        const offsets: number[] = []
        for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) offsets.push(i)
        if (to > offsets.length) throw new Error('书内位置已变化，请重新选择。')
        const start = offsets[from], end = offsets[to - 1] + 1
        assertBoundary(text, start); assertBoundary(text, end)
        selections = [{ ...base, kind: 'book_location', uri: toReadyUri({ kind: 'book-location', book: request.bookId, loc: `c${chapter}:${start}+${end - start}` }), version: book.version, chapter, range: { start, end } }]
      } else {
        const page = (input: z.infer<typeof item>, access: 'database' | 'text'): Extract<LibraryResourceSelection, { kind: 'document_selection' }> => {
          const source = object(input.target)
          if (source.object.kind !== 'markdown') throw new Error('请选择完整的数据库页面。')
          return { id: input.id, name: input.name, libraryId: sources.libraryId, kind: 'document_selection',
            target: { kind: 'object', uri: toReadyUri({ kind: 'page', id: source.object.id }) }, version: source.version,
            range: { start: 0, end: source.content.length }, summary: { characters: source.content.length, digest: libraryHash(source.content) }, access }
        }
        const database = object(request.target), rows = request.rows.map(row => object(row.target))
        if (new Set(rows.map(row => row.object.id)).size !== rows.length
          || sources.database(database.object.id, rows.map(row => ({ id: row.object.id, version: row.version }))).rows.length !== rows.length) throw new Error('请选择此数据库中互不重复的完整行页面。')
        selections = [page(request, 'database'), ...request.rows.map(row => page(row, 'text'))]
      }
      const grants = await Promise.all(selections.map(selection => reader.admit(selection)))
      return { success: true, data: grants.map(grant => grant.selection) }
    } catch {
      // silent-catch: IPC exposes a fixed actionable error, never raw parser details, paths or content.
      return { success: false, error: '无法引用所选资料：资料已变化、选择无效或不在当前资料库中，请保存后重新选择。' }
    }
  })
}
