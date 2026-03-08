import type { DatabaseManager } from '../database'
import { getDatabase } from '../database'

export function getRepositoryDatabase(): DatabaseManager {
  return getDatabase()
}
