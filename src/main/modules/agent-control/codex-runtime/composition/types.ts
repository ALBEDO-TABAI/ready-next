import type { CodexProductTurnRuntimeRead } from '../codex-binding-repository'
import type { ReadyClosedCodexProductRun } from '../codex-runtime-composition'
import type { ProductTurnCloseoutEvidence } from '../ready-codex-lifecycle-adapter'

export type PendingEngineTerminalFinalization = {
  identity: { aliasId: string; aliasGeneration: number }
  product: CodexProductTurnRuntimeRead
  terminal: ProductTurnCloseoutEvidence['terminal']
  productTerminalDigest: string
  closeoutAt: string
  recovered: ReadyClosedCodexProductRun
}
