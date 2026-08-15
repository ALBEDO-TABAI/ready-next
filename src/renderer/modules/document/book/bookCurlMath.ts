/**
 * bookCurlMath.ts — 翻页卷曲的纯数学模型。
 *
 * 输入是「提升角 Θ ∈ [0, π]」（0 = 平放右侧，π = 平放左侧）与页角偏斜 skew，
 * 输出 K 个竖直切片的累计旋转角、逐切片遮光与落影参数。
 * 全部纯函数，不触碰 DOM，便于行为测试与逐帧复用。
 *
 * 视觉依据：docs/superpowers/audits/2026-08-04-document-reading-mode-codex-implementation-review.md §1
 * （参考视频为 turn.js 演示：对角线剥离、弯曲半径随进度展开、纸面透光）。
 */

export const BOOK_CURL_MAX_ANGLE = Math.PI
/** 满翻必须精确落到对侧平面，否则按住终点时会显得纸页悬空。 */
export const BOOK_CURL_ANGLE_CEILING = Math.PI

export interface BookCurlSpec {
  /** 切片数量 K（默认 12，降级 8） */
  slices: number
  /** 单页逻辑宽度 px */
  pageWidth: number
  /** 单页逻辑高度 px */
  pageHeight: number
}

export interface CurlFrameInput {
  /** 提升角 Θ，[0, π] */
  theta: number
  /** 页角偏斜，[-1, 1]（拖拽点相对捏点的纵向偏移） */
  skew: number
  /** 当前角速度（rad/s）；正值收紧卷曲，回拉时放松。 */
  velocity?: number
}

export interface CurlSliceFrame {
  /** 切片中心相对书脊的累计旋转角（rad，0 = 平放） */
  angle: number
  /** 正面左/右边界遮光阴；相邻切片共享同一边界值。 */
  shadeStart: number
  shadeEnd: number
  /** 背面左/右边界遮光阴。 */
  backShadeStart: number
  backShadeEnd: number
}

export interface CurlCastShadow {
  /** 落影带中心（相对被投影页、距书脊 px） */
  centerX: number
  /** 落影带宽 px */
  width: number
  /** 落影 opacity，[0, 0.3] */
  opacity: number
  /** 被揭开页近书脊接触暗化 opacity，[0, 0.22] */
  gutterShade: number
}

export interface CurlFrame {
  slices: CurlSliceFrame[]
  /** 整张活动页的纵向剪切角（度）；书脊边固定，页缘随抓取方向偏移。 */
  shearDeg: number
  /** 投向被揭开页（翻页起始侧）的落影 */
  revealedShadow: CurlCastShadow
  /** 投向目标侧静置页的落影（Θ 过半后页片悬于其上方） */
  oppositeShadow: CurlCastShadow
}

/**
 * 切片内容槽的水平映射。翻到背面或后翻时，几何本身已经改变了切片顺序，
 * 因此可见内容只需改取相反的源条带，不能再把每条文字横向镜像。
 * 透印才需要相对当前观察面额外镜像。
 */
