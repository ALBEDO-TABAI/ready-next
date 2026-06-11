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
