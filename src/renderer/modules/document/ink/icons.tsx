import * as L from 'lucide-react'
import type { CSSProperties } from 'react'

// Ported from Inkwell's icon registry (Lucide glyphs) plus its original page glyph.
const REG = {
  home: L.House, chat: L.MessageCircle, calendar: L.CalendarDays, search: L.Search, library: L.LibraryBig,
  newChat: L.MessageCirclePlus, page: L.FileText, table: L.Table2, plus: L.Plus, more: L.Ellipsis,
  chevronRight: L.ChevronRight, chevronLeft: L.ChevronLeft, chevronDown: L.ChevronDown, file: L.File, code2: L.FileCode2, star: L.Star, link: L.Link2, smile: L.Smile, image: L.Image,
  trash: L.Trash2, copy: L.Copy, move: L.CornerUpRight, rename: L.PencilLine, check: L.Check, x: L.X,
  sliders: L.SlidersHorizontal, comment: L.MessageSquareText, panelRight: L.PanelRight, toc: L.TableOfContents,
  fullWidth: L.MoveHorizontal, smallText: L.AArrowDown, book: L.BookOpen, download: L.Download, folder: L.Folder,
  folderOpen: L.FolderOpen, template: L.LayoutTemplate, import: L.Import, sidebarClose: L.PanelLeftClose,
  sidebarOpen: L.PanelLeftOpen, code: L.Code, eye: L.Eye, eyeOff: L.EyeOff, restore: L.RotateCcw, archiveRestore: L.ArchiveRestore,
  newPage: L.FilePlus2, ai: L.Sparkles, externalLink: L.ExternalLink, graph: L.Network, upload: L.Upload,
  columns: L.Columns2, undo: L.Undo2, bookmark: L.BookMarked, shapes: L.Shapes, outline: L.ListTree, inbox: L.Inbox,
}
export type IconName = keyof typeof REG

export function Icon({ name, size = 20, stroke = 1.5, style, className }: { name: IconName; size?: number; stroke?: number; style?: CSSProperties; className?: string }) {
  const Glyph = REG[name]
  return <Glyph size={size} strokeWidth={stroke} style={{ flexShrink: 0, display: 'block', ...style }} className={className} aria-hidden />
}

/** Inkwell's page glyph for pages without an icon (a folded-corner sheet). */
export function PageGlyph({ size = 20, empty = false }: { size?: number; empty?: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round" aria-hidden style={{ display: 'block', flexShrink: 0 }}>
    <path d="M5.5 3.25h6l3.25 3.25v9.25a1 1 0 0 1-1 1h-8.25a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z" />
    <path d="M11.25 3.4v3.35h3.35" />
    {empty ? null : <path d="M7.25 10.25h5.5M7.25 12.75h5.5" strokeLinecap="round" />}
  </svg>
}