export function resolveLeafSlotTransform(args: {
  sliceIndex: number
  sliceWidth: number
  pageWidth: number
  mirrored: boolean
  backFace: boolean
}): string {
  const { sliceIndex, sliceWidth, pageWidth, mirrored, backFace } = args
  const reversedStripOrder = mirrored !== backFace
  const sourceStrip = reversedStripOrder
    ? pageWidth - (sliceIndex + 1) * sliceWidth
    : sliceIndex * sliceWidth
  return mirrored
    ? `translateX(${sourceStrip + sliceWidth}px) scaleX(-1)`
    : `translateX(${-sourceStrip}px)`
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Θ → [0,1] 翻页进度 */
export function curlProgress(theta: number): number {
  return clamp(theta / BOOK_CURL_MAX_ANGLE, 0, 1)
}

/**
 * 角轮廓：θ(s,Θ) = Θ·[a(p) + (1−a(p))·s^q(p)] + Θ·0.5·max(0, s−s_c)^1.6·(1−p)^0.7
 * s 为从书脊(0)到页缘(1)的归一化位置，p = Θ/π。
 * - 书脊点始终固定，但书脊切线从起翻开始按 p² 连续转向；不能把转向压到
 *   最后十几个百分点，否则整张曲面会在落定前突然横向摊宽。
 * - 指数 q(p) = 2.2 − 1.2p：早期凸形（页缘领先），后期趋线性。
 * - 卷曲峰 crest s_c = 0.9 − 0.75p 随进度向书脊移动，且以 (1−p)^0.7 衰减摊平。
 */
export function curlAngleAt(s: number, theta: number, tension = 0): number {
  const safeS = clamp(s, 0, 1)
  const progress = curlProgress(theta)
  const dynamic = clamp(tension, -0.65, 1)
  const crest = 0.9 - 0.75 * progress - 0.12 * Math.max(0, dynamic)
  // 根点由 CSS transform-origin 固定；这里控制的是根部切线。p² 让起翻仍由
  // 自由边主导，同时把摊平分散到整个后半程。切线不受瞬时 velocity 调制，
  // 否则正速度在终点归零时仍会制造一次几何跳变。
  const spineShare = 0.012 + 0.988 * progress * progress
  const exponent = clamp(2.2 - 1.2 * progress + 0.45 * dynamic, 0.75, 2.8)
  const lift = theta * (spineShare + (1 - spineShare) * Math.pow(safeS, exponent))
  const roll = theta * (0.5 + 0.3 * dynamic) * Math.pow(Math.max(0, safeS - crest), 1.6) * Math.pow(1 - progress, 0.7)
  return clamp(lift + roll, 0, BOOK_CURL_ANGLE_CEILING)
}

/** 拖拽点纵向偏移 → 页角偏斜 [-1,1]（1.6 增益让小幅拖动即可感知） */
export function resolveDragSkew(pointerY: number, grabY: number, pageHeight: number): number {
  const height = Math.max(1, pageHeight)
  return clamp(((pointerY - grabY) / height) * 1.6, -1, 1)
}

/** 正面遮光：只在纸面侧立时柔和变暗，两个平放端点回到纸面亮度。 */
export function frontShadeForAngle(angle: number): number {
  const sideOn = Math.max(0, Math.sin(clamp(angle, 0, Math.PI)))
  if (sideOn < 1e-6) return 0
  return 0.105 * Math.pow(sideOn, 1.25)
}

/** 背面遮光：保留极轻纸背底色，侧立最暗，落定时连续回到纸面亮度。 */
export function backShadeForAngle(angle: number): number {
  const sideOn = Math.max(0, Math.sin(clamp(angle, 0, Math.PI)))
  if (sideOn < 1e-6) return 0.025
  return 0.025 + 0.1 * Math.pow(sideOn, 1.15)
}

/**
 * 活动页书脊暗部：两个平放端点必须与静态页完全一致，中段只做轻微释暗。
 * 1.5 次幂让端点斜率归零；若使用小于 1 的幂，数值虽连续，最后几帧仍会视觉跳变。
 */
export function leafGutterOpacityForTheta(theta: number): number {
  const sideOn = Math.max(0, Math.sin(clamp(theta, 0, Math.PI)))
  return 1 - 0.1 * Math.pow(sideOn, 1.5)
}

export function buildCurlFrame(spec: BookCurlSpec, input: CurlFrameInput): CurlFrame {
  const slices = Math.max(2, Math.floor(spec.slices))
  const theta = clamp(input.theta, 0, BOOK_CURL_MAX_ANGLE)
  const progress = curlProgress(theta)
  const momentum = clamp((input.velocity ?? 0) / 6, -1, 1)
  const tension = clamp(momentum * 0.75 + Math.abs(input.skew) * 0.45, -0.65, 1)
  const angles: number[] = []
  const boundaryAngles: number[] = []
  for (let i = 0; i <= slices; i += 1) {
    boundaryAngles.push(curlAngleAt(i / slices, theta, tension))
  }
  for (let i = 0; i < slices; i += 1) {
    angles.push(curlAngleAt((i + 0.5) / slices, theta, tension))
  }

  const frameSlices: CurlSliceFrame[] = angles.map((angle, i) => {
    const startAngle = boundaryAngles[i]
    const endAngle = boundaryAngles[i + 1]
    return {
      angle,
      shadeStart: frontShadeForAngle(startAngle),
      shadeEnd: frontShadeForAngle(endAngle),
      backShadeStart: backShadeForAngle(startAngle),
      backShadeEnd: backShadeForAngle(endAngle),
    }
  })

  const sinTheta = Math.sin(theta)
  // 落影带随折足移动：起翻时贴近页缘，落定前贴近书脊
  const foldFoot = spec.pageWidth * (0.9 * (1 - progress) + 0.05)
  const revealedShadow: CurlCastShadow = {
    centerX: foldFoot,
    width: spec.pageWidth * (0.45 * Math.pow(sinTheta, 0.7) + 0.1),
    opacity: clamp(0.17 * Math.pow(sinTheta, 0.8), 0, 0.2),
    gutterShade: clamp(0.1 * sinTheta, 0, 0.12),
  }
  // Θ 过半后页片悬于对侧静置页上方
  const oppositeLift = clamp(Math.sin(theta - Math.PI / 2), 0, 1)
  const oppositeShadow: CurlCastShadow = {
    centerX: spec.pageWidth * 0.35,
    width: spec.pageWidth * 0.5,
    opacity: clamp(0.1 * Math.pow(oppositeLift, 0.8), 0, 0.12),
    gutterShade: 0,
  }

  return {
    slices: frameSlices,
    // 连续剪切施加在整张活动页上：x=0 的书脊边恒定，所有切片共享边仍然相接。
    // 起翻/落定时剪切回零，保证与静态页交接无缝。镜像后翻只改变 x，不改变手势的 y 方向。
    shearDeg: clamp(input.skew, -1, 1) * 5 * Math.pow(Math.max(0, sinTheta), 0.7),
    revealedShadow,
    oppositeShadow,
  }
}
