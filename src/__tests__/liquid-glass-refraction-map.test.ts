import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRefractionMap } from '../renderer/components/ui/liquid-glass/refraction-map'

const GEOMETRY = { width: 200, height: 100, radius: 24, bevel: 20, depth: 12, ior: 1.5 }

function channelAt(map: ReturnType<typeof buildRefractionMap>, x: number, y: number) {
  const base = (y * map.pixelWidth + x) * 4
  return { r: map.data[base], g: map.data[base + 1], a: map.data[base + 3] }
}

test('flat interior and outside corners stay neutral', () => {
  const map = buildRefractionMap(GEOMETRY)
  const center = channelAt(map, 100, 50)
  assert.equal(center.r, 128)
  assert.equal(center.g, 128)

  // Pixel just inside the bounding box but outside the rounded corner.
  const corner = channelAt(map, 1, 1)
  assert.equal(corner.r, 128)
  assert.equal(corner.g, 128)

  // The whole map is opaque so feImage carries every texel.
  for (let i = 3; i < map.data.length; i += 4) {
    assert.equal(map.data[i], 255)
  }
})

test('edge band bends inward on every side', () => {
  const map = buildRefractionMap(GEOMETRY)
  const midBevel = 8 // inside the 20px bevel band, past the rim

  const left = channelAt(map, midBevel, 50)
  const right = channelAt(map, map.pixelWidth - 1 - midBevel, 50)
  const top = channelAt(map, 100, midBevel)
  const bottom = channelAt(map, 100, map.pixelHeight - 1 - midBevel)

  // Inward sampling: left edge looks right (+x ⇒ r > 128), right edge looks left.
  assert.ok(left.r > 140, `left bevel should push +x, got ${left.r}`)
  assert.ok(right.r < 116, `right bevel should push -x, got ${right.r}`)
  assert.ok(top.g > 140, `top bevel should push +y, got ${top.g}`)
  assert.ok(bottom.g < 116, `bottom bevel should push -y, got ${bottom.g}`)

  // Mirror symmetry between opposing edges.
  assert.equal(left.r - 128, -(right.r - 128))
  assert.equal(top.g - 128, -(bottom.g - 128))
})

test('displacement is physically bounded by glass thickness', () => {
  const map = buildRefractionMap(GEOMETRY)
  // Lateral shift can never exceed depth * tan(critical angle) ≈ depth * 0.9 for ior 1.5.
  assert.ok(map.maxDisplacement > 0)
  assert.ok(
    map.maxDisplacement <= GEOMETRY.depth * 0.9,
    `maxDisplacement ${map.maxDisplacement} exceeds optical bound`,
  )
})

test('zero depth produces a flat map with zero scale', () => {
  const map = buildRefractionMap({ ...GEOMETRY, depth: 0 })
  assert.equal(map.maxDisplacement, 0)
  const probe = channelAt(map, 8, 50)
  assert.equal(probe.r, 128)
  assert.equal(probe.g, 128)
})

test('dome curves the interior while keeping the exact center neutral', () => {
  const flat = buildRefractionMap(GEOMETRY)
  const domed = buildRefractionMap({ ...GEOMETRY, dome: 10 })

  // Near-center pixel (sampling grid sits 0.5px off true center on even
  // dimensions): dome gradient ≈ 0, neutral within one quantization step.
  const center = channelAt(domed, 100, 50)
  assert.ok(Math.abs(center.r - 128) <= 1, `center r ${center.r}`)
  assert.ok(Math.abs(center.g - 128) <= 1, `center g ${center.g}`)

  // Halfway to the right edge, inside the flat plateau: flat slab is neutral,
  // domed surface bends inward (samples toward center ⇒ r < 128).
  const probeX = 150
  const flatProbe = channelAt(flat, probeX, 50)
  const domedProbe = channelAt(domed, probeX, 50)
  assert.equal(flatProbe.r, 128)
  assert.ok(domedProbe.r < 126, `dome should bend interior inward, got ${domedProbe.r}`)

  // Still physically bounded by total glass height.
  assert.ok(domed.maxDisplacement <= (GEOMETRY.depth + 10) * 0.9)
})

test('resolution scales the bitmap but keeps displacement in css px', () => {
  const base = buildRefractionMap(GEOMETRY)
  const retina = buildRefractionMap({ ...GEOMETRY, resolution: 2 })
  assert.equal(retina.pixelWidth, GEOMETRY.width * 2)
  assert.equal(retina.pixelHeight, GEOMETRY.height * 2)
  // Same optics ⇒ same normalization (sampling grid differs slightly).
  assert.ok(Math.abs(retina.maxDisplacement - base.maxDisplacement) < 0.2)
})

// ── 2026-07-06 边缘曲线族（规格 §6.1 / glass.outpacestudios.com 同型模型）──

test('profile 缺省与 circular 逐字节一致（历史贴图零漂移守卫）', () => {
  const legacy = buildRefractionMap(GEOMETRY)
  const explicit = buildRefractionMap({ ...GEOMETRY, profile: 'circular' })
  assert.equal(explicit.maxDisplacement, legacy.maxDisplacement)
  assert.deepEqual(Array.from(explicit.data), Array.from(legacy.data))
})

test('squircle 把折弯集中到最外缘：rim 处更强、带内侧更平', () => {
  const circular = buildRefractionMap({ ...GEOMETRY, profile: 'circular' })
  const squircle = buildRefractionMap({ ...GEOMETRY, profile: 'squircle' })
  // 以绝对位移（CSS px）比较，消掉各自归一化增益
  const shiftAt = (map: ReturnType<typeof buildRefractionMap>, x: number, y: number) => {
    const { r } = channelAt(map, x, y)
    return Math.abs(r - 128) / 127 * map.maxDisplacement
  }
  const midY = Math.floor(GEOMETRY.height / 2)
  const rimX = GEOMETRY.width - 3            // bevel 带最外缘（t≈0.1）
  const innerX = GEOMETRY.width - Math.round(GEOMETRY.bevel * 0.8) // 带内侧（t≈0.8）
  assert.ok(
    shiftAt(squircle, rimX, midY) > shiftAt(circular, rimX, midY),
    'squircle 在最外缘的横向位移应大于 circular（折弯更集中）',
  )
  assert.ok(
    shiftAt(squircle, innerX, midY) < shiftAt(circular, innerX, midY),
    'squircle 在带内侧应更快回平（位移小于 circular）',
  )
  // 内部平面区仍然中性（两种曲线共享的硬性质）
  const center = channelAt(squircle, Math.floor(GEOMETRY.width / 2), midY)
  assert.equal(center.r, 128)
  assert.equal(center.g, 128)
})
