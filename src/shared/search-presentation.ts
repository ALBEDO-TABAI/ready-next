export const SEARCH_TYPE_LABELS = { page: '页面', database: '数据库', canvas: '画板', book: '书', highlight: '划线', rss: '资讯', calendar: '日程', agent: '对话', bookmark: '书签', fastcard: '收集', command: '命令' } as const
export interface SearchPresentation { title: string; typeLabel: typeof SEARCH_TYPE_LABELS[keyof typeof SEARCH_TYPE_LABELS] }

/** Strip file extensions only from file names, never from authored titles or URLs. */
export function searchPresentation(item: { name: string; path: string; sourceType: string }, frontmatter?: Record<string, unknown> | null): SearchPresentation {
  if (item.sourceType === 'document') {
    return { title: typeof frontmatter?.title === 'string' ? frontmatter.title : item.name.replace(/\.[^.]+$/, ''),
      typeLabel: frontmatter?.ready_database ? '数据库' : /\.canvas$/i.test(item.path) ? '画板' : '页面' }
  }
  const typeLabel = Object.entries(SEARCH_TYPE_LABELS).find(([key]) => key === item.sourceType)?.[1] ?? '页面'
  return { title: item.name, typeLabel }
}
