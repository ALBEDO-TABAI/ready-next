import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import { loadBook } from '../../../renderer/modules/library/reader/book'
import type { LibraryHighlightContext } from '../../../shared/library'

/** Same parser and sanitized text as the reader, with no scripts/resources/network enabled. */
export async function archiveChapters(bytes: Uint8Array, ext: string, title: string): Promise<LibraryHighlightContext['chapters']> {
  if (!['epub', 'txt', 'md'].includes(ext)) return [{ title: '未定位', text: '' }]
  const dom = new JSDOM(''), parser = new dom.window.DOMParser(), serializer = new dom.window.XMLSerializer()
  const purifier = createDOMPurify(dom.window)
  let urls: string[] = []
  try {
    const book = await loadBook(Uint8Array.from(bytes).buffer, ext, title, {
      parseXml: text => parser.parseFromString(text, 'application/xml'),
      parseDoc: text => {
        const xml = parser.parseFromString(text, 'application/xhtml+xml')
        return xml.getElementsByTagName('parsererror').length ? parser.parseFromString(text, 'text/html') : xml
      },
      serialize: node => serializer.serializeToString(node),
      sanitize: (html, config) => purifier.sanitize(html, config),
    })
    urls = book.urls
    const chapters = book.chapters.map(chapter => {
      const template = dom.window.document.createElement('template'); template.innerHTML = chapter.html
      return { title: chapter.title, text: template.content.textContent ?? '' }
    })
    return chapters.length ? chapters : [{ title, text: '' }]
  } finally { urls.forEach(url => URL.revokeObjectURL(url)); dom.window.close() }
}
