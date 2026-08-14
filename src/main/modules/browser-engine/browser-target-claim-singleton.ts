import { getDatabase } from '../database'
import {
  BrowserTargetClaimRepository,
  BrowserTargetClaimService,
} from './browser-target-claims'
import { getBrowserBootIncarnationId } from './automation-service'

let instance: BrowserTargetClaimService | null = null

export const __breaksInvariants = ['browser target claim singleton state'] as const

export function getBrowserTargetClaimService(): BrowserTargetClaimService {
  if (!instance) {
    instance = new BrowserTargetClaimService(new BrowserTargetClaimRepository(getDatabase()))
    instance.expirePreviousBoot(getBrowserBootIncarnationId())
  }
  return instance
}

export function __resetBrowserTargetClaimServiceForTests(): void {
  instance = null
}

export function __setBrowserTargetClaimServiceForTests(
  service: BrowserTargetClaimService | null,
): void {
  instance = service
}
