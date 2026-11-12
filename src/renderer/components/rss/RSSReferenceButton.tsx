import { MessageSquareQuote } from 'lucide-react'
import { addRSSReferenceToAgentInput } from '../../modules/agent/chat-input-bridge'
import type { RSSReference } from '../../../shared/rss-reference'
import { Button } from '../ui/Button'

// Hands an RSS reference (an issue, an article, a query) to the assistant's composer; the shared ghost button (W1 §5).
export default function RSSReferenceButton({ name, reference, disabled, label, onDone }: {
  name: string; reference: RSSReference | null; disabled?: boolean; label: string; onDone?(): void
}) {
  return <Button variant="ghost" size="sm" icon={<MessageSquareQuote />} disabled={disabled || !reference}
    onClick={() => { if (reference) { addRSSReferenceToAgentInput(name, reference); onDone?.() } }}>{label}</Button>
}
