import { RSSReferenceSchema, type RSSNavigableReference } from '../../../shared/rss-reference'
import { requestWorkbenchModeOpen } from '../workbench/mode-transition'
import { useRSSSession } from '../../stores/useRSSSession'

/** Explicit user navigation only. The mounted RSS owner revalidates the saved version before showing it. */
export function revealRSSReference(input: RSSNavigableReference): void {
  const reference = RSSReferenceSchema.parse(input)
  if (reference.kind === 'query') throw new Error('筛选引用请在预览中按保存的范围读取。')
  useRSSSession.getState().requestReveal(reference)
  requestWorkbenchModeOpen('rss')
}
