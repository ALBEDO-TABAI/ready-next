import { projectView, type DatabaseDefinition, type DatabaseRequest, type DatabaseRow, type DatabaseView } from '../../shared/document-database'

const viewTypes: DatabaseView['type'][] = ['table', 'board', 'calendar', 'timeline', 'gallery', 'list', 'bookshelf']
export const definition: DatabaseDefinition = {
  version: 1, source: '库', fields: {
    文本: { id: 'text', name: '文本', type: 'text' }, 分数: { id: 'score', name: '分数', type: 'number' },
    状态: { id: 'status', name: '状态', type: 'select', options: ['待办', '完成'] },
    标签: { id: 'tags', name: '标签', type: 'multi_select', options: ['甲', '乙', '丙'] },
    日期: { id: 'date', name: '日期', type: 'date' }, 勾选: { id: 'check', name: '勾选', type: 'checkbox' },
    网址: { id: 'url', name: '网址', type: 'url' }, 关联: { id: 'relation', name: '关联', type: 'relation' },
    双倍: { id: 'formula', name: '双倍', type: 'formula', expression: 'prop("score") * 2' },
  },
  views: viewTypes.map(type => ({
    id: type, name: type, type, groupBy: type === 'board' ? 'status' : undefined,
    dateField: 'date', cardFields: ['text', 'score'],
  })),
}
export function memoryAPI(count = 2) {
  let def = structuredClone(definition), version = 'v1', state = {}
  const rows: DatabaseRow[] = Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, title: `页面${i}`, version: `r${i}`, values: { 文本: '原文', 分数: i + 1, 状态: '待办', 标签: ['甲', '乙'], 日期: { start: '2026-10-15', end: '2026-10-17' }, 类型: '书' } }))
  const calls: DatabaseRequest[] = []
  const api = {
    request: async (request: DatabaseRequest) => {
      calls.push(structuredClone(request))
      switch (request.type) {
        case 'read': return { ok: true as const, value: { databaseId: 'db', definition: def, version, rows } }
        case 'query': return { ok: true as const, value: { databaseId: 'db', version, ...projectView(def, rows, def.views.find(v => v.id === request.viewId)!, {}, { offset: request.offset ?? 0, limit: request.limit ?? 1000 }) } }
        case 'getState': return { ok: true as const, value: state }
        case 'setState': state = request.state; return { ok: true as const, value: state }
        case 'setFields': {
          const row = rows.find(r => r.id === request.rowId)!
          if (row.version !== request.expectedVersion) return { ok: false as const, code: 'version_conflict', message: '版本冲突' }
          for (const [id, value] of Object.entries(request.set)) row.values[Object.entries(def.fields).find(([, f]) => f.id === id)![0]] = value
          row.version += 'x'; return { ok: true as const, value: { state: 'saved', afterVersion: row.version } }
        }
        case 'setDefinition': def = request.definition; version += 'x'; return { ok: true as const, value: { state: 'saved', afterVersion: version } }
        case 'createRow': rows.push({ id: request.operationId, title: request.title, version: 'new', values: {} }); return { ok: true as const, value: { state: 'committed', objectId: request.operationId } }
        default: throw new Error(`Unexpected ${request.type}`)
      }
    },
    pages: async () => [{ id: 'target', title: '目标页', reference: '[[目标页]]' }],
    openRow: async (_id: string) => {},
  }
  return { api, calls, rows }
}

