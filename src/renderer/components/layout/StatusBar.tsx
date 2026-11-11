import { WORKBENCH_EDGE_ICON_INSET, WORKBENCH_STATUSBAR_HEIGHT } from '../../modules/workbench/chrome'

// The bottom band of the shell (W2 §2, W1 DL11a): as tall as the top band and quiet. The version
// number lives in Settings › About; transient status (saving, offline, background work) will show here.
export default function StatusBar() {
  return (
    <div
      data-liquid-shell="statusbar"
      data-shell-band="bottom"
      className="flex shrink-0 items-center justify-between select-none"
      style={{
        height: WORKBENCH_STATUSBAR_HEIGHT,
        paddingLeft: WORKBENCH_EDGE_ICON_INSET,
        paddingRight: WORKBENCH_EDGE_ICON_INSET,
        background: 'transparent',
      }}
    />
  )
}
