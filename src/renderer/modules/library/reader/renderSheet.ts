import type { LibraryBook } from '../../../../shared/library'
import { toLocalFileUrl } from '../../../utils/dragDrop'
import { hash, lookOf } from '../topics'
import { shelfBook } from '../presentation'
import { fontStack, type Layout, type Page, type Typo } from './paginate'
import { PAPERS } from './papers'
import { markerColor } from './marks'
import type { LoadedBook, TocItem } from './book'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/**
 * A printed page stands alone: it is also drawn into the WebGL page rasters, where no outside variable reaches. So the
 * sheet carries every colour it prints with — the paper the reader chose, the book's cloth and the highlight colours
 * (data), and the few Ready tokens a page shares (the signal dot, the bookplate's ink, light and shade), read now.
 */
function sheetColours(rec: LibraryBook, typo: Typo): string {
  const paper = PAPERS[typo.paper], look = lookOf(shelfBook(rec))
  const tokens = getComputedStyle(document.documentElement), token = (name: string) => tokens.getPropertyValue(name).trim()
  return `--pp:${paper.pp};--pp2:${paper.pp2};--pi:${paper.pi};--cc:${look.color};--cf:${look.fg};--sig:${token('--rn-accent')};`
    + `--plate:${PAPERS.white.pp};--plate-ink:${token('--rn-paper-ink')};--plate-ink3:${token('--rn-paper-ink-3')};--light:${token('--rn-light')};--shade:${token('--rn-shade')};`
    + `--mk-yellow:${markerColor('yellow')};--mk-green:${markerColor('green')};--mk-blue:${markerColor('blue')};--mk-pink:${markerColor('pink')};--mk-pen:${markerColor('pen')}`
}
/** A sheet with nothing printed on it (the back of the last leaf), on the same paper. */
export function blankSheet(rec: LibraryBook, typo: Typo): HTMLElement {
  const d = document.createElement('div')
  d.className = 'sheet'
  d.style.cssText = sheetColours(rec, typo)
  return d
}
export function renderSheet(i: number, L: Layout, book: LoadedBook, rec: LibraryBook, typo: Typo, latin: boolean, toc: TocItem[]): HTMLElement {
  const p: Page = L.pages[i];
  const d = document.createElement('div');
  const recto = i % 2 === 0;
  d.className = `sheet ${recto ? 'recto' : 'verso'} ${latin ? 'latin' : ''}`;
  d.dataset.pi = String(i);
  d.style.cssText = `--fs:${typo.size}px;--lh:${typo.lead};--pf:${fontStack(typo.font, latin)};${sheetColours(rec, typo)}`;
  const no = String((hash(rec.id) % 900) + 100);
  const cover = rec.coverPath ? toLocalFileUrl(rec.coverPath) : undefined;
  const folio = (n: number) => `<div class="pg-foot"><span>${String(n).padStart(3, '0')}</span><span class="dotx"></span></div>`;
  const goto = (html: string) => html.replace(/data-href="(-?\d+)#([^"]*)"/g, (_, c, a) => {
    const pg = (a && L.idPage.get(`${c}#${a}`)) ?? L.chapterPage[+c];
    return pg != null ? `data-goto="${pg + 1}"` : '';
  });
  switch (p.kind) {
    case 'cover':
      d.innerHTML = cover
        ? `<div class="pg-cover"><img src="${esc(cover)}" alt=""></div>`
        : `<div class="pg-cover type"><div class="k"><span>藏书</span><span>Nº ${no}</span></div><div class="m"><i></i><b></b></div><div class="t">${esc(rec.title)}</div><div class="a">${esc(rec.author || '')}</div></div>`;
      break;
    case 'plate':
      d.innerHTML = `<div class="pg-plate"><div class="ex"><p class="no">EX LIBRIS · Nº ${no}</p><div class="mk"><span></span><span></span><span></span><i></i></div><p class="h">藏书</p><p class="n">${esc(rec.title.slice(0, 18))}</p><span class="r" style="display:block"></span><p class="d">${new Date(rec.addedAt).toLocaleDateString('zh-CN')} 上架</p></div></div>`;
      break;
    case 'title':
      d.innerHTML = `<div class="pg-title"><p class="k">EX LIBRIS · Nº ${no}</p><p class="t">${esc(rec.title)}</p><p class="a">${esc(rec.author || '')}</p><span class="r"></span><p class="p">${[rec.publisher, rec.year, `${book.chapters.length} 章`, book.chars ? `${Math.round(book.chars / 1000)}k 字` : ''].filter(Boolean).map((x) => esc(String(x))).join('<br>')}</p></div>`;
      break;
    case 'toc': {
      const rows = toc.slice(p.tocFrom ?? 0, (p.tocFrom ?? 0) + 22).map((t) => {
        const pg = (t.anchor ? L.idPage.get(`${t.chapter}#${t.anchor}`) ?? L.chapterPage[t.chapter] : L.chapterPage[t.chapter]) + 1;
        return `<div class="toc-row d${Math.min(1, t.depth)}" data-goto="${pg}"><span class="tt">${esc(t.label)}</span><i></i><b>${String(pg).padStart(3, '0')}</b></div>`;
      }).join('');
      d.innerHTML = `<div class="pg-body pg-toc"><div class="pg-flow">${p.tocFrom ? '' : '<h2>目录</h2>'}${rows}</div></div>${folio(i + 1)}`;
      break;
    }
    case 'text': {
      d.innerHTML = `<div class="pg-head"><span>${recto ? esc(book.chapters[p.chapter]?.title || '') : esc(rec.title)}</span><span>${recto ? '' : esc(rec.author || '')}</span></div>`
        + `<div class="pg-body"><div class="pg-flow ${p.opens ? 'opens' : ''}">${goto(p.html)}</div></div>${folio(i + 1)}`;
      if (p.opens) d.querySelector('.pg-head')!.innerHTML = '';
      break;
    }
    case 'end':
      d.innerHTML = `<div class="pg-end"><p class="fin">完</p><span class="r"></span><p>${esc(rec.title)}<br>EX LIBRIS · Nº ${no}</p></div>`;
      break;
    case 'back':
      d.innerHTML = `<div class="pg-back"><span class="bm">EX LIBRIS</span></div>`;
      break;
    default:
      d.innerHTML = '<div class="pg-blank"></div>';
  }
  return d;
}
