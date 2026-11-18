import { closeSync, fsyncSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

/** Called after flushing the data file. Windows cannot flush a directory handle through Node. */
export function syncParentDirectory(file: string): void {
  if (process.platform === 'win32') return
  const directory = openSync(dirname(file), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}
