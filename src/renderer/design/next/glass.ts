/** Scoped port of 藏书阁/src/ui/glass: convex bevel field + specular overlay.
 * Optics © 2026 Glass HQ, MIT; see licenses/ready-next/LICENSE-liquid-glass.txt.
 * Each mounted surface owns its filter, observers and pending image decode.
 */
let nextId = 0
const NS = 'http://www.w3.org/2000/svg'
const sat = (x: number) => Math.max(0, Math.min(1, x))
function normal(px: number, py: number, hw: number, hh: number, r: number) {
  const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r)
  if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy); return [l - r, qx / l * Math.sign(px), qy / l * Math.sign(py)] }
  return qx > qy ? [qx - r, Math.sign(px) || 1, 0] : [qy - r, 0, Math.sign(py) || 1]
}
function map(w: number, h: number, r: number, overlay: boolean, dark: boolean): string | null {
  const scale = overlay ? Math.min(2, window.devicePixelRatio || 1) : 0.5
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(w * scale)); canvas.height = Math.max(2, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const image = ctx.createImageData(canvas.width, canvas.height)
  const bevel = Math.min(24, Math.max(10, r * .9))
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const [d, nx, ny] = normal((x + .5) / scale - w / 2, (y + .5) / scale - h / 2, w / 2, h / 2, r)
    const i = (y * canvas.width + x) * 4
    if (!overlay) {
      const depth = sat(-d / bevel), edge = d > 0 ? 0 : 1 - sat(Math.sqrt((2 - depth) * depth))
      image.data[i] = Math.round((.5 - nx * edge * .5) * 255)
      image.data[i + 1] = Math.round((.5 - ny * edge * .5) * 255)
      image.data[i + 2] = 128; image.data[i + 3] = 255
    } else {
      if (d < -6) continue
      const aa = 1 / scale, cs = Math.cos(1.08), cd = Math.cos(1.08 * .65), cside = Math.cos(.98)
      const coverage = sat(.5 - d / aa)
      const directional = Math.pow(sat((Math.abs(ny) - cs) / (1 - cs)), 1.25)
      const diffuseDir = Math.pow(sat((Math.abs(ny) - cd) / (1 - cd)), 1.25)
      const stroke = sat((d + .9) / aa + .5) * sat(.5 - d / aa)
      let spec = directional * stroke; spec /= 1 + .5 * (1 - spec)
      const diffuse = diffuseDir * .18 * Math.pow(1 - sat(-d / 4.5), 2) * coverage
      const hl = sat(spec * (dark ? .82 : 1) + diffuse * (dark ? .4 : 1))
      const adj = d - .5, falloff = 1 - sat(-adj / .5), ramp = (falloff > 0 ? .25 : 0) + falloff * .75
      const outline = ramp * sat((adj + .5) / aa + .5) * sat(-adj / aa + .5)
      const w1 = sat((nx - cside) / (1 - cside)) * outline, w2 = sat((-nx - cside) / (1 - cside)) * outline
      const shade = (w1 / (1 + .4 * (1 - w1)) + w2 / (1 + .4 * (1 - w2))) * (dark ? .6 : .48)
      const alpha = hl + shade * (1 - hl)
      if (alpha <= .002) continue
      const light = (dark ? .82 : 1) * hl / Math.max(alpha, 1e-5)
      image.data[i] = image.data[i + 1] = image.data[i + 2] = Math.round(light * 255)
      image.data[i + 3] = Math.round(alpha * 255)
    }
  }
  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}
function svgElement(name: string, attrs: Record<string, string>) {
  const el = document.createElementNS(NS, name)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  return el
}

export function attachGlass(surface: HTMLElement): () => void {
  const svg = svgElement('svg', { width: '0', height: '0', 'aria-hidden': 'true' })
  svg.style.cssText = 'position:absolute;pointer-events:none'
  const id = `rn-glass-${++nextId}`
  surface.append(svg)
  let disposed = false, revision = 0, frame = 0
  const refresh = () => {
    const own = ++revision, w = surface.offsetWidth, h = surface.offsetHeight
    if (w < 8 || h < 8) return
    const reduced = window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches
    if (reduced) { surface.style.backdropFilter = 'none'; surface.style.removeProperty('--rn-glass-overlay'); return }
    const r = Math.min(parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0, h / 2, w / 2)
    const dark = document.documentElement.dataset.theme === 'dark'
    const overlay = map(w, h, r, true, dark)
    if (overlay) surface.style.setProperty('--rn-glass-overlay', `url(${overlay})`)
    // Ready uses Chromium. Other engines retain the same CSS blur, tint and rim.
    if (!/Chrom(e|ium)|Edg\//.test(navigator.userAgent)) return
    const field = map(w, h, r, false, dark)
    if (!field) return
    const filter = svgElement('filter', { id, x: '0', y: '0', width: String(w), height: String(h), filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })
    filter.append(svgElement('feImage', { href: field, width: String(w), height: String(h), preserveAspectRatio: 'none', result: 'map' }),
      svgElement('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: '28', xChannelSelector: 'R', yChannelSelector: 'G' }),
      svgElement('feGaussianBlur', { stdDeviation: surface.dataset.mat === 'clear' ? '3' : '12' }))
    const transfer = svgElement('feComponentTransfer', {})
    transfer.append(svgElement('feFuncA', { type: 'linear', slope: '4', intercept: '0' }))
    filter.append(transfer, svgElement('feColorMatrix', { type: 'saturate', values: '1.8' }))
    svg.replaceChildren(filter)
    const image = new Image(); image.src = field
    image.decode().then(() => { if (!disposed && revision === own) surface.style.backdropFilter = `url(#${id})` }).catch(() => {
      // A failed map leaves the native blur material visible.
      if (!disposed && revision === own) surface.style.backdropFilter = ''
    })
  }
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(refresh) }
  const resize = new ResizeObserver(schedule); resize.observe(surface)
  const theme = new MutationObserver(schedule); theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const pointer = (e: PointerEvent) => {
    const rect = surface.getBoundingClientRect()
    surface.style.setProperty('--rn-la', `${Math.atan2(e.clientY - rect.top - rect.height / 2, e.clientX - rect.left - rect.width / 2) * 180 / Math.PI + 90}deg`)
  }
  surface.addEventListener('pointermove', pointer); schedule()
  return () => { disposed = true; revision++; cancelAnimationFrame(frame); resize.disconnect(); theme.disconnect(); surface.removeEventListener('pointermove', pointer); svg.remove(); surface.style.backdropFilter = ''; surface.style.removeProperty('--rn-glass-overlay') }
}
