export type ReadyAgentRuntimeKind = 'direct' | 'sdk'

function normalizeFlag(value: string | undefined): string | null {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized || null
}

export function resolveReadyAgentRuntimeKind(
  env: Record<string, string | undefined> = process.env,
): ReadyAgentRuntimeKind {
  const runtime = normalizeFlag(env.READY_AGENT_RUNTIME)
  if (runtime === 'sdk') return 'sdk'
  if (runtime === 'direct') return 'direct'

  const sdkFlag = normalizeFlag(env.READY_AGENT_SDK_RUNTIME)
  if (!sdkFlag) return 'sdk'
  return sdkFlag === '0' || sdkFlag === 'false' || sdkFlag === 'off'
    ? 'direct'
    : 'sdk'
}

export function isReadyAgentSdkRuntimeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolveReadyAgentRuntimeKind(env) === 'sdk'
}
