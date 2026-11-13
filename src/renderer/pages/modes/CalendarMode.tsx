import { App } from '../../modules/calendar/workbench/App'
import { WORKBENCH_CANVAS_OUTER_PADDING_TOP, WORKBENCH_CANVAS_OUTER_PADDING_X, WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM } from '../../modules/workbench/chrome'

// The panel keeps the same box in every mode (V11, V15): the calendar uses the shared paddings and adds no offsets of its own.
const CALENDAR_CANVAS_PADDING = `${WORKBENCH_CANVAS_OUTER_PADDING_TOP}px ${WORKBENCH_CANVAS_OUTER_PADDING_X}px ${WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM}px`

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
