/** Bridge the gateway authority and credential ports to durable Ready state. */
import type { AppSettingsRepository } from '../../repositories/app-settings-repository'
import { CodexModelGatewayAuthorityError } from './codex-model-gateway-common'
import {
  type CodexModelGatewayFailureEvidence,
  type CodexModelGatewayResponseEvidence,
  type CodexUpstreamProfileSnapshot,
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
} from './codex-model-gateway-contract'
import type { CodexModelGatewayRepository } from './codex-model-gateway-repository'
import type {
  CodexModelGatewayAuthority,
  CodexModelGatewayBinding,
  CodexModelGatewayCredentialStore,
  CodexModelGatewayMetadata,
  CodexModelGatewayPreparedRequestReceipt,
  CodexModelGatewayToolResponseCall,
} from './codex-model-gateway-types'

export class CodexDatabaseModelGatewayAuthority implements CodexModelGatewayAuthority {
  constructor(private readonly repository: CodexModelGatewayRepository) {}

  async resolve(input: {
    metadata: CodexModelGatewayMetadata
    receivedAt: string
    validate(binding: CodexModelGatewayBinding): ReadonlySet<string>
    prepareRequestReceipt(): CodexModelGatewayPreparedRequestReceipt
  }): Promise<CodexModelGatewayBinding> {
    let prepared: CodexModelGatewayPreparedRequestReceipt | null = null
    return this.repository.resolveBinding({
      metadata: input.metadata,
      receivedAt: input.receivedAt,
      get requestDigest() {
        if (!prepared) throw new CodexModelGatewayAuthorityError('gateway_request_receipt_unprepared')
        return prepared.requestDigest
      },
      get requestEvidence() {
        if (!prepared) throw new CodexModelGatewayAuthorityError('gateway_request_receipt_unprepared')
        return prepared.requestEvidence
      },
      validate(binding) {
        const allowedTools = input.validate(binding)
        prepared = input.prepareRequestReceipt()
        return allowedTools
      },
    })
  }

  async admitToolResponse(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    calls: readonly CodexModelGatewayToolResponseCall[]
    admittedAt: string
  }): Promise<void> {
    this.repository.admitToolResponse(input)
  }

  async recordResponseEvidence(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    responseEvidence: CodexModelGatewayResponseEvidence
    completedAt: string
  }): Promise<void> {
    this.repository.recordResponseEvidence(input)
  }

  recordResponseFailureEvidence(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    failureEvidence: CodexModelGatewayFailureEvidence
    failedAt: string
  }): void {
    this.repository.recordResponseFailureEvidence(input)
  }
}

export class ReadySettingsModelGatewayCredentialStore implements CodexModelGatewayCredentialStore {
  constructor(private readonly settings: Pick<AppSettingsRepository, 'getAIWorkspace'>) {}

  resolve(input: {
    credentialReferenceId: string
    snapshot: CodexUpstreamProfileSnapshot
  }): string {
    const expectedReference = `ai-profile:${input.snapshot.profileId}`
    if (
      input.credentialReferenceId !== expectedReference
      || input.snapshot.credentialReferenceId !== expectedReference
    ) throw new CodexModelGatewayAuthorityError('gateway_credential_reference_mismatch')
    const workspace = this.settings.getAIWorkspace()
    const profile = workspace.profiles.find((candidate) => candidate.id === input.snapshot.profileId)
    if (!profile) throw new CodexModelGatewayAuthorityError('gateway_credential_not_found')
    const credential = profile.config.apiKey || ''
    if (!credential) throw new CodexModelGatewayAuthorityError('gateway_credential_not_found')
    let current: ReturnType<typeof createCodexUpstreamProfileSnapshot>
    try {
      current = createCodexUpstreamProfileSnapshot({
        profileId: input.snapshot.profileId,
        config: profile.config,
        maxRetries: input.snapshot.retryPolicy.maxRetries,
      })
    } catch {
      throw new CodexModelGatewayAuthorityError('gateway_credential_route_drift')
    }
    if (digestCanonicalJson(current.snapshot) !== digestCanonicalJson(input.snapshot)) {
      throw new CodexModelGatewayAuthorityError('gateway_credential_route_drift')
    }
    return credential
  }
}

export { CodexModelGatewayAuthorityError } from './codex-model-gateway-common'
export { CodexModelGatewayRepository } from './codex-model-gateway-repository'
