import { App } from '../../modules/calendar/workbench/App'
import { WORKBENCH_CANVAS_OUTER_PADDING_TOP, WORKBENCH_CANVAS_OUTER_PADDING_X, WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM } from '../../modules/workbench/chrome'

// The paper keeps the same box in every mode (one shell): the calendar alone must not even out its bands while the
// other modes still carry a tab row above theirs. Equal bands (W1 DL11a) come for all modes together with the W2 layout.
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
