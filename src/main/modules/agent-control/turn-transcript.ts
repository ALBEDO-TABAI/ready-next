import {
  createToolExecutionOutput,
  serializeToolExecutionOutput,
} from './tool-result-types'
import type { TurnTranscriptEvent } from './run-contracts'

export class TurnTranscript {
  private readonly events: TurnTranscriptEvent[] = []
  private readonly finalChunks: string[] = []
  private readonly usedTools = new Set<string>()

  constructor(private readonly emitters: {
    emitOutput: (chunk: string, type: string) => void
    emitStatus: (status: string) => void
    emitRuntimeError: (error: string) => void
    emitToolAction: (tool: string, args: Record<string, unknown>) => void
  }) {}

  emitOutput(chunk: string, type: string): void {
    this.events.push({ kind: 'output', chunk, type })
    if (type === 'text' && chunk) {
      this.finalChunks.push(chunk)
    }
    this.emitters.emitOutput(chunk, type)
  }

  emitToolUse(tool: string, args: Record<string, unknown>): void {
    this.usedTools.add(tool)
    this.emitOutput(`${tool}(${JSON.stringify(args).slice(0, 100)})`, 'tool_use')
  }

  emitStructuredPayload(payload: unknown): void {
    this.emitOutput(serializeToolExecutionOutput(createToolExecutionOutput('', {
      projectionPatch: payload && typeof payload === 'object' ? payload as Record<string, unknown> : null,
    })), 'tool_result')
  }

  emitStatus(status: string): void {
    this.events.push({ kind: 'status', status })
    this.emitters.emitStatus(status)
  }

  emitRuntimeError(error: string): void {
    this.events.push({ kind: 'error', error })
    this.emitters.emitRuntimeError(error)
  }

  emitToolAction(tool: string, args: Record<string, unknown>): void {
    this.events.push({ kind: 'tool_action', tool, args })
    this.emitters.emitToolAction(tool, args)
  }

  getFinalText(): string {
    return this.finalChunks.join('')
  }

  getUsedTools(): string[] {
    return Array.from(this.usedTools)
  }

  listEvents(): TurnTranscriptEvent[] {
    return this.events.slice()
  }
}
