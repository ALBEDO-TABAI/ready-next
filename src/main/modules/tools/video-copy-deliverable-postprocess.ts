import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillRunResult } from '../skills-runtime/runtime-manager'
import { RSSSubagentRunner, type CopyDeliverableOptions } from '../rss-engine/subagent-runner'

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
    if (existsSync(analysisReportPath) && existsSync(structuredTranscriptPath)) {
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
