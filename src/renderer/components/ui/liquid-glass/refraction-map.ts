/**
 * Physically-derived displacement map for the liquid-glass lens.
 *
 * Model: the lens is a glass slab lying on the backdrop. Its top surface is
 * flat in the interior and rolls off with a circular bevel inside the last
 * `bevel` px before the rounded-rect edge. A vertical view ray refracts at
 * the curved top surface (Snell, air -> glass) and travels through the
 * remaining glass thickness before hitting the backdrop, which laterally
 * shifts the sampled backdrop point. Flat interior ⇒ zero shift (stays
 * crisp); the bevel band ⇒ strong inward-pointing shift (edge magnification,
 * never samples outside the element, so no streaking at the rim).
 *
 * Output encodes the shift into R (x) / G (y) around the 128 neutral point,
 * normalized by `maxDisplacement` so the SVG consumer sets
 * `feDisplacementMap scale = 2 * maxDisplacement`.
 *
 * Pure math, no DOM — keep it that way so it stays trivially testable.
 */

/**
 * Edge height profile of the bevel band.
 * - 'circular'（旧默认）：四分之一圆弧 H = depth·√(t(2−t))。
 * - 'squircle'：超椭圆-4 滚落 H = depth·(1−(1−t)⁴)^¼ —— 折弯更集中在最外缘、
 *   内侧更快回平（规格 §6.1 追求的「弧边压弯感」；斜率闭式
 *   dH/dt = depth·(1−t)³/(1−(1−t)⁴)^¾，与 glass.outpacestudios.com 的
 *   实测最优曲线同型）。
 */
export type RefractionEdgeProfile = 'circular' | 'squircle'

export interface RefractionGeometry {
  /** Element size in CSS px. */
  width: number
  height: number
  /** Corner radius in CSS px (clamped to half of the short side). */
  radius: number
  /** Width of the refracting edge band in CSS px. */
  bevel: number
  /** Optical thickness of the glass in CSS px — drives bend distance. */
  depth: number
  /** Index of refraction; 1 ⇒ no bend, glass ≈ 1.5. */
  ior: number
  /**
   * Extra interior curvature in CSS px: domes the whole top surface as a
   * shallow elliptic paraboloid so the center magnifies gently instead of
   * staying optically flat. 0 = flat slab (only the bevel band refracts).
   */
  dome?: number
  /** Edge rolloff shape; default 'circular'（与历史贴图逐字节一致）. */
  profile?: RefractionEdgeProfile
  /** Bitmap pixels per CSS px (devicePixelRatio), default 1. */
  resolution?: number
}

export interface RefractionMap {
  /** RGBA bitmap, R/G = x/y displacement, 128 = neutral, alpha opaque. */
  data: Uint8ClampedArray<ArrayBuffer>
  pixelWidth: number
  pixelHeight: number
  /** CSS px encoded at full channel deflection; 0 when the map is flat. */
  maxDisplacement: number
}

export function buildRefractionMap(geometry: RefractionGeometry): RefractionMap {
  const resolution = Math.max(geometry.resolution ?? 1, 0.1)
  const width = Math.max(geometry.width, 1)
  const height = Math.max(geometry.height, 1)
  const pixelWidth = Math.max(1, Math.round(width * resolution))
  const pixelHeight = Math.max(1, Math.round(height * resolution))
  const radius = Math.max(0, Math.min(geometry.radius, width / 2, height / 2))
  const bevel = Math.max(0.5, Math.min(geometry.bevel, width / 2, height / 2))
  const depth = Math.max(0, geometry.depth)
  const dome = Math.max(0, geometry.dome ?? 0)
  const eta = 1 / Math.max(geometry.ior, 1.0001)

  const count = pixelWidth * pixelHeight
  const offsets = new Float32Array(count * 2)
  let maxDisplacement = 0

  const halfW = width / 2
  const halfH = height / 2
  const coreX = halfW - radius
  const coreY = halfH - radius

  for (let py = 0; py < pixelHeight; py += 1) {
    // Sample at pixel centers, in CSS px, centered on the element.
    const y = (py + 0.5) / resolution - halfH
    for (let px = 0; px < pixelWidth; px += 1) {
      const x = (px + 0.5) / resolution - halfW
      const index = (py * pixelWidth + px) * 2

      // Signed distance to the rounded rect, plus the outward direction.
      const qx = Math.abs(x) - coreX
      const qy = Math.abs(y) - coreY
      let sdf: number
      let outX = 0
      let outY = 0
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy)
        sdf = len - radius
        outX = (qx / len) * Math.sign(x)
        outY = (qy / len) * Math.sign(y)
      } else if (qx > qy) {
        sdf = qx - radius
        outX = Math.sign(x)
      } else {
        sdf = qy - radius
        outY = Math.sign(y)
      }

      const inside = -sdf // distance from the edge, positive inside
      if (inside <= 0 || (depth === 0 && dome === 0)) {
        continue // outside the glass, or a fully flat slab: neutral
      }

      // Bevel band: height 0 at the rim, `depth` where it meets the top.
      // gx/gy accumulate -∇H (the outward tilt of the surface normal).
      let heightField = depth
      let gx = 0
      let gy = 0
      if (depth > 0 && inside < bevel) {
        const t = inside / bevel
        let slope: number
        if (geometry.profile === 'squircle') {
          const u = 1 - t
          const base = 1 - u * u * u * u
          heightField = depth * base ** 0.25
          slope = (depth * u * u * u) / (bevel * base ** 0.75)
        } else {
          heightField = depth * Math.sqrt(t * (2 - t))
          slope = (depth * (1 - t)) / (bevel * Math.sqrt(t * (2 - t)))
        }
        gx = slope * outX
        gy = slope * outY
      }

      // Shallow dome over the whole face: H += dome·(1 − rx² − ry²), clamped
      // at the inscribed ellipse — gradient must clamp with it.
      if (dome > 0) {
        const rx = x / halfW
        const ry = y / halfH
        const domeBase = 1 - rx * rx - ry * ry
        if (domeBase > 0) {
          heightField += dome * domeBase
          gx += (2 * dome * rx) / halfW
          gy += (2 * dome * ry) / halfH
        }
      }

      const invLen = 1 / Math.hypot(gx, gy, 1)
      const nx = gx * invLen
      const ny = gy * invLen
      const nz = invLen

      // Refract the straight-down view ray (0,0,-1) into the glass.
      const cosI = nz
      const sin2T = eta * eta * (1 - cosI * cosI)
      const cosT = Math.sqrt(Math.max(0, 1 - sin2T))
      const k = eta * cosI - cosT // negative ⇒ bends inward
      const tz = -eta + k * nz
      const travel = heightField / Math.max(1e-6, -tz)
      const offsetX = k * nx * travel
      const offsetY = k * ny * travel

      offsets[index] = offsetX
      offsets[index + 1] = offsetY
      const magnitude = Math.max(Math.abs(offsetX), Math.abs(offsetY))
      if (magnitude > maxDisplacement) maxDisplacement = magnitude
    }
  }

  const data = new Uint8ClampedArray(count * 4)
  const gain = maxDisplacement > 0 ? 127 / maxDisplacement : 0
  for (let i = 0; i < count; i += 1) {
    const base = i * 4
    data[base] = 128 + offsets[i * 2] * gain
    data[base + 1] = 128 + offsets[i * 2 + 1] * gain
    data[base + 2] = 128
    data[base + 3] = 255
  }

  return { data, pixelWidth, pixelHeight, maxDisplacement }
}
