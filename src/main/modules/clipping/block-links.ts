/**
 * Markdown link text cannot hold blocks. A page link that wraps a whole card (picture, title, blurb) would
 * otherwise come out as `[![photo](src)\n\n## Title](href)`, which no reader can parse back into a link.
 */

const BLOCKS = [
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
].join(', ')
const BLOCK_NAMES = new Set(BLOCKS.split(', ').map((name) => name.toUpperCase()))

/**
 * Moves each block-wrapping link onto the inline content inside it, so every picture and text run keeps the
 * link and every block stays a block. A heading inside a card that also carries a picture is the card's
 * caption, not a section of the article, so it becomes a paragraph.
 */
export function pushLinksIntoBlocks(root: Element): void {
  const document = root.ownerDocument
  // Later anchors first: a link nested in another is settled before its ancestor.
  for (const anchor of Array.from(root.querySelectorAll('a[href]')).reverse()) {
    if (!anchor.querySelector(BLOCKS)) continue
    if (anchor.querySelector('img, picture, video')) {
      for (const heading of Array.from(anchor.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
        const caption = document.createElement('p')
        caption.append(...Array.from(heading.childNodes))
        heading.replaceWith(caption)
      }
    }
    linkInlineRuns(anchor, anchor)
    anchor.replaceWith(...Array.from(anchor.childNodes))
  }
}

function linkInlineRuns(container: Element, anchor: Element): void {
  let run: ChildNode[] = []
  const flush = () => {
    const first = run[0]
    // A run that already carries its own link keeps that link.
    if (first && run.some(carriesContent) && !run.some(holdsLink)) {
      const link = anchor.cloneNode(false) as Element
      container.insertBefore(link, first)
      link.append(...run)
    }
    run = []
  }
  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === 1 && (BLOCK_NAMES.has(child.nodeName) || (child as Element).querySelector(BLOCKS))) {
      flush()
      linkInlineRuns(child as Element, anchor)
    } else {
      run.push(child)
    }
  }
  flush()
}

function carriesContent(node: ChildNode): boolean {
  if (node.nodeType === 3) return Boolean(node.textContent?.trim())
  if (node.nodeType !== 1) return false
  const element = node as Element
  return element.nodeName === 'IMG' || Boolean(element.querySelector('img')) || Boolean(element.textContent?.trim())
}

function holdsLink(node: ChildNode): boolean {
  if (node.nodeType !== 1) return false
  const element = node as Element
  return element.nodeName === 'A' || Boolean(element.querySelector('a[href]'))
}
