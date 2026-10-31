import JSZip from 'jszip'
const id = (char: string) => char.repeat(32)
export const paths = { home: `首页 ${id('a')}`, child: `子页 ${id('b')}`, database: `任务 ${id('c')}`, row: `事项 ${id('d')}` }
export async function notionFixture() {
  const zip = new JSZip(), { home, child, database, row } = paths
  zip.file(`${home}.md`, `# 首页\n\n- 列表\n\n> 引用\n\n<aside>💡 提醒\n第二行</aside>\n\n<details><summary>展开</summary>\n隐藏内容\n</details>\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n\`\`\`md\n[不转换](missing.md)\n\`\`\`\n\n[子页](${encodeURI(`${home}/${child}.md`)})\n![图片](${encodeURI(`${home}/image.png`)})\n![缺失](${encodeURI(`${home}/missing.png`)})\n`)
  zip.file(`${home}/${child}.md`, '# 子页\n\n内容不变\n')
  zip.file(`${home}/image.png`, Buffer.from([137, 80, 78, 71, 1, 2, 3]))
  zip.file(`${home}/同名 ${id('e')}.md`, '# 同名\n第一份')
  zip.file(`${home}/同名 ${id('f')}.md`, '# 同名\n第二份')
  zip.file(`${database}.csv`, 'Name,编号,备注\r\n事项,00123,"逗号,换行\n第二行"\r\n只有行,00000,保留\r\n')
  zip.file(`${database}/${row}.md`, '# 事项\n\n行页面正文\n')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
export function inkwellFixture() {
  const base = (id: string, type: string, parent: string, title: string, content: string[] = [], props = {}) => ({ id, type, parent, parentTable: parent === 'space' ? 'space' : 'block', title: [[title]], content, props, alive: true, created: 1700000000000, edited: 1700000000000 })
  const schema = { title: { name: '标题', type: 'title' }, n: { name: '数量', type: 'number' }, done: { name: '完成', type: 'checkbox' }, status: { name: '状态', type: 'status', options: [{ v: '进行中', c: 'blue' }] }, tags: { name: '标签', type: 'multi_select' }, date: { name: '日期', type: 'date' }, url: { name: '网址', type: 'url' }, phone: { name: '电话', type: 'phone_number' }, created: { name: '创建', type: 'created_time' } }
  return { format: 'inkwell-backup', version: 1, exported: '2026-10-31T00:00:00Z', space: { id: 'space', privatePages: ['home', 'db'], teamspaces: [] }, blocks: [
    base('home', 'page', 'space', '首页', ['heading', 'callout', 'toggle', 'code', 'table', 'image', 'child']),
    base('heading', 'header', 'home', '标题'), base('callout', 'callout', 'home', '提醒'),
    base('toggle', 'toggle', 'home', '展开', ['text']), base('text', 'text', 'toggle', '子内容'),
    base('code', 'code', 'home', 'const x = 1', [], { language: 'js' }),
    base('table', 'table', 'home', '', ['t1', 't2']), base('t1', 'table_row', 'table', '', [], { cells: [[['列一']], [['列二']]] }), base('t2', 'table_row', 'table', '', [], { cells: [[['甲']], [['乙']]] }),
    base('image', 'image', 'home', '图', [], { src: 'data:image/png;base64,iVBORwECAw==' }), base('child', 'page', 'home', '子页', ['link']),
    { ...base('link', 'text', 'child', ''), title: [['‣', { mention: { kind: 'page', id: 'home' } }]] },
    base('db', 'collection_view_page', 'space', '任务', ['row'], { schema, views: ['table', 'board', 'list', 'gallery', 'calendar', 'timeline'].map(type => ({ id: type, name: type, type, order: Object.keys(schema), hidden: ['phone'], sort: [{ prop: 'n', dir: 'desc' }], filter: [{ prop: 'done', op: 'unchecked' }], group: 'status', dateProp: 'date', cardProps: ['n'], calcs: { n: 'sum' } })) }),
    base('row', 'page', 'db', '事项', [], { n: 12, done: false, status: '进行中', tags: ['甲', '乙'], date: ['2026-10-30', '2026-10-31'], url: 'https://example.invalid', phone: '00123' }),
  ] }
}
