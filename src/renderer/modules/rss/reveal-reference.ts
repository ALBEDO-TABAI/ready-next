import { RSSReferenceSchema, type RSSReference } from '../../../shared/rss-reference'
import { requestWorkbenchModeOpen } from '../workbench/mode-transition'
import { useRSSSession } from '../../stores/useRSSSession'

/** Explicit user navigation only. The mounted RSS owner revalidates the saved version before showing it. */
export function revealRSSReference(input: RSSReference): void {
  const reference = RSSReferenceSchema.parse(input)
  useRSSSession.getState().requestReveal(reference)
  requestWorkbenchModeOpen('rss')
}
