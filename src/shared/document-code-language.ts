/** Exact CSS language tokens, shared by rendering and external-content conversion. */
export function documentCodeBehavior(className = ''): 'mermaid' | 'markdown' | 'code' {
  if (/(?:^|\s)language-mermaid(?:\s|$)/.test(className)) return 'mermaid'
  if (/(?:^|\s)language-(md|markdown)(?:\s|$)/i.test(className)) return 'markdown'
  return 'code'
}
