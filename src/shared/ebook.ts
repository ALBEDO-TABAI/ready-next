export const EBOOK_EXTENSIONS = ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'cbz'] as const

export const EBOOK_EXTENSION_SET: ReadonlySet<string> = new Set(EBOOK_EXTENSIONS)

export const EBOOK_BINARY_EXTENSIONS: ReadonlySet<string> = new Set(
  EBOOK_EXTENSIONS.map((ext) => `.${ext}`),
)

export const EBOOK_MARKDOWN_MARKER = '<!-- ready:ebook-import -->'

export function normalizeEbookExtension(input: string | null | undefined): string {
  return (input || '').trim().toLowerCase().replace(/^\./, '')
}

export function isEbookExtension(input: string | null | undefined): boolean {
  return EBOOK_EXTENSION_SET.has(normalizeEbookExtension(input))
}

export function isEpubExtension(input: string | null | undefined): boolean {
  return normalizeEbookExtension(input) === 'epub'
}
