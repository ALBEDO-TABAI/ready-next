import { APP_SHORTCUTS, type AppShortcut } from '../../../../shared/app-shortcuts'
import type { WorkbenchMode } from '../../../stores/useMode'

export interface ReadyCommand {
  id: string
  title: string
  keywords?: readonly string[]
  shortcut?: AppShortcut
  when?: { mode?: WorkbenchMode }
  /** Offered with 最近打开 when ⌘K opens with nothing typed (W6 §2.3). */
  common?: boolean
  run: () => void | Promise<void>
}

const sources = new Map<string, readonly ReadyCommand[]>()
const listeners = new Set<() => void>()
let revision = 0
function changed() { revision++; listeners.forEach(listener => listener()) }
export const commandRegistryRevision = () => revision
export function subscribeCommands(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Duplicate sources/ids are rejected atomically; cleanup only removes its own registration. */
export function registerCommands(source: string, commands: ReadyCommand[]): () => void {
  if (sources.has(source)) throw new Error(`Duplicate command source: ${source}`)
  const ids = new Set([...sources.values()].flat().map(command => command.id))
  for (const command of commands) {
    if (ids.has(command.id)) throw new Error(`Duplicate command id: ${command.id}`)
    if (command.shortcut && !APP_SHORTCUTS.includes(command.shortcut)) throw new Error(`Shortcut must come from app-shortcuts: ${command.id}`)
    ids.add(command.id)
  }
  const registered = commands.map(command => ({ ...command }))
  sources.set(source, registered)
  changed()
  return () => {
    if (sources.get(source) !== registered) return
    sources.delete(source)
    changed()
  }
}

export function listCommands(context: { mode: WorkbenchMode }): ReadyCommand[] {
  return [...sources.values()].flat().filter(command => !command.when?.mode || command.when.mode === context.mode)
}
