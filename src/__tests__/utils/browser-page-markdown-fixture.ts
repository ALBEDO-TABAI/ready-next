/** Stand-ins for a page that is asked for its Markdown by the read tool (`browser-page-markdown.ts`). */

/** Whether the script a fake page was given is the one that hands its content over as Markdown. */
export function isPageMarkdownScript(code: unknown): boolean {
  return typeof code === 'string' && code.includes('__READY_PAGE_MARKDOWN__')
}

/** What a document answers to that script. */
export function pageMarkdownDocument(markdown: string, page: { url?: string; title?: string } = {}) {
  return {
    ok: true,
    url: page.url ?? 'https://example.test/',
    title: page.title ?? '',
    markdown,
    hitHardLimit: false,
  }
}

const ANSWERING = Symbol('answers page markdown from getPageContent')

/**
 * Makes a fake controller answer the read tool's script with what its `getPageContent` holds, so a test
 * keeps saying "this page's text is …" in one place. Every other script goes to the controller's own
 * `executeJS`. Safe to call more than once on the same controller.
 */
export function answerPageMarkdownFromPageContent<T extends object>(controller: T): T {
  const fake = controller as T & {
    [ANSWERING]?: true
    executeJS?: (tabId: string | null, code: string, ...rest: unknown[]) => unknown
    getPageContent?: (tabId: string | null) => Promise<string> | string
  }
  if (fake[ANSWERING] || typeof fake.getPageContent !== 'function') return controller
  const original = typeof fake.executeJS === 'function' ? fake.executeJS : null
  fake.executeJS = async function (this: unknown, tabId: string | null, code: string, ...rest: unknown[]) {
    if (isPageMarkdownScript(code)) return pageMarkdownDocument(await fake.getPageContent!.call(fake, tabId))
    return original ? original.call(fake, tabId, code, ...rest) : null
  }
  fake[ANSWERING] = true
  return controller
}
