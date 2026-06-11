import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { LiquidLens, type LiquidLensProps } from './components/ui/liquid-glass/LiquidLens'

/**
 * Liquid glass tuning lab (#/liquid-test).
 *
 * One refractive lens (LiquidLens) you can drag over a busy backdrop, with
 * every optical parameter on a slider. Used to dial in the chat composer
 * defaults; not part of any workbench flow.
 */

interface LensConfig {
  width: number
  height: number
  radius: number
  bevel: number
  depth: number
  ior: number
  dome: number
  strength: number
  blur: number
  frost: number
  blurBeforeRefraction: boolean
  saturation: number
  brightness: number
  contrast: number
  aberration: number
  engine: NonNullable<LiquidLensProps['engine']>
  debugMap: boolean
}

const DEFAULT_CONFIG: LensConfig = {
  width: 560,
  height: 120,
  radius: 28,
  bevel: 24,
  depth: 12,
  ior: 1.5,
  dome: 8,
  strength: 4,
  blur: 2,
  frost: 12,
  blurBeforeRefraction: false,
  saturation: 1.1,
  brightness: 1,
  contrast: 1,
  aberration: 1.5,
  engine: 'backdrop',
  debugMap: false,
}

const PRESETS: Record<string, Partial<LensConfig>> = {
  composer: { radius: 18, bevel: 10, depth: 37, ior: 1.29, dome: 0, strength: 2.05, blur: 13, frost: 0, blurBeforeRefraction: true, saturation: 1.18, brightness: 1.05, contrast: 0.84, aberration: 0, engine: 'backdrop' },
  demo: { radius: 32, bevel: 30, depth: 16, ior: 1.6, dome: 12, strength: 4, blur: 0.8, frost: 10, saturation: 1.4, brightness: 1.02, contrast: 1, aberration: 3 },
  extreme: { radius: 40, bevel: 48, depth: 28, ior: 1.9, dome: 20, strength: 6, blur: 0, frost: 30, saturation: 1.5, brightness: 1.05, contrast: 1.05, aberration: 8 },
}

interface SliderSpec {
  key: keyof LensConfig
  label: string
  min: number
  max: number
  step: number
}

const SLIDERS: SliderSpec[] = [
  { key: 'width', label: '宽度 px', min: 200, max: 900, step: 10 },
  { key: 'height', label: '高度 px', min: 64, max: 320, step: 4 },
  { key: 'radius', label: '圆角 px', min: 0, max: 80, step: 1 },
  { key: 'bevel', label: '折射带宽 px', min: 2, max: 90, step: 1 },
  { key: 'depth', label: '玻璃厚度 px', min: 0, max: 48, step: 0.5 },
  { key: 'ior', label: '折射率 IOR', min: 1.01, max: 2.4, step: 0.01 },
  { key: 'dome', label: '中心凸度 px', min: 0, max: 24, step: 0.5 },
  { key: 'strength', label: '位移强度 ×', min: 0, max: 3, step: 0.05 },
  { key: 'blur', label: '模糊 px', min: 0, max: 20, step: 0.25 },
  { key: 'frost', label: '磨砂拉丝 px', min: 0, max: 40, step: 0.5 },
  { key: 'saturation', label: '饱和度 ×', min: 0.4, max: 2.2, step: 0.02 },
  { key: 'brightness', label: '亮度 ×', min: 0.7, max: 1.5, step: 0.01 },
  { key: 'contrast', label: '对比度 ×', min: 0.7, max: 1.5, step: 0.01 },
  { key: 'aberration', label: '色散 px', min: 0, max: 10, step: 0.25 },
]

const TEXT_ROWS = [
  '品牌系统工坊那条回执我已处理：它是运行时 JSON 解析失败，没有产出业务结果。',
  'The text behind this surface should bend at the rim — refraction, not smear.',
  '我已把这次失败依赖登记到任务证明链里，并明确最终交叉分析已完成。',
  'browser_collect_notes · browser_get_task · ready-tools.log · 2026-06-10',
  '正在理解需求 → 已完成 ∙ 正在整理任务边界、上下文与可用能力',
  'Hi～今天有什么可以帮到你？版单季报告完成；当前无待处理动作。',
  'Liquid glass optical bench — edge bevel bends light by Snell’s law.',
  '飞书与远程图片先进入会话资源层，后续任务显式选择附件资源。',
]

type LabScene = 'color' | 'chat' | 'dark'

