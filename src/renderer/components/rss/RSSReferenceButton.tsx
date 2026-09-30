import { MessageSquareQuote } from 'lucide-react'
import { addRSSReferenceToAgentInput } from '../../modules/agent/chat-input-bridge'
import type { RSSReference } from '../../../shared/rss-reference'

export default function RSSReferenceButton({ name, reference, disabled, label }: {
  name: string; reference: RSSReference | null; disabled?: boolean; label: string
}) {
  return <button type="button" className="rss-reader-button" disabled={disabled || !reference}
    onClick={() => { if (reference) addRSSReferenceToAgentInput(name, reference) }}>
    <MessageSquareQuote size={15} />{label}
  </button>
}
