import type { Typo } from './paginate'

/**
 * The reading papers a reader chooses in 排版 (白纸, 米黄, 夜间): the page, its edge and its ink. They are the book's
 * own colours, printed into the page rasters, so they are data and not interface tokens (W1 §6 whitelist).
 */
export const PAPERS: Record<Typo['paper'], { pp: string; pp2: string; pi: string }> = {
  white: { pp: '#fbfaf7', pp2: '#f0eee9', pi: '#18181a' },
  cream: { pp: '#f5efe2', pp2: '#ebe2cf', pi: '#2b241b' },
  night: { pp: '#202022', pp2: '#2a2a2d', pi: '#c9c4ba' },
}
