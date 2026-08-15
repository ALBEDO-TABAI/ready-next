import { sanitizeWidgetHtml, stripWidgetScripts } from '../../../components/document/widget-sanitizer'

export function sanitizeBookWidgetStaticHtml(html: string): string {
  return stripWidgetScripts(sanitizeWidgetHtml(html))
    .replace(/\s+id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/@import\s+[^;]+;?/gi, '')
    .replace(/url\s*\(\s*(['"]?)(?!data:)[^)]+\1\s*\)/gi, 'none')
    .replace(/position\s*:\s*(?:fixed|sticky)/gi, 'position: static')
}
