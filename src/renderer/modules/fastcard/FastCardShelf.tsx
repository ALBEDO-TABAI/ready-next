import { useState } from 'react'
import { renderFastCardMarkdown } from '../../../shared/fastcard'
import FastCardPanel, { FastCardSaveDialog } from '../../components/browser/FastCardPanel'
import { Button } from '../../components/ui/Button'
import { useFastCard } from '../../stores/useFastCard'
import { appendToAgentInput } from '../agent/chat-input-bridge'
import { openReadyRef } from '../workbench/open-ready-ref'

// The FastCard shelf outside the browser (W4 §6, MS6). In the browser the same panel sits in its overlay window
// above the native web layer; in the document, 资讯 and calendar modes it is a drawer in the content area.
export function FastCardShelf({ visible }: { visible: boolean }) {
  const revealTarget = useFastCard(state => state.revealTarget)
  const open = useFastCard(state => state.panelOpen)
  const items = useFastCard(state => state.items)
  const syncState = useFastCard(state => state.syncState)
  const transferReceipt = useFastCard(state => state.transferReceipt)
  const [saving, setSaving] = useState<string[] | null>(null)
  if (!visible || (!open && !transferReceipt)) return null
  const store = useFastCard.getState
  const report = (error: unknown) => useFastCard.setState({ syncState: { kind: 'error', message: error instanceof Error ? error.message : String(error) } })
  return <div className="fc-drawer rn-float" data-fastcard-shelf>
    {saving ? <FastCardSaveDialog
      onSave={target => store().saveToCanvas(saving, target)}
      onRetry={request => store().retryTransfer(request)}
      onCancel={() => setSaving(null)} />
      : transferReceipt ? <div role="status" className="fc-receipt">
        <span>已存到《{transferReceipt.title}》</span>
        <Button size="sm" onClick={() => { void openReadyRef({ kind: 'canvas', id: transferReceipt.objectId }, 'document').then(() => store().dismissReceipt(), report) }}>打开</Button>
        <Button size="sm" variant="ghost" disabled={syncState.kind === 'saving'} onClick={() => { void store().undoTransfer() }}>撤销</Button>
        <Button size="sm" variant="ghost" onClick={() => store().dismissReceipt()}>关闭</Button>
      </div>
        : <FastCardPanel revealTarget={revealTarget} items={items} syncState={syncState}
          onCollapse={() => store().collapse()}
          onClear={() => { void store().clear() }}
          onSaveCanvas={itemIds => setSaving(itemIds)}
          onInsertToChat={itemIds => {
            const chosen = items.filter(item => itemIds.includes(item.id))
            if (chosen.length) appendToAgentInput(renderFastCardMarkdown(chosen))
          }}
          onRemoveItem={id => { void store().removeItem(id) }} />}
  </div>
}
