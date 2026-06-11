import ModeSlider from './ModeSlider'
import {
  WORKBENCH_TOPBAR_HEIGHT,
  WORKBENCH_TOPBAR_PADDING_LEFT,
  WORKBENCH_TOPBAR_PADDING_RIGHT,
} from '../../modules/workbench/chrome'

export default function TopBar() {
  return (
    <div
      data-liquid-shell="topbar"
      className="flex items-center justify-end drag-region"
      style={{
        background: 'transparent',
        height: WORKBENCH_TOPBAR_HEIGHT,
        paddingLeft: WORKBENCH_TOPBAR_PADDING_LEFT,
        paddingRight: WORKBENCH_TOPBAR_PADDING_RIGHT,
        borderBottom: '1px solid transparent',
        boxShadow: 'none',
      }}
    >
      <div className="flex items-center no-drag flex-shrink-0">
        <ModeSlider />
      </div>
    </div>
  )
}
