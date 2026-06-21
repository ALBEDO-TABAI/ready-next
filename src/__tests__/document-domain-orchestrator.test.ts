import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DocumentDomainOrchestrator } from '../main/modules/agent-control/domain-adapters/document-domain-orchestrator'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { ToolContext } from '../main/modules/tools/tool-executor'

type EmittedChunk = {
  agent: string
  chunk: string
  type: 'text' | 'tool_use' | 'tool_result'
}

function unusedLlmCall(): Promise<string> {
  throw new Error('LLM call should not be used in deterministic document tests')
}

test('document deterministic direct summary redacts model-visible target paths but keeps raw tool action args', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-p6g-doc-'))
  const targetPath = join(dir, 'report.md')
  await writeFile(targetPath, '# 第一章\n\n已经整理好的段落。\n')

  const emitted: EmittedChunk[] = []
  const toolActions: Array<{ tool: string; args: Record<string, unknown> }> = []
  const summaries: string[] = []
  try {
    const orchestrator = new DocumentDomainOrchestrator({
      log: () => {},
      executeToolCall: async () => {
        throw new Error('direct path should not call document tools')
      },
      extractPrimaryUserInstruction: (raw) => raw,
      extractSectionTitleFromUserText: () => null,
      extractDocumentPathFromUserText: () => targetPath,
      callKimiCodingSimple: unusedLlmCall,
      callAnthropicSimple: unusedLlmCall,
      callOpenAISimple: unusedLlmCall,
    })

    const handled = await orchestrator.tryDeterministicSectionFormatFlow({
      agentName: 'Ready',
      userText: `优化这个文档 ${targetPath}`,
      toolContext: {} as ToolContext,
      emitters: {
        emitOutput: (payload) => emitted.push(payload),
        emitToolAction: (payload) => toolActions.push({ tool: payload.tool, args: payload.args }),
      },
      onAssistantSummary: (summary) => summaries.push(summary),
    })

    assert.equal(handled, true)
    assert.equal(toolActions[0]?.tool, 'document.openFile')
    assert.equal(toolActions[0]?.args.path, targetPath)

    const visibleText = [
      ...emitted.map((entry) => entry.chunk),
      ...summaries,
    ].join('\n')
    assert.doesNotMatch(visibleText, /\/Users\/bai/)
    assert.match(visibleText, /~\/实验田\//)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('document deterministic fallback redacts model-visible tool chunks but keeps raw tool inputs', async () => {
  const targetPath = '/Users/alice/Ready/report.md'
  const emitted: EmittedChunk[] = []
  const summaries: string[] = []
  const calls: Array<{ name: string; input: Record<string, unknown> }> = []

  const orchestrator = new DocumentDomainOrchestrator({
    log: () => {},
    executeToolCall: async (name, input) => {
      calls.push({ name, input })
      if (name === 'document_open_tab') {
        return createToolExecutionOutput(`已打开并载入文档：${targetPath}（1207 字）`)
      }
      if (name === 'document_format_section') {
        return createToolExecutionOutput(`已格式化 ${targetPath} 的章节`)
      }
      if (name === 'document_save_tab') {
        return createToolExecutionOutput(`已保存 ${targetPath}`)
      }
      throw new Error(`Unexpected tool ${name}`)
    },
    extractPrimaryUserInstruction: (raw) => raw,
    extractSectionTitleFromUserText: () => '第一章',
    extractDocumentPathFromUserText: () => targetPath,
    callKimiCodingSimple: unusedLlmCall,
    callAnthropicSimple: unusedLlmCall,
    callOpenAISimple: unusedLlmCall,
  })

  const handled = await orchestrator.tryDeterministicSectionFormatFlow({
    agentName: 'Ready',
    userText: `优化第一章 ${targetPath}`,
    toolContext: {} as ToolContext,
    emitters: {
      emitOutput: (payload) => emitted.push(payload),
      emitToolAction: () => {},
    },
    onAssistantSummary: (summary) => summaries.push(summary),
  })

  assert.equal(handled, true)
  assert.equal(calls[0]?.name, 'document_open_tab')
  assert.equal(calls[0]?.input.path, targetPath)

  const visibleText = [
    ...emitted.map((entry) => entry.chunk),
    ...summaries,
  ].join('\n')
  assert.doesNotMatch(visibleText, /\/Users\/alice/)
  assert.match(visibleText, /\/Users\/<redacted>\/Ready\/report\.md/)
})
