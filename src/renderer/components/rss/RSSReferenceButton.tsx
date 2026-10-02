import { MessageSquareQuote } from 'lucide-react'
import { addRSSReferenceToAgentInput } from '../../modules/agent/chat-input-bridge'
import type { RSSReference } from '../../../shared/rss-reference'

export default function RSSReferenceButton({ name, reference, disabled, label, preserveSelection, className = 'rss-btn', onDone }: {
  name: string; reference: RSSReference | null; disabled?: boolean; preserveSelection?: boolean; label: string; className?: string; onDone?(): void
}) {
  return <button type="button" className={className} disabled={disabled || !reference}
    onMouseDown={(event) => { if (preserveSelection) event.preventDefault() }}
    onClick={() => { if (reference) { addRSSReferenceToAgentInput(name, reference); onDone?.() } }}>
    <MessageSquareQuote size={15} strokeWidth={1.8} />{label}
  </button>
}
