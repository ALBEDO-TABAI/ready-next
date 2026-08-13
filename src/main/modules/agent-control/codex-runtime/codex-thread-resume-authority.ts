import type { CodexNativeRuntime } from './codex-native-runtime'
import type { ReadyCodexThreadResumePort } from './ready-codex-lifecycle-adapter'

export interface CodexThreadResumeSession {
  getActiveConnectionEpoch(): string
  getClient(): CodexNativeRuntime
  getConnectionAbortSignal(connectionEpoch: string): AbortSignal | null
  isConnectionLive(connectionEpoch: string): boolean
}

export class CodexThreadResumeAuthority implements ReadyCodexThreadResumePort {
  constructor(private readonly getSession: () => CodexThreadResumeSession | null) {}

  async readThenResume(input: {
    threadId: string
    validateRead(thread: Awaited<ReturnType<CodexNativeRuntime['threadRead']>>['thread']): void
  }) {
    const session = this.getSession()
    if (!session) throw new Error('codex_sidecar_session_unavailable')
    const connectionEpoch = session.getActiveConnectionEpoch()
    const client = session.getClient()
    const abortSignal = session.getConnectionAbortSignal(connectionEpoch)
    if (!abortSignal) throw new Error('codex_thread_resume_connection_unavailable')

    const assertPinnedConnection = (): void => {
      if (
        this.getSession() !== session
        || abortSignal.aborted
        || !session.isConnectionLive(connectionEpoch)
        || session.getConnectionAbortSignal(connectionEpoch) !== abortSignal
        || session.getClient() !== client
      ) throw new Error('codex_thread_resume_connection_changed')
    }

    assertPinnedConnection()
    const read = await client.threadRead({ threadId: input.threadId, includeTurns: true })
    assertPinnedConnection()
    input.validateRead(read.thread)
    assertPinnedConnection()
    const resumed = await client.threadResume({ threadId: input.threadId })
    assertPinnedConnection()
    return { connectionEpoch, read, resumed }
  }
}
