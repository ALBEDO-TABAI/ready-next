import {
  createToolExecutionOutput,
  serializeToolExecutionOutput,
} from './tool-result-types'
import type { TurnTranscriptEvent } from './run-contracts'
import type { TurnTerminalReason } from './turn-frame'
import { sanitizeAssistantText } from './tool-call-text-guard'

export interface TurnTranscriptOptions {
  /**
   * Optional context the screenshot-bug hotfix passes through to the
   * `tool_call_text_intercepted` metric so dashboards can group leak events
   * by session. Safe to omit — sanitization still fires.
   */
  sessionId?: string
}

export class TurnTranscript {
  private readonly events: TurnTranscriptEvent[] = []
  private readonly finalChunks: string[] = []
  private readonly usedTools = new Set<string>()

  constructor(
    private readonly emitters: {
      emitOutput: (
        chunk: string,
        type: string,
        options?: {
          projectionPatch?: Record<string, unknown> | null
        },
      ) => void
      emitStatus: (status: string, terminalReason?: TurnTerminalReason | null) => void
      emitRuntimeError: (error: unknown, options?: { toolName?: string }) => void
      emitToolAction: (tool: string, args: Record<string, unknown>) => void
    },
    private readonly options: TurnTranscriptOptions = {},
  ) {}

  emitOutput(
    chunk: string,
    type: string,
    options?: {
      projectionPatch?: Record<string, unknown> | null
    },
  ): void {
    // Screenshot-bug hotfix — sanitize 'text' chunks BEFORE they reach the
    // renderer chat panel + finalChunks accumulator + chat_messages DB save.
    // Phase 3.2 only protected the `session.messages.push` (history fed back
    // to the LLM) sites; the user-visible damage flows through this method.
    // See `tool-call-text-guard.ts` for the trade-off (legitimate prose
    // quoting `<tool_call>` is the cost of safety).
    const safeChunk = type === 'text'
      ? sanitizeAssistantText(chunk, {
          sessionId: this.options.sessionId,
          source: 'transcript_emit',
        })
      : chunk
    this.events.push({ kind: 'output', chunk: safeChunk, type })
    if (type === 'text' && safeChunk) {
      this.finalChunks.push(safeChunk)
    }
    this.emitters.emitOutput(safeChunk, type, options)
  }

  emitToolUse(tool: string, args: Record<string, unknown>): void {
    this.usedTools.add(tool)
    this.emitOutput(`${tool}(${JSON.stringify(args).slice(0, 100)})`, 'tool_use')
  }

  emitStructuredPayload(payload: unknown): void {
    const projectionPatch = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
    this.events.push({ kind: 'structured_payload', projectionPatch })
    this.emitOutput(serializeToolExecutionOutput(createToolExecutionOutput('', {
      projectionPatch,
    })), 'tool_result', {
      projectionPatch,
    })
  }

  emitStatus(status: string, terminalReason?: TurnTerminalReason | null): void {
    this.events.push({ kind: 'status', status, terminalReason })
    this.emitters.emitStatus(status, terminalReason)
  }

  emitRuntimeError(error: unknown, options?: { toolName?: string }): void {
    const message = error instanceof Error ? error.message : String(error)
    this.events.push({ kind: 'error', error: message })
    this.emitters.emitRuntimeError(error, options)
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
