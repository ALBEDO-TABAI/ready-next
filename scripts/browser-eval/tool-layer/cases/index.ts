import { webMcpGroup } from './webmcp'
import { w7Group } from './w7'
import { backgroundGroup } from './background'
import { attentionGroup } from './attention'
// Case groups in run order. The takeover group runs last: it fences its own run only, but a
// late position keeps any surprise from leaking into earlier groups.
import type { CaseGroup } from '../harness'
import { formGroup, keyboardGroup, loginGroup, surfaceGroup, wizardGroup } from './forms'
import { framesGroup, pagingGroup, shadowGroup, spaGroup, waitGroup } from './pages'
import { canvasGroup, dialogsGroup, downloadsGroup, editorGroup, popupGroup, takeoverGroup, uploadGroup } from './interactions'
import { sequenceGroup } from './sequence'

export const CASE_GROUPS: CaseGroup[] = [
  webMcpGroup,
  surfaceGroup,
  formGroup,
  keyboardGroup,
  wizardGroup,
  sequenceGroup,
  spaGroup,
  framesGroup,
  shadowGroup,
  pagingGroup,
  loginGroup,
  downloadsGroup,
  uploadGroup,
  dialogsGroup,
  popupGroup,
  editorGroup,
  canvasGroup,
  waitGroup,
  w7Group,
  backgroundGroup,
  attentionGroup,
  takeoverGroup,
]
