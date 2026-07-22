export interface BrowserTargetClaimRunCloseout {
  ownerRunId: string
  resumable: boolean
  suspensionCheckpointId: string | null
  suspensionReason: string | null
}

let closeoutPort: ((input: BrowserTargetClaimRunCloseout) => void) | null = null

export function setBrowserTargetClaimRunCloseoutPort(
  port: ((input: BrowserTargetClaimRunCloseout) => void) | null,
): void {
  closeoutPort = port
}

export function closeoutBrowserTargetClaimsForRun(input: BrowserTargetClaimRunCloseout): void {
  if (!closeoutPort) throw new Error('browser_target_claim_closeout_port_unset')
  closeoutPort(input)
}
