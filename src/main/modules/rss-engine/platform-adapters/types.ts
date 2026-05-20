/**
 * Stage U PR U8.2 — RSS platform acquisition adapter contract.
 *
 * Audit §2.3 / §3.7 fault: platform-specific rules are scattered across
 * `scrapers/index.ts` (detect) and `browser-acquisition.ts` (validate +
 * extract + normalize). When the two get out of sync, detect can match
 * a platform but acquisition drops the candidate via an unrelated regex.
 *
 * This module declares the canonical contract every platform must
 * implement. U8.2a establishes the contract + the
 * `check-rss-platform-rule-single-source.cjs` CI gate. U8.2b will migrate
 * each existing platform's scattered rules into a concrete adapter.
 */

import type { PlatformType } from '../scrapers/index'

/**
 * Canonical acquisition contract per platform. A migrated adapter owns:
 *   - detect: URL → does this URL belong to the platform?
 *   - validate: candidate link → is it acceptable for ingestion?
 *   - extract: page payload → ScrapedItem fields (handled by the
 *     concrete scraper today; the adapter is the source of truth for
 *     selectors / regex patterns that the scraper consumes).
 *   - normalize: post-extraction normalization (URL canonicalization,
 *     userId extraction, etc.).
 *
 * Returning `null` from any step means "this URL is not for this
 * platform / not valid for ingestion / not normalizable" — the caller
 * uses that signal, never silently drops the candidate.
 */
export interface PlatformAcquisitionAdapter {
  /** Unique platform id matching the existing `PlatformType` union. */
  readonly platform: PlatformType
  /** Human-readable name (logs, diagnostics). */
  readonly displayName: string
  /**
   * Detect whether a URL belongs to this platform. Adapters must answer
   * deterministically — no shared `detectPlatform` regex sprawl.
   */
  detect(url: string): boolean
  /**
   * Decide whether a candidate item link is acceptable for ingestion.
   * Replaces `isValidBrowserCandidateLink` per-platform branches.
   */
  validateCandidateLink(link: string): boolean
  /**
   * Optional: a stable "userId" / "channel" key extracted from any URL
   * belonging to this platform. Returns null if no stable key exists.
   * Replaces `extractWeiboUserId`-style ad-hoc helpers.
   */
  extractStableUserKey?(url: string): string | null
}

/** Registry mapping platform → adapter. U8.2b populates this map. */
export type PlatformAdapterRegistry = ReadonlyMap<PlatformType, PlatformAcquisitionAdapter>

/**
 * U8.2a stub. U8.2b will replace this with a full registry holding
 * concrete adapters for each platform listed in the `PlatformType` union.
 * Keeping the registry empty for now means the existing scraper +
 * acquisition code paths continue to own the rules; the CI gate only
 * fences *new* rule additions to live inside this directory.
 */
export const PLATFORM_ADAPTER_REGISTRY: PlatformAdapterRegistry = new Map()

/**
 * Lookup helper for callers that want to dispatch through an adapter.
 * Returns null when no adapter is registered for the platform (caller
 * must keep its legacy code path until U8.2b migrates it).
 */
export function getPlatformAdapter(platform: PlatformType): PlatformAcquisitionAdapter | null {
  return PLATFORM_ADAPTER_REGISTRY.get(platform) ?? null
}
