import type { LinkPreviewData, LinkPreviewSource } from '../../components/canvas/cards/LinkCard'

// Link previews of one open board: each address is asked for once per session (a failure too — a card scrolling
// in and out of view must not hit the network again); 刷新预览 forgets the answer and asks anew. The durable copy
// lives on the card itself (`ready.preview`, cover in the board's attachments), written by the board document.

export interface LinkPreviews extends LinkPreviewSource { refresh(url: string): Promise<LinkPreviewData> }
export function createLinkPreviews(fetch: (url: string) => Promise<LinkPreviewData>): LinkPreviews {
  const known = new Map<string, Promise<LinkPreviewData>>()
  const read = (url: string) => {
    let pending = known.get(url)
    if (!pending) { pending = fetch(url); known.set(url, pending); pending.catch(() => undefined) }
    return pending
  }
  return { read, refresh: url => { known.delete(url); return read(url) } }
}
