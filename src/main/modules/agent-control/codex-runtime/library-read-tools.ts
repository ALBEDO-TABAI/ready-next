import { z } from 'zod'

const common = { resourceId: z.string().min(1), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/) }
const page = { offset: z.number().int().nonnegative().safe(), limit: z.number().int().min(1).max(100) }
const text = { offset: page.offset, length: z.number().int().min(1).max(12000) }
export const LIBRARY_READ_SCHEMAS = {
  library_list_pages: z.object({ ...common, ...page }).strict(),
  library_read_page: z.object({ ...common, ...text }).strict(),
  library_read_database: z.object(common).strict(),
  library_query_database: z.object({ ...common, ...page, viewId: z.string().min(1) }).strict(),
  library_read_board: z.object({ ...common, ...page }).strict(),
  library_read_book: z.object({ ...common, ...text }).strict(),
  library_read_highlights: z.object({ ...common, ...page }).strict(),
  library_query_links: z.object({ ...common, ...page, direction: z.enum(['outgoing', 'incoming']) }).strict(),
  library_read_calendar: z.object({ ...common, ...page }).strict(),
}
export type LibraryReadTool = keyof typeof LIBRARY_READ_SCHEMAS
export const LIBRARY_READ_TOOL_NAMES = Object.keys(LIBRARY_READ_SCHEMAS) as LibraryReadTool[]
export function isLibraryReadTool(name: string): name is LibraryReadTool { return Object.hasOwn(LIBRARY_READ_SCHEMAS, name) }
export function libraryReadToolSchemas(format: 'anthropic' | 'openai'): Array<Record<string, unknown>> {
  return LIBRARY_READ_TOOL_NAMES.map(name => {
    const parameters = z.toJSONSchema(LIBRARY_READ_SCHEMAS[name])
    const description = `${name}: 只读取本轮显式选择的资源；expectedVersion 使用资源回执版本。分页 complete 仅指授权范围，关系不会授权目标正文。`
    return format === 'anthropic' ? { name, description, input_schema: parameters }
      : { type: 'function', function: { name, description, parameters } }
  })
}
export const LIBRARY_READ_ACTIONS: Readonly<Record<LibraryReadTool, string>> = {
  library_list_pages: 'library.listPages', library_read_page: 'library.readPage',
  library_read_database: 'library.readDatabase', library_query_database: 'library.queryDatabase',
  library_read_board: 'library.readBoard', library_read_book: 'library.readBook',
  library_read_highlights: 'library.readHighlights', library_query_links: 'library.queryLinks',
  library_read_calendar: 'library.readCalendar',
}

export function parseLibraryReadCall(tool: LibraryReadTool, raw: unknown) {
  switch (tool) {
    case 'library_list_pages': return { tool, ...LIBRARY_READ_SCHEMAS.library_list_pages.parse(raw) }
    case 'library_read_page': return { tool, ...LIBRARY_READ_SCHEMAS.library_read_page.parse(raw) }
    case 'library_read_database': return { tool, ...LIBRARY_READ_SCHEMAS.library_read_database.parse(raw) }
    case 'library_query_database': return { tool, ...LIBRARY_READ_SCHEMAS.library_query_database.parse(raw) }
    case 'library_read_board': return { tool, ...LIBRARY_READ_SCHEMAS.library_read_board.parse(raw) }
    case 'library_read_book': return { tool, ...LIBRARY_READ_SCHEMAS.library_read_book.parse(raw) }
    case 'library_read_highlights': return { tool, ...LIBRARY_READ_SCHEMAS.library_read_highlights.parse(raw) }
    case 'library_query_links': return { tool, ...LIBRARY_READ_SCHEMAS.library_query_links.parse(raw) }
    case 'library_read_calendar': return { tool, ...LIBRARY_READ_SCHEMAS.library_read_calendar.parse(raw) }
  }
}