function BackdropScene({ scene, animate }: { scene: LabScene; animate: boolean }) {
  if (scene === 'chat') {
    // 模拟真实聊天面板：浅色面板 + 13px 正文 + 白色胶囊卡，
    // 让调出来的参数到真实输入框上观感一致。
    return (
      <div className="lab-scene lab-scene--chat" aria-hidden="true">
        <div className="lab-chat">
          {Array.from({ length: 4 }, (_, block) => (
            <div key={block}>
              <p><strong>需要你协助：</strong>请在浏览器中打开第一篇笔记页面，然后我可以用 browser_collect_notes 接力下载全部图片。</p>
              <p>或者你可以告诉我你希望怎么处理——是只记录 URL 列表，还是需要我等你操作后继续下载？</p>
              <div className="lab-chat__capsule">
                <span><strong>正在理解需求</strong>　正在整理任务边界、上下文与可用能力</span>
                <em>已完成</em>
              </div>
              <p>采集发现阶段完成，共找到 11 张图片 URL。但 browser_visible_collect 只完成了发现，还没有实际下载到本地。</p>
            </div>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className={`lab-scene ${scene === 'dark' ? 'is-dark' : ''}`} aria-hidden="true">
      <div className="lab-scene__blobs" />
      <div className="lab-scene__grid" />
      <div className="lab-scene__chips">
        {['#ff5f6d', '#ffc371', '#38ef7d', '#11998e', '#7f7fd5', '#91eae4', '#f953c6', '#b91d73'].map((color) => (
          <span key={color} style={{ background: color }} />
        ))}
      </div>
      <div className="lab-scene__rows">
        {Array.from({ length: 26 }, (_, index) => {
          const row = TEXT_ROWS[index % TEXT_ROWS.length]
          const size = 14 + ((index * 7) % 18)
          return (
            <div
              key={index}
              className={index % 4 === 0 ? 'is-strong' : undefined}
              style={{ fontSize: size, marginLeft: (index % 5) * 36 }}
            >
              {row}
            </div>
          )
        })}
      </div>
      <div className={`lab-scene__marquee ${animate ? 'is-on' : ''}`}>
        <div>
          {'● READY ◆ LIQUID ✦ GLASS ▲ OPTICS ● 折射 ◆ 透镜 ✦ 玻璃 ▲ 光学 '.repeat(6)}
        </div>
      </div>
    </div>
  )
}

export default function LiquidTest() {
  const [config, setConfig] = useState<LensConfig>(DEFAULT_CONFIG)
  const [scene, setScene] = useState<LabScene>('color')
  const [veil, setVeil] = useState(true)
  const [animate, setAnimate] = useState(true)
  const [showContent, setShowContent] = useState(true)
  const [position, setPosition] = useState({ x: 120, y: 260 })
  const [copied, setCopied] = useState(false)
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null)

  const update = useCallback(<K extends keyof LensConfig>(key: K, value: LensConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.currentTarget
    dragRef.current = {
      pointerId: event.pointerId,
      dx: event.clientX - position.x,
      dy: event.clientY - position.y,
    }
    target.setPointerCapture(event.pointerId)
  }, [position.x, position.y])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setPosition({ x: event.clientX - drag.dx, y: event.clientY - drag.dy })
  }, [])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }, [])

  const copyConfig = useCallback(() => {
    const { width: _w, height: _h, debugMap: _d, ...optics } = config
    navigator.clipboard.writeText(JSON.stringify(optics, null, 2)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }, [config])

  return (
    <div className="lab-page">
      <style>{labCss}</style>
      <BackdropScene scene={scene} animate={animate} />

      <div
        className="lab-lens-host"
        style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <LiquidLens
          radius={config.radius}
          bevel={config.bevel}
          depth={config.depth}
          ior={config.ior}
          dome={config.dome}
          strength={config.strength}
          blur={config.blur}
          frost={config.frost}
          blurBeforeRefraction={config.blurBeforeRefraction}
          saturation={config.saturation}
          brightness={config.brightness}
          contrast={config.contrast}
          aberration={config.aberration}
          engine={config.engine}
          debugMap={config.debugMap}
          className="lab-lens"
          style={{
            width: config.width,
            height: config.height,
            // 与真实输入框的 __lens 白纱保持一致，避免实验室观感失真
            background: veil
              ? scene === 'dark'
                ? 'rgba(255,255,255,0.045)'
                : 'rgba(255,255,255,0.26)'
              : undefined,
          }}
        >
          {showContent ? (
            <div className="lab-lens__content" style={{ minHeight: config.height }}>
              <span className="lab-lens__placeholder">Hi～今天有什么可以帮到你</span>
              <div className="lab-lens__chips">
                <span>＋</span>
                <span>🤖 管家</span>
                <span>● mimo</span>
                <span className="is-send">➤</span>
              </div>
            </div>
          ) : null}
        </LiquidLens>
      </div>

      <aside className="lab-panel">
        <header>
          <strong>Liquid lens 调参台</strong>
          <span>拖动镜片到任意背景上观察折射</span>
        </header>

        <div className="lab-panel__row lab-panel__presets">
          {Object.keys(PRESETS).map((name) => (
            <button key={name} onClick={() => setConfig((prev) => ({ ...prev, ...PRESETS[name] }))}>
              {name}
            </button>
          ))}
          <button onClick={() => setConfig(DEFAULT_CONFIG)}>reset</button>
        </div>

        {SLIDERS.map((slider) => (
          <label key={slider.key} className="lab-panel__slider">
            <span>
              {slider.label}
              <em>{Number(config[slider.key]).toFixed(slider.step < 1 ? 2 : 0)}</em>
            </span>
            <input
              type="range"
              min={slider.min}
              max={slider.max}
              step={slider.step}
              value={Number(config[slider.key])}
              onChange={(event) => update(slider.key, Number(event.target.value) as never)}
            />
          </label>
        ))}

        <div className="lab-panel__row">
          <span className="lab-panel__caption">背景场景</span>
          <div className="lab-panel__toggle-group">
            {([['color', '彩色'], ['chat', '聊天实景'], ['dark', '暗色']] as const).map(([key, label]) => (
              <button
                key={key}
                className={scene === key ? 'is-active' : ''}
                onClick={() => setScene(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="lab-panel__row">
          <span className="lab-panel__caption">滤镜通道</span>
          <div className="lab-panel__toggle-group">
            {(['backdrop', 'layer'] as const).map((engine) => (
              <button
                key={engine}
                className={config.engine === engine ? 'is-active' : ''}
                onClick={() => update('engine', engine)}
              >
                {engine}
              </button>
            ))}
          </div>
        </div>

        <div className="lab-panel__row lab-panel__checks">
          <label><input type="checkbox" checked={veil} onChange={(e) => setVeil(e.target.checked)} />白纱(同输入框)</label>
          <label><input type="checkbox" checked={animate} onChange={(e) => setAnimate(e.target.checked)} />背景滚动</label>
          <label><input type="checkbox" checked={showContent} onChange={(e) => setShowContent(e.target.checked)} />镜片内容</label>
          <label><input type="checkbox" checked={config.blurBeforeRefraction} onChange={(e) => update('blurBeforeRefraction', e.target.checked)} />先雾化</label>
          <label><input type="checkbox" checked={config.debugMap} onChange={(e) => update('debugMap', e.target.checked)} />位移贴图</label>
        </div>

        <button className="lab-panel__copy" onClick={copyConfig}>
          {copied ? '已复制 ✓' : '复制光学参数 JSON'}
        </button>
      </aside>
    </div>
  )
}

const labCss = `
.lab-page {
  position: relative;
  min-height: 100vh;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
}

.lab-scene {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #f2f5fa 0%, #fbfcfe 46%, #e8eef6 100%);
  color: rgba(22, 30, 46, 0.72);
  transition: background 200ms ease, color 200ms ease;
}

.lab-scene.is-dark {
  background: linear-gradient(135deg, #14161c 0%, #1d2027 52%, #101216 100%);
  color: rgba(235, 240, 250, 0.82);
}

.lab-scene--chat {
  background: #f6f8fb;
}

.lab-chat {
  max-width: 720px;
  padding: 28px 36px;
  font-size: 13.5px;
  line-height: 1.7;
  color: #2a3242;
}

.lab-chat p { margin: 0 0 10px; }
.lab-chat strong { font-weight: 700; color: #18202e; }

.lab-chat__capsule {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin: 12px 0;
  padding: 12px 14px;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 4px 16px rgba(20, 28, 44, 0.06);
  font-size: 12.5px;
  color: rgba(42, 50, 66, 0.6);
}

.lab-chat__capsule em {
  font-style: normal;
  color: rgba(42, 50, 66, 0.5);
  white-space: nowrap;
}

.lab-scene__grid {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, rgba(127,140,170,0.10) 1px, transparent 1px),
    linear-gradient(0deg, rgba(127,140,170,0.09) 1px, transparent 1px);
  background-size: 44px 44px;
}

.lab-scene__blobs {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(420px 300px at 12% 10%, rgba(255, 99, 132, 0.35), transparent 70%),
    radial-gradient(460px 320px at 86% 16%, rgba(86, 120, 255, 0.32), transparent 70%),
    radial-gradient(520px 380px at 30% 88%, rgba(28, 190, 130, 0.30), transparent 72%),
    radial-gradient(380px 300px at 72% 72%, rgba(255, 180, 60, 0.30), transparent 70%);
  filter: saturate(1.1);
}

.lab-scene__chips {
  position: absolute;
  left: 40px;
  top: 96px;
  display: flex;
  gap: 14px;
}

.lab-scene__chips span {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  box-shadow: 0 6px 16px rgba(20, 28, 44, 0.18);
}

.lab-scene__rows {
  position: absolute;
  inset: 170px 320px 0 40px;
  line-height: 1.6;
  font-weight: 600;
  user-select: none;
}

.lab-scene__rows div { white-space: nowrap; }
.lab-scene__rows .is-strong { font-weight: 800; }
.lab-scene.is-dark .lab-scene__rows { color: rgba(235, 240, 250, 0.78); }

.lab-scene__marquee {
  position: absolute;
  left: 0;
  right: 0;
  top: 330px;
  overflow: hidden;
  font-size: 26px;
  font-weight: 800;
  letter-spacing: 2px;
  opacity: 0.85;
  background: linear-gradient(90deg, rgba(255,95,109,0.25), rgba(127,127,213,0.25), rgba(56,239,125,0.25));
  padding: 10px 0;
}

.lab-scene__marquee > div { white-space: nowrap; width: max-content; }
.lab-scene__marquee.is-on > div { animation: lab-marquee 24s linear infinite; }

@keyframes lab-marquee {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}

.lab-lens-host {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 5;
  cursor: grab;
  touch-action: none;
}

.lab-lens-host:active { cursor: grabbing; }

.lab-lens {
  box-shadow:
    0 22px 48px rgba(15, 23, 42, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.42),
    inset 0 -1px 0 rgba(255, 255, 255, 0.14);
}

.lab-lens__content {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 18px 22px 14px;
  pointer-events: none;
}

.lab-lens__placeholder {
  font-size: 14px;
  font-weight: 500;
  opacity: 0.55;
}

.lab-lens__chips {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 13px;
  font-weight: 600;
  opacity: 0.8;
}

.lab-lens__chips .is-send { margin-left: auto; font-size: 16px; }

.lab-panel {
  position: fixed;
  right: 18px;
  top: 18px;
  bottom: 18px;
  z-index: 20;
  width: 280px;
  overflow-y: auto;
  border-radius: 18px;
  background: rgba(20, 24, 34, 0.92);
  color: rgba(240, 244, 252, 0.92);
  padding: 18px 16px 16px;
  box-shadow: 0 24px 64px rgba(10, 14, 24, 0.4);
}

.lab-panel header { display: block; margin-bottom: 12px; }
.lab-panel header strong { display: block; font-size: 15px; }
.lab-panel header span { display: block; margin-top: 4px; font-size: 11px; opacity: 0.6; }

.lab-panel__row { margin: 12px 0; }

.lab-panel__presets { display: flex; gap: 6px; flex-wrap: wrap; }

.lab-panel__presets button,
.lab-panel__toggle-group button,
.lab-panel__copy {
  border: 1px solid rgba(255,255,255,0.16);
  background: rgba(255,255,255,0.06);
  color: inherit;
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}

.lab-panel__presets button:hover,
.lab-panel__toggle-group button:hover,
.lab-panel__copy:hover { background: rgba(255,255,255,0.14); }

.lab-panel__toggle-group { display: flex; gap: 6px; margin-top: 6px; }
.lab-panel__toggle-group .is-active { background: rgba(94, 130, 255, 0.55); border-color: rgba(120, 150, 255, 0.7); }

.lab-panel__caption { font-size: 11px; opacity: 0.6; }

.lab-panel__slider { display: block; margin: 10px 0; }
.lab-panel__slider span {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  opacity: 0.85;
  margin-bottom: 4px;
}
.lab-panel__slider em { font-style: normal; opacity: 0.7; font-variant-numeric: tabular-nums; }
.lab-panel__slider input { width: 100%; accent-color: #7c9aff; }

.lab-panel__checks { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.lab-panel__checks label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.85;
}

.lab-panel__copy { width: 100%; margin-top: 8px; padding: 8px 0; }
`
