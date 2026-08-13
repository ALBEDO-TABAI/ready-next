import { randomUUID } from 'node:crypto'

import type { WebContents } from 'electron'

import type { PendingToolActionEntry } from './tool-event-group'

type RendererTarget = Pick<WebContents, 'id' | 'isDestroyed' | 'send'>

export type RendererToolActionRequest = {
  agent?: string
  sessionId: string
  runId: string
  codexThreadId: string
  codexTurnId: string
  codexCallId: string
  readyActionId: string
  actionIdentityDigest: string
  tool: string
  args: Record<string, unknown>
  abortSignal: AbortSignal
}

export class RendererToolActionBridge {
  readonly pendingToolActionRequests = new Map<string, PendingToolActionEntry>()
  private target: RendererTarget | null = null

  bindTarget(target: RendererTarget): void {
    if (this.target?.id !== target.id) this.cancelAll('renderer_target_replaced')
    this.target = target
  }

  releasePendingRequest(requestId: string): void {
    const entry = this.pendingToolActionRequests.get(requestId)
    if (!entry) return
    this.pendingToolActionRequests.delete(requestId)
    if (entry.timer) clearTimeout(entry.timer)
    entry.cleanup?.()
  }

  cancelAll(reason: string): void {
    for (const [requestId, entry] of this.pendingToolActionRequests) {
      this.releasePendingRequest(requestId)
      entry.reject(new Error(reason))
    }
  }

  async request(input: RendererToolActionRequest): Promise<Record<string, unknown>> {
    const target = this.target
    if (!target || target.isDestroyed()) throw new Error('renderer_tool_action_target_unavailable')
    if (input.abortSignal.aborted) throw new Error('renderer_tool_action_aborted')
    const requestId = `codex-renderer-tool-${randomUUID()}`
    if (this.pendingToolActionRequests.has(requestId)) {
      throw new Error('renderer_tool_action_request_id_conflict')
    }
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const onAbort = () => {
        this.releasePendingRequest(requestId)
        if (!target.isDestroyed()) {
          target.send('agent:cancelToolActionRequest', {
            requestIds: [requestId],
            agent: input.agent,
            sessionId: input.sessionId,
          })
        }
        reject(new Error('renderer_tool_action_aborted'))
      }
      const timer = setTimeout(() => {
        this.releasePendingRequest(requestId)
        reject(new Error('renderer_tool_action_timeout'))
      }, 30_000)
      this.pendingToolActionRequests.set(requestId, {
        expectedSenderId: target.id,
        resolve,
        reject,
        timer,
        cleanup: () => input.abortSignal.removeEventListener('abort', onAbort),
      })
      input.abortSignal.addEventListener('abort', onAbort, { once: true })
      target.send('agent:toolActionRequest', {
        requestId,
        agent: input.agent,
        sessionId: input.sessionId,
        runId: input.runId,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        codexCallId: input.codexCallId,
        readyActionId: input.readyActionId,
        actionIdentityDigest: input.actionIdentityDigest,
        tool: input.tool,
        args: input.args,
      })
    })
  }
}
