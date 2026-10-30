export const READY_BOARD_STATE_SCRIPT_ID = 'ready-board-state'

/** One-time import source, never an editable production format. */
export function isReadyBoardFile(path: string | null | undefined): boolean {
  return /\.readyboard(?:[?#].*)?$/i.test(path ?? '')
}
