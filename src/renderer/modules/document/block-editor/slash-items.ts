import {
  CalendarDays, CheckSquare, Database, Code2, Columns2, CopyCheck, FilePlus2, Heading1, Heading2, Heading3, Info, LayoutTemplate,
  Lightbulb, Link2, List, ListOrdered, Minus, Pilcrow, Quote, Shapes, Sparkles, Table2, TriangleAlert, Workflow,
  type LucideIcon,
} from 'lucide-react'

// The slash menu's catalog (W3 §4.3): five groups, an icon and a one-line description per item, and English and
// pinyin keywords (full and initials) so “/bt”, “/biaoti” and “/heading” all find 标题.

export const SLASH_GROUPS = ['基础', '列表', '媒体', '嵌入', '高级'] as const
export type SlashGroup = typeof SLASH_GROUPS[number]

export interface SlashMeta { group: SlashGroup; label: string; description: string; icon: LucideIcon; keywords: string }
export interface SlashItem extends SlashMeta { id: string; run(): void | Promise<void> }

export const SLASH_META: Record<string, SlashMeta> = {
  paragraph: { group: '基础', label: '段落', description: '普通正文', icon: Pilcrow, keywords: 'text paragraph p duanluo dl zhengwen zw' },
  h1: { group: '基础', label: '标题 1', description: '一级标题，页面里的大节', icon: Heading1, keywords: 'heading1 h1 title biaoti bt yiji yj' },
  h2: { group: '基础', label: '标题 2', description: '二级标题', icon: Heading2, keywords: 'heading2 h2 title biaoti bt erji ej' },
  h3: { group: '基础', label: '标题 3', description: '三级标题', icon: Heading3, keywords: 'heading3 h3 title biaoti bt sanji sj' },
  quote: { group: '基础', label: '引用', description: '引用一段文字', icon: Quote, keywords: 'quote blockquote yinyong yy' },
  divider: { group: '基础', label: '分隔线', description: '一条横线，分开上下文', icon: Minus, keywords: 'divider hr line rule fengexian fgx' },
  NOTE: { group: '基础', label: '笔记框', description: '带“笔记”标记的提示框', icon: Info, keywords: 'callout note biji bj tishikuang tsk' },
  TIP: { group: '基础', label: '提示框', description: '带“提示”标记的提示框', icon: Lightbulb, keywords: 'callout tip hint tishi ts tishikuang tsk' },
  WARNING: { group: '基础', label: '注意框', description: '带“注意”标记的提示框', icon: TriangleAlert, keywords: 'callout warning caution zhuyi zy jinggao jg' },
  bullet: { group: '列表', label: '无序列表', description: '圆点列表', icon: List, keywords: 'bullet list ul unordered wuxuliebiao wxlb liebiao lb' },
  ordered: { group: '列表', label: '有序列表', description: '编号列表', icon: ListOrdered, keywords: 'ordered numbered list ol youxuliebiao yxlb bianhao bh' },
  task: { group: '列表', label: '任务', description: '可以勾选的待办', icon: CheckSquare, keywords: 'todo task checkbox renwu rw daiban db' },
  code: { group: '媒体', label: '代码', description: '等宽的代码块', icon: Code2, keywords: 'code snippet pre daima dm' },
  table: { group: '媒体', label: '表格', description: '两列的表格，可继续添加行列', icon: Table2, keywords: 'table grid biaoge bg' },
  page: { group: '嵌入', label: '子页面', description: '在本页下新建一页并链接过去', icon: FilePlus2, keywords: 'page subpage child yemian ym ziyemian zym' },
  database: { group: '嵌入', label: '数据库', description: '在本页下新建数据库，在这里显示它的表格', icon: Database, keywords: 'database db table shujuku sjk biao' },
  board: { group: '嵌入', label: '画板', description: '在本页下新建画板并链接过去', icon: Shapes, keywords: 'board canvas whiteboard huaban hb' },
  reference: { group: '嵌入', label: '链接页面', description: '搜索资料库里的页面、标题或文件，在这里放一个链接', icon: Link2, keywords: 'link reference mention wiki page file 引用 引用对象 引用页面 引用文件 链接文件 文件 页面 yinyong yy lianjie lj duixiang dx yemian ym wenjian wj' },
  synced: { group: '嵌入', label: '同步块', description: '引用别处的一块，随原文更新', icon: CopyCheck, keywords: 'synced block transclusion embed tongbukuai tbk' },
  template: { group: '嵌入', label: '模板', description: '插入一个模板的内容', icon: LayoutTemplate, keywords: 'template muban mb' },
  widget: { group: '嵌入', label: '信息卡', description: '可交互的 Widget 卡片', icon: Sparkles, keywords: 'widget card xinxika xxk kapian kp' },
  date: { group: '高级', label: '日期', description: '插入今天，点一下可以改日子', icon: CalendarDays, keywords: 'date today day riqi rq jintian jt' },
  columns: { group: '高级', label: '分栏', description: '并排的两栏', icon: Columns2, keywords: 'columns layout split fenlan fl' },
  mermaid: { group: '高级', label: 'Mermaid 图表', description: '用文字画流程图与时序图', icon: Workflow, keywords: 'mermaid diagram flowchart chart tubiao tb liuchengtu lct' },
}

/**
 * Items whose label, id or a keyword matches the query, best first: label prefix, keyword prefix, then any
 * substring. Ties keep the catalog order, so an empty query lists every group in order.
 */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, '')
  const ordered = [...items].sort((a, b) => SLASH_GROUPS.indexOf(a.group) - SLASH_GROUPS.indexOf(b.group))
  if (!q) return ordered
  const score = (item: SlashItem): number => {
    const label = item.label.toLowerCase().replace(/\s+/g, '')
    const words = [item.id.toLowerCase(), ...item.keywords.toLowerCase().split(/\s+/)]
    if (label.startsWith(q)) return 3
    if (words.some(word => word.startsWith(q))) return 2
    if (label.includes(q) || words.some(word => word.includes(q))) return 1
    return 0
  }
  return ordered.map((item, index) => ({ item, index, rank: score(item) })).filter(entry => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.index - b.index).map(entry => entry.item)
}
