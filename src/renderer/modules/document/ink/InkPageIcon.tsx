import { DynamicIcon, iconNames, type IconName as LucideName } from 'lucide-react/dynamic'
import type { PageNode } from '../../../../shared/document-pages'
import { Icon, PageGlyph } from './icons'

const isLucide = (name: string): name is LucideName => iconNames.some((icon: string) => icon === name)

/** A page's icon at Inkwell's sizes: an emoji, a named Lucide glyph ("lucide:star"), or the default sheet. */
export function InkPageIcon({ value, kind = 'page', size = 20, emojiSize }: { value?: string; kind?: PageNode['kind']; size?: number; emojiSize?: number }) {
  if (value?.startsWith('lucide:')) {
    const name = value.slice(7)
    if (isLucide(name)) return <DynamicIcon name={name} size={size} strokeWidth={1.6} aria-hidden style={{ display: 'block', flexShrink: 0 }} />
  } else if (value && !/[/.\\]/.test(value)) {
    return <span className="ink-emoji" style={{ fontSize: emojiSize ?? Math.round(size * 0.8), lineHeight: 1, width: size, height: size }} aria-hidden>{value}</span>
  }
  if (kind === 'folder' || kind === 'vault') return <Icon name="folder" size={size} stroke={1.4} />
  if (kind === 'canvas') return <Icon name="shapes" size={size} stroke={1.4} />
  return <PageGlyph size={size} />
}

export const PAGE_ICON_CHOICES = ['📄', '📝', '📌', '💡', '🌱', '📚', '🗓️', '✅', '⭐', '🔖', '🧭', '🎯', '🧪', '🎨', '🎬', '📷',
  '🏠', '💼', '🧠', '❤️', '🔥', '☕', '🌙', '🌊', 'lucide:book-open', 'lucide:star', 'lucide:heart', 'lucide:lightbulb',
  'lucide:flag', 'lucide:compass', 'lucide:camera', 'lucide:sparkles']
