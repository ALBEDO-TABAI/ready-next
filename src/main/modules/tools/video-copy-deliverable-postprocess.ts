import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillRunResult } from '../skills-runtime/runtime-manager'
import {
  hasLinePerSentenceParagraphSmell,
  hasReliableTranscriptPunctuation,
  isFallbackCopySummary,
  RSSSubagentRunner,
  type CopyDeliverableOptions,
} from '../rss-engine/subagent-runner'

interface CopyDeliverables {
  correctedTranscript: string
  structuredTranscript: string
  report: string
}

interface CopyDeliverableBuilder {
  buildCopyDeliverables(input: {
    title: string
    link: string
    source?: string
    extractedText: string
  }, options?: CopyDeliverableOptions): Promise<CopyDeliverables>
}

const REQUIRED_REPORT_TOKENS = ['TextContent', 'Viral-Abstract-Script', 'Brainstorming']
const FILE_TIME_TOLERANCE_MS = 1000

export interface CompleteVideoCopyAnalyzeResultOptions {
  result: SkillRunResult
  args: Record<string, unknown>
  builder?: CopyDeliverableBuilder
  onProgress?: (message: string, completed: number) => void
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stripTranscriptSuffix(path: string): string {
  const name = path.split(/[\\/]/).pop() || 'video'
  return name
    .replace(/\.md$/i, '')
    .replace(/_文字稿$/u, '')
    .replace(/_transcript$/iu, '')
}

function appendStdout(stdout: string, lines: string[]): string {
  return [stdout.trim(), ...lines.filter(Boolean)].filter(Boolean).join('\n')
}

function getMarkdownBodyLength(text: string): number {
  return text
    .replace(/^#+\s+.*$/gm, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .length
}

function readReusableText(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf-8').trim()
    return text || null
  } catch {
    // silent-catch: reusable VCA report/transcript sidecars are optional cache inputs.
    return null
  }
}

function hasReusableReportShape(text: string): boolean {
  return REQUIRED_REPORT_TOKENS.every((token) => text.includes(token)) && getMarkdownBodyLength(text) >= 20
}

function hasReusableStructuredTranscriptShape(text: string): boolean {
  return text.includes('结构化文字稿')
    && /^##\s+/m.test(text)
    && getMarkdownBodyLength(text) >= 12
    && !hasLinePerSentenceParagraphSmell(text)
    && hasReliableTranscriptPunctuation(text)
}

function isFreshForTranscript(path: string, transcriptPath: string): boolean {
  const fileMtime = statSync(path).mtimeMs
  const transcriptMtime = statSync(transcriptPath).mtimeMs
  return fileMtime + FILE_TIME_TOLERANCE_MS >= transcriptMtime
}

function canReuseDeliverables(input: {
  analysisReportPath: string
  structuredTranscriptPath: string
  transcriptPath: string
}): boolean {
  if (!existsSync(input.analysisReportPath) || !existsSync(input.structuredTranscriptPath)) return false
  const report = readReusableText(input.analysisReportPath)
  const structuredTranscript = readReusableText(input.structuredTranscriptPath)
  if (!report || !structuredTranscript) return false
  if (!hasReusableReportShape(report) || !hasReusableStructuredTranscriptShape(structuredTranscript)) return false
  return isFreshForTranscript(input.analysisReportPath, input.transcriptPath)
    && isFreshForTranscript(input.structuredTranscriptPath, input.transcriptPath)
}

export async function completeVideoCopyAnalyzeResult(
  options: CompleteVideoCopyAnalyzeResultOptions,
): Promise<SkillRunResult> {
  const { result, args } = options
  if (!result.success) return result

  const outputs = { ...(result.outputs || {}) }
  const outputDir = readString(outputs.outputDir) || readString(result.outputDir) || readString(args.outputDir)
  const transcriptPath = readString(outputs.transcriptPath)
  const sourceInput = readString(outputs.sourceInput) || readString(args.input) || readString(args.sourceInput)
  if (!outputDir || !transcriptPath || !existsSync(transcriptPath)) {
    return {
      ...result,
      success: false,
      status: 'error',
      error: 'Video Copy Analyzer 已完成字幕提取，但缺少可用于文案分析的文字稿。',
      stdout: appendStdout(result.stdout, ['❌ 缺少文字稿，无法生成文案分析报告。']),
      outputs,
    }
  }

  try {
    const extractedText = readFileSync(transcriptPath, 'utf-8')
    const baseName = stripTranscriptSuffix(transcriptPath)
    const title = baseName || '视频文案'
    const analysisReportPath = join(outputDir, `${baseName}_分析报告.md`)
    const structuredTranscriptPath = join(outputDir, `${baseName}_结构化文字稿.md`)
    const hadExistingDeliverables = existsSync(analysisReportPath) || existsSync(structuredTranscriptPath)
    if (canReuseDeliverables({ analysisReportPath, structuredTranscriptPath, transcriptPath })) {
      options.onProgress?.('文案分析报告和结构化文字稿已生成。', 5)
      return {
        ...result,
        outputDir,
        outputs: {
          ...outputs,
          outputDir,
          transcriptPath,
          analysisReportPath,
          structuredTranscriptPath,
        },
        stdout: appendStdout(result.stdout, [
          `✅ 复用已有文案分析报告: ${analysisReportPath}`,
          `✅ 复用已有结构化文字稿: ${structuredTranscriptPath}`,
        ]),
      }
    }

    const deliverables = await (options.builder || new RSSSubagentRunner()).buildCopyDeliverables(
      {
        title,
        link: sourceInput || transcriptPath,
        source: 'video-copy-analyzer',
        extractedText,
      },
      {
        onProgress: (progress) => options.onProgress?.(progress.message, progress.completed),
      },
    )
    if (isFallbackCopySummary(deliverables.report)) {
      throw new Error('Video Copy Analyzer 未能生成符合技能合同的三维度文案分析报告。')
    }
    if (hasLinePerSentenceParagraphSmell(deliverables.structuredTranscript)) {
      throw new Error('Video Copy Analyzer 生成的结构化文字稿仍是逐句空行格式。')
    }
    writeFileSync(transcriptPath, `${deliverables.correctedTranscript.trim()}\n`, 'utf-8')
    writeFileSync(
      analysisReportPath,
      [
        `# ${title} 文案分析报告`,
        '',
        sourceInput ? `- 链接: ${sourceInput}` : '',
        '',
        deliverables.report.trim(),
        '',
      ].filter((line) => line !== '').join('\n'),
      'utf-8',
    )
    writeFileSync(structuredTranscriptPath, `${deliverables.structuredTranscript.trim()}\n`, 'utf-8')
    options.onProgress?.('文案分析报告和结构化文字稿已生成。', 5)

    return {
      ...result,
      outputDir,
      outputs: {
        ...outputs,
        outputDir,
        transcriptPath,
        analysisReportPath,
        structuredTranscriptPath,
      },
      stdout: appendStdout(result.stdout, [
        hadExistingDeliverables ? '↻ 已有文案分析产物不完整或早于当前文字稿，已重新生成。' : '',
        `✅ 文案分析报告已生成: ${analysisReportPath}`,
        `✅ 结构化文字稿已生成: ${structuredTranscriptPath}`,
      ]),
    }
  } catch (error) {
    // silent-catch: caller receives the postprocess failure as a structured tool result.
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...result,
      success: false,
      status: 'error',
      error: `文案分析未完成：${message}`,
      stdout: appendStdout(result.stdout, [`❌ 文案分析未完成：${message}`]),
      outputs,
    }
  }
}
