import { statSync } from 'node:fs'

export function sameCodexThreadDirectory(left: string, right: string): boolean {
  if (left === right) return true
  if (process.platform !== 'darwin') return false
  try {
    const leftStat = statSync(left)
    const rightStat = statSync(right)
    return leftStat.isDirectory()
      && rightStat.isDirectory()
      && leftStat.dev === rightStat.dev
      && leftStat.ino === rightStat.ino
  } catch {
    return false
  }
}
