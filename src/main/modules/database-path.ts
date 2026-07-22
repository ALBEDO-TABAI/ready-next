import { join, resolve } from 'path'

export function resolveReadyDatabasePath(userDataPath: string, overridePath?: string): string {
  const explicitPath = overridePath?.trim()
  return explicitPath ? resolve(explicitPath) : join(userDataPath, 'ready.db')
}
