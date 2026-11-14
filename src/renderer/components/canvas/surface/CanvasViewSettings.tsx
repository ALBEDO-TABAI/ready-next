import { Slider, Switch } from '../../ui'
import { MAX_GAP, setBoardView, useBoardView } from '../../../modules/canvas/interaction/preferences'

// 视图设置 (integration plan: 间距、磁吸、圆角偏好归画板视图设置): a small popover from the corner, never a row on
// the stage. These are this machine's preferences (M4 §9.1): nothing here is written into the board.

function Row({ label, checked, disabled, indent, onChange }: { label: string; checked: boolean; disabled?: boolean; indent?: boolean; onChange(checked: boolean): void }) {
  return <div className="canvas-view-row" data-indent={indent || undefined} data-off={disabled || undefined}>
    <span>{label}</span><Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
  </div>
}
export function BoardViewSettings() {
  const view = useBoardView()
  return <div className="canvas-view-settings" role="group" aria-label="视图设置">
    <Row label="智能参考线" checked={view.smartGuides} onChange={smartGuides => setBoardView({ smartGuides })} />
    <Row label="磁吸" checked={view.magneticSnap} onChange={magneticSnap => setBoardView({ magneticSnap })} />
    <div className="canvas-view-row" data-indent data-off={!view.magneticSnap || undefined}>
      <span>间距</span>
      <Slider aria-label="间距" min={0} max={MAX_GAP} step={2} value={view.gap} disabled={!view.magneticSnap} onChange={event => setBoardView({ gap: Number(event.target.value) })} />
      <output>{view.gap}</output>
    </div>
    <Row label="自适应缩放" indent checked={view.adaptiveScale} disabled={!view.magneticSnap} onChange={adaptiveScale => setBoardView({ adaptiveScale })} />
    <Row label="图片圆角" checked={view.roundedMedia} onChange={roundedMedia => setBoardView({ roundedMedia })} />
  </div>
}
