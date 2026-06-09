import type { AgentSdkRuntimeDeps } from '../../main/modules/agent-control/runtime-core/agent-sdk-runtime'

type RunAgent = NonNullable<AgentSdkRuntimeDeps['runAgent']>
type RunAgentParams = Parameters<RunAgent>[0]
type RunAgentResult = Awaited<ReturnType<RunAgent>>

export interface TurnState {
  turnIndex: number
  messages: unknown[]
}

export interface TurnScript {
  turnIndex: number
  response: string
  assertions?: (state: TurnState) => void
}

export class ScriptedAgentRunner {
  readonly deps: AgentSdkRuntimeDeps
  private readonly scripts: TurnScript[]
  private readonly messages: unknown[] = []
  private nextScriptIndex = 0

  constructor(deps: AgentSdkRuntimeDeps, scripts: TurnScript[]) {
    this.scripts = [...scripts].sort((a, b) => a.turnIndex - b.turnIndex)
    this.deps = {
      ...deps,
      runAgent: async (params) => this.runScriptedTurn(params),
    }
  }

  async runAll(): Promise<void> {
    while (this.nextScriptIndex < this.scripts.length) {
      await this.deps.runAgent?.({
        input: [],
        onTextDelta: () => {},
      } as RunAgentParams)
    }
  }

  private async runScriptedTurn(params: RunAgentParams): Promise<RunAgentResult> {
    const script = this.scripts[this.nextScriptIndex]
    if (!script) {
      throw new Error('No scripted turn is available for runAgent call')
    }

    this.nextScriptIndex += 1
    this.messages.push({
      turnIndex: script.turnIndex,
      input: params.input,
    })
    params.onTextDelta(script.response)
    this.messages.push({
      turnIndex: script.turnIndex,
      response: script.response,
    })
    script.assertions?.({
      turnIndex: script.turnIndex,
      messages: [...this.messages],
    })

    return {
      finalText: script.response,
    }
  }
}
