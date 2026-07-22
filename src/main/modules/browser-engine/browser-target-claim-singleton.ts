import { getDatabase } from '../database'
import {
  BrowserTargetClaimRepository,
  BrowserTargetClaimService,
} from './browser-target-claims'

let instance: BrowserTargetClaimService | null = null

export function getBrowserTargetClaimService(): BrowserTargetClaimService {
  if (!instance) {
    instance = new BrowserTargetClaimService(new BrowserTargetClaimRepository(getDatabase()))
  }
  return instance
}

export function __resetBrowserTargetClaimServiceForTests(): void {
  instance = null
}
