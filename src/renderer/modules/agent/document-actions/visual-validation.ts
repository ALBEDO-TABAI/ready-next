import {
  findDocumentVisualSyntaxIssue,
  findShowWidgetBoundaryViolation,
} from '../../../../shared/document-visual-syntax'
import { raceWithTimeout } from './text-utils'

const MERMAID_FENCE_REGEX = /```mermaid[^\n]*\n([\s\S]*?)```/gi

export function collectMermaidBlocks(content: string): string[] {
  MERMAID_FENCE_REGEX.lastIndex = 0
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = MERMAID_FENCE_REGEX.exec(content)) !== null) {
    const code = String(match[1] || '').trim()
    if (code) blocks.push(code)
  }
  return blocks
}

export function mermaidSvgContainsSourceLeak(svg: string): boolean {
  return /(?:%%|--&gt;|-->|-\.-&gt;|---\|?|graph\s+(?:TD|TB|BT|LR|RL)|flowchart\s+(?:TD|TB|BT|LR|RL))/i.test(svg)
}

export async function validateMermaidPreviewRender(content: string): Promise<string | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  const blocks = collectMermaidBlocks(content)
  if (blocks.length === 0) return null
  try {
    const module = await import('mermaid')
    const mermaid = module.default
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
    })
    for (let index = 0; index < blocks.length; index += 1) {
      const renderId = `ready-doc-tool-mermaid-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`
      const result = await raceWithTimeout(
        mermaid.render(renderId, blocks[index]),
        3_000,
        'mermaid_validate',
      )
      if (mermaidSvgContainsSourceLeak(result.svg)) {
        return '目标文档里的 Mermaid 预览结果仍包含源码痕迹'
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `目标文档里的 Mermaid 无法完成真实预览渲染：${message}`
  }
  return null
}

export async function buildVisualSyntaxRejection(actionLabel: string, content: string): Promise<string | null> {
  const visualSyntaxIssue = findDocumentVisualSyntaxIssue(content)
  const previewIssue = visualSyntaxIssue || await validateMermaidPreviewRender(content)
  return previewIssue
    ? `${actionLabel}已拒绝：${previewIssue}。请把所有 graph/flowchart 节点和连线放在同一个 \`\`\`mermaid 代码块里；如果真实预览仍不稳定，请改成 Markdown 表格。`
    : null
}


export function buildWidgetBoundaryRejection(actionLabel: string): string {
  return `${actionLabel}已拒绝：不能用普通文本替换工具修改 show-widget 代码块内部内容。请改用 document_update_widget。`
}

export function buildWidgetBoundaryRejectionForRanges(
  actionLabel: string,
  source: string,
  ranges: Array<{ start: number; end: number }>,
): string | null {
  const issue = findShowWidgetBoundaryViolation(source, ranges)
  return issue ? buildWidgetBoundaryRejection(actionLabel) : null
}
