import type { RunMessage } from '../contracts/run-contracts'
import { asRecord } from './agent-sdk-model-message-utils'

export const SDK_CONTEXT_MARKERS = [
  '## 环境信息',
  '## 当前 Scope',
  '## 最近会话摘要',
  '### Widget 更新上下文',
  '### 当前文档上下文',
  '### 文档引用',
  '### 浏览页面引用',
  '### 文件夹引用',
  '### 技能目录引用',
  '--- 测试模式附件路径 ---',
  '--- 引用文件:',
  '--- 附件:'
] as const

export function messageToText(message: RunMessage): string {
  if (typeof message === 'string') return message
  return message
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim()
}

export function primaryInstructionText(message: RunMessage): string {
  const text = messageToText(message)
  let end = text.length
  for (const marker of SDK_CONTEXT_MARKERS) {
    const index = text.indexOf(marker)
    if (index >= 0 && index < end) end = index
  }
  const primary = text.slice(0, end).trim()
  return primary || text
}

export function normalizedReferenceName(value: string): string {
  return value.normalize('NFC').trim().replace(/^@\[/, '').replace(/\]$/, '').toLowerCase()
}

export function parseAttachmentReferences(
  message: RunMessage
): Array<{ name: string; path: string }> {
  const text = messageToText(message)
  const references: Array<{ name: string; path: string }> = []
  const pattern = /--- 附件:\s*([^\n-][^\n]*?)\s*---\s*\n-\s*路径:\s*([^\n]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1]?.trim()
    const path = match[2]?.trim()
    if (name && path) references.push({ name, path })
  }
  const harnessMarker = '--- 测试模式附件路径 ---'
  const harnessIndex = text.indexOf(harnessMarker)
  if (harnessIndex >= 0) {
    const afterMarker = text.slice(harnessIndex + harnessMarker.length)
    const nextSectionIndex = afterMarker.search(/\n--- (?!测试模式附件路径)/)
    const harnessSection =
      nextSectionIndex >= 0 ? afterMarker.slice(0, nextSectionIndex) : afterMarker
    const harnessPattern = /^-\s*([^:\n]+?)\s*:\s*(\/[^\n]+)$/gm
    let harnessMatch: RegExpExecArray | null
    while ((harnessMatch = harnessPattern.exec(harnessSection)) !== null) {
      const name = harnessMatch[1]?.trim()
      const path = harnessMatch[2]?.trim()
      if (name && path) references.push({ name, path })
    }
  }
  return references
}

export function parseEnvelopeResourceReferences(envelope: unknown): {
  primaryInstruction: string | null
  resources: Array<{ name: string; path: string; kind?: string; source?: string; tabId?: string }>
} {
  const record = asRecord(envelope)
  if (!record) return { primaryInstruction: null, resources: [] }
  const primaryInstruction =
    typeof record.primaryInstruction === 'string' && record.primaryInstruction.trim()
      ? record.primaryInstruction.trim()
      : typeof record.pureUserText === 'string' && record.pureUserText.trim()
        ? record.pureUserText.trim()
        : typeof record.rawUserText === 'string' && record.rawUserText.trim()
          ? primaryInstructionText(record.rawUserText)
          : null
  const rawResources = Array.isArray(record.resources) ? record.resources : []
  const resources = rawResources
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      name: String(item.name || '').trim(),
      path: String(item.path || item.documentPath || '').trim(),
      kind: typeof item.kind === 'string' ? item.kind : undefined,
      source: typeof item.source === 'string' ? item.source : undefined,
      tabId: typeof item.tabId === 'string' ? item.tabId.trim() : undefined
    }))
    .filter((item) => item.name && item.path)
  return { primaryInstruction, resources }
}
