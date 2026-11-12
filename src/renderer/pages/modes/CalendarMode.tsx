import { App } from '../../modules/calendar/workbench/App'
import { WORKBENCH_CANVAS_OUTER_PADDING_X, WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM } from '../../modules/workbench/chrome'

// The calendar has no tab row above its paper, so its paper sits between the two bands with equal gaps (W1 DL11a):
// the bottom canvas padding on both sides.
const CALENDAR_CANVAS_PADDING = `${WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM}px ${WORKBENCH_CANVAS_OUTER_PADDING_X}px`

interface CalendarModeProps { isActive?: boolean; isMotionSettled?: boolean }
export default function CalendarMode({isActive=true,isMotionSettled=true}:CalendarModeProps) {
  return <div className="workbench-mode-root calendar-union-mode">
    <div className="flex-1 min-h-0" style={{padding:CALENDAR_CANVAS_PADDING}}>
      <div className="workbench-canvas-shell h-full min-h-0" style={{background:'transparent',boxShadow:'none'}}>
        <App active={isActive&&isMotionSettled}/>
      </div>
    </div>
  </div>
}
