/**
 * 阅读模式卷曲数学合同：角轮廓连续单调、角度封顶、
 * 遮光阴区间与正反页条带映射。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOOK_CURL_ANGLE_CEILING,
  BOOK_CURL_MAX_ANGLE,
  backShadeForAngle,
  buildCurlFrame,
  curlAngleAt,
  curlProgress,
  frontShadeForAngle,
  leafGutterOpacityForTheta,
  resolveDragSkew,
  resolveLeafSlotTransform,
} from '../renderer/modules/document/book/bookCurlMath'

test('叶片内容映射：正反面与后翻只反排源条带，可见文字不再二次镜像', () => {
  const transform = (mirrored: boolean, backFace: boolean) => resolveLeafSlotTransform({
    sliceIndex: 2,
    sliceWidth: 10,
    pageWidth: 120,
    mirrored,
    backFace,
  })
  assert.equal(transform(false, false), 'translateX(-20px)')
  assert.equal(transform(false, true), 'translateX(-90px)')
  assert.equal(transform(true, false), 'translateX(100px) scaleX(-1)')
  assert.equal(transform(true, true), 'translateX(30px) scaleX(-1)')
})

test('curlAngleAt：s 单调不减、永不超过上限；起翻时书脊侧仅轻抬', () => {
  for (const theta of [0.2, 0.8, Math.PI / 2, Math.PI * 0.9, Math.PI]) {
    assert.ok(curlAngleAt(0, theta) >= 0)
    if (theta <= 0.8) {
      assert.ok(curlAngleAt(0, theta) <= theta * 0.35 + 1e-9, `起翻书脊侧不应抬太高：${curlAngleAt(0, theta)}`)
    }
    let previous = 0
    for (let s = 0.02; s <= 1.0001; s += 0.02) {
      const angle = curlAngleAt(Math.min(s, 1), theta)
      assert.ok(angle >= previous - 1e-9, `theta=${theta} s=${s} 角度回退 ${previous}→${angle}`)
      assert.ok(angle <= BOOK_CURL_ANGLE_CEILING + 1e-9, `theta=${theta} s=${s} 越过上限 ${angle}`)
      previous = angle
    }
  }
})

test('curlAngleAt：固定 s 时随 theta 单调（封顶前），满翻时贴近上限', () => {
  for (const s of [0.3, 0.6, 0.9]) {
    assert.ok(curlAngleAt(s, 1.2) >= curlAngleAt(s, 0.6))
  }
  assert.ok(Math.abs(curlAngleAt(1, Math.PI) - BOOK_CURL_ANGLE_CEILING) < 1e-9)
})

test('curlAngleAt：书脊切线必须跨整段落页连续转向，末段不得突然摊宽', () => {
  const rootAngles = Array.from(
    { length: 101 },
    (_, index) => curlAngleAt(0, Math.PI * index / 100),
  )
  const largestStep = Math.max(
    ...rootAngles.slice(1).map((value, index) => value - rootAngles[index]),
  )
  assert.ok(largestStep < 0.105, `书脊切线单步变化过大，会在末段形成拉伸复位：${largestStep}`)
})

test('curlAngleAt：早期弯曲集中在页缘（剥离感），满翻时全页摊平到上限', () => {
  // Θ 较小时，页缘处角度占绝对主导（卷曲峰在页缘）
  const early = curlAngleAt(0.95, 0.6)
  assert.ok(early > 0.5, `早期页缘弯曲不足：${early}`)
  // Θ=π 时所有切片收敛到上限（叶片完全摊平，静态页交接无缝）
  for (const s of [0, 0.3, 0.5, 0.8, 1]) {
    assert.ok(
      Math.abs(curlAngleAt(s, Math.PI) - BOOK_CURL_ANGLE_CEILING) < 1e-9,
      `满翻 s=${s} 未摊平：${curlAngleAt(s, Math.PI)}`,
    )
  }
})

test('curlAngleAt：翻页中段自由边领先书脊，曲率不能从根部直接折断', () => {
  const theta = Math.PI / 2
  const root = curlAngleAt(0, theta)
  const edge = curlAngleAt(1, theta)
  assert.ok(root < theta * 0.3, `中段书脊切线不应领先整页：${root}`)
  assert.ok(edge > root * 3.5, `弯曲应集中到自由边：root=${root} edge=${edge}`)
})

test('buildCurlFrame：强拖到七成进度时切片角连续递增，不能形成根部断带', () => {
  const frame = buildCurlFrame(
    { slices: 16, pageWidth: 480, pageHeight: 660 },
    { theta: Math.PI * 0.72, skew: 0.7, velocity: 8 },
  )
  const rootSlice = frame.slices[0]?.angle ?? Infinity
  const freeEdge = frame.slices.at(-1)?.angle ?? 0
  // 后半程书脊必须逐渐跟随，不能一直压平后再于最后几帧突然摊宽。
  assert.ok(rootSlice > Math.PI * 0.45 && rootSlice < Math.PI * 0.65, `七成进度书脊应已自然转向：${rootSlice}`)
  assert.ok(freeEdge - rootSlice > 1, `曲面仍应保留柔和弯曲：root=${rootSlice} edge=${freeEdge}`)
  frame.slices.slice(1).forEach((slice, index) => {
    assert.ok(
      slice.angle >= frame.slices[index].angle,
      `切片 ${index}→${index + 1} 角度回退：${frame.slices[index].angle}→${slice.angle}`,
    )
  })
})

test('独立切片按弧长共享边；落页末段宽度和高度平滑收敛', () => {
  const spec = { slices: 18, pageWidth: 480, pageHeight: 640 }
  for (const p of [0, 0.1, 0.35, 0.5, 0.8, 0.98, 1]) {
    const frame = buildCurlFrame(spec, { theta: Math.PI * p, skew: 0 })
    for (let i = 1; i < frame.slices.length; i += 1) {
      const previous = frame.slices[i - 1]
      assert.ok(Math.abs(frame.slices[i].x - previous.x - spec.pageWidth / spec.slices * Math.cos(previous.angle)) < 1e-8)
      assert.ok(Math.abs(frame.slices[i].z - previous.z - spec.pageWidth / spec.slices * Math.sin(previous.angle)) < 1e-8)
    }
    if (p >= 0.98) {
      const edge = frame.slices.at(-1)!
      assert.ok(Math.abs(edge.x + spec.pageWidth / spec.slices * Math.cos(edge.angle) + spec.pageWidth) < 0.02, '落页最后 2% 不得横向伸缩')
    }
  }
})

test('curlProgress：边界与单调', () => {
  assert.equal(curlProgress(0), 0)
  assert.equal(curlProgress(BOOK_CURL_MAX_ANGLE), 1)
  assert.equal(curlProgress(99), 1)
})

test('resolveDragSkew：映射与夹取', () => {
  assert.equal(resolveDragSkew(280, 280, 560), 0)
  assert.equal(resolveDragSkew(560, 0, 560), 1)
  assert.equal(resolveDragSkew(0, 560, 560), -1)
})

test('buildCurlFrame：切片数、连续遮光与落影参数区间', () => {
  const spec = { slices: 12, pageWidth: 420, pageHeight: 560 }
  const frame = buildCurlFrame(spec, { theta: Math.PI / 2, skew: 0.5 })
  assert.equal(frame.slices.length, 12)
  for (const [index, slice] of frame.slices.entries()) {
    for (const shade of [slice.shadeStart, slice.shadeEnd, slice.backShadeStart, slice.backShadeEnd]) {
      assert.ok(shade >= 0 && shade <= 0.45)
    }
    if (index > 0) {
      const previous = frame.slices[index - 1]
      assert.equal(slice.shadeStart, previous.shadeEnd, '正面相邻切片的光照边界必须连续')
      assert.equal(slice.backShadeStart, previous.backShadeEnd, '背面相邻切片的光照边界必须连续')
    }
    assert.ok(slice.angle >= 0 && slice.angle <= BOOK_CURL_ANGLE_CEILING)
  }
  assert.ok(frame.revealedShadow.opacity > 0 && frame.revealedShadow.opacity <= 0.3)
  assert.ok(frame.shearDeg > 0 && frame.shearDeg <= 5)
})

test('拖动方向与速度会改变叶片曲率，不再只有一条固定动画', () => {
  const spec = { slices: 18, pageWidth: 540, pageHeight: 720 }
  const still = buildCurlFrame(spec, { theta: 1.2, skew: 0, velocity: 0 })
  const pulledUpFast = buildCurlFrame(spec, { theta: 1.2, skew: -0.8, velocity: 7 })
  assert.ok(pulledUpFast.shearDeg < 0)
  assert.ok(Math.abs(buildCurlFrame(spec, { theta: 0, skew: -0.8 }).shearDeg) < 1e-9)
  assert.ok(Math.abs(buildCurlFrame(spec, { theta: Math.PI, skew: -0.8 }).shearDeg) < 1e-9)
  assert.notDeepEqual(
    pulledUpFast.slices.map((slice) => slice.angle),
    still.slices.map((slice) => slice.angle),
  )
})

test('遮光模型：平放正面无遮光，落定背面回到纸面亮度', () => {
  assert.equal(frontShadeForAngle(0), 0)
  assert.ok(frontShadeForAngle(Math.PI / 2) > 0.1, '侧对观察者应柔和变暗')
  assert.ok(frontShadeForAngle(Math.PI / 2) < 0.12, '侧立页不得压成硬灰带')
  assert.equal(frontShadeForAngle(Math.PI), 0, '正面落到对侧时必须回到纸面亮度')
  // Θ=π 时背面朝向观察者，遮光应回落到接近纸面。
  assert.ok(backShadeForAngle(Math.PI) < 0.1, `落定背面过暗：${backShadeForAngle(Math.PI)}`)
  // 起翻早期背面完全背对观察者（α 小），应显著暗于落定态
  assert.ok(backShadeForAngle(0.4) > backShadeForAngle(Math.PI), '背对观察者的背面应比落地时暗')
  const samples = Array.from({ length: 101 }, (_, index) => frontShadeForAngle(index * Math.PI / 100))
  const largestStep = Math.max(...samples.slice(1).map((value, index) => Math.abs(value - samples[index])))
  assert.ok(largestStep < 0.004, `遮光随角度变化必须连续，不能产生色彩断层：${largestStep}`)
})

test('活动页书脊阴影：两个平放端点与静态页同强度，中段连续释暗', () => {
  assert.equal(leafGutterOpacityForTheta(0), 1)
  assert.ok(Math.abs(leafGutterOpacityForTheta(Math.PI) - 1) < 1e-9)
  assert.ok(leafGutterOpacityForTheta(Math.PI / 2) >= 0.89)
  assert.ok(leafGutterOpacityForTheta(Math.PI / 2) <= 0.91)
  const samples = Array.from(
    { length: 101 },
    (_, index) => leafGutterOpacityForTheta(index * Math.PI / 100),
  )
  const largestStep = Math.max(
    ...samples.slice(1).map((value, index) => Math.abs(value - samples[index])),
  )
  assert.ok(largestStep < 0.003, `书脊阴影单步变化过大：${largestStep}`)
})

test('平放端点的全部动态光照归零，接管静态页没有明暗突变', () => {
  for (const theta of [0, Math.PI]) {
    const frame = buildCurlFrame({ slices: 18, pageWidth: 480, pageHeight: 640 }, { theta, skew: 1, velocity: 8 })
    assert.ok(frame.revealedShadow.opacity < 1e-8)
    assert.ok(frame.oppositeShadow.opacity < 1e-8)
    assert.ok(Math.abs(frame.shearDeg) < 1e-8)
    for (const slice of frame.slices) {
      assert.ok(slice.shadeStart < 1e-8 && slice.shadeEnd < 1e-8)
      assert.ok(slice.backShadeStart < 1e-8 && slice.backShadeEnd < 1e-8)
    }
  }
})
