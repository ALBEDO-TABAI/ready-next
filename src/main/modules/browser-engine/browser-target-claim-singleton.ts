import { getDatabase } from '../database'
import {
  BrowserTargetClaimRepository,
  BrowserTargetClaimService,
} from './browser-target-claims'
import { getBrowserBootIncarnationId } from './automation-service'

let instance: BrowserTargetClaimService | null = null

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
