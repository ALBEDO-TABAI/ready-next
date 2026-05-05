import type { PetStickyNoteInput } from '../../../shared/pet'
import { getActivePetWindowManager } from '../pet/active-pet-window-manager'

export {
  PET_TOOLS,
  getPetAnthropicTools,
  getPetOpenAITools,
} from './pet-tool-defs'

export async function executePetTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  const manager = getActivePetWindowManager()
  if (!manager) {
    return JSON.stringify({ success: false, error: 'Pet window manager is not available' })
    }

  switch (toolName) {
    case 'pet_show_sticky_note': {
      const noteInput = args as unknown as PetStickyNoteInput & { enablePet?: boolean }
      if (noteInput.enablePet !== false) {
        if (!manager.getSettings().enabled) {
          manager.updateSettings({ enabled: true })
        } else {
          await manager.show()
        }
      }
      const note = manager.pushStickyNote(noteInput)
      return JSON.stringify({
        success: true,
        note,
        message: '已贴到宠物便利贴',
      })
    }
    case 'pet_dismiss_sticky_note': {
      const dismissed = manager.dismissStickyNote(String(args.id || ''))
      return JSON.stringify({ success: true, dismissed })
    }
    case 'pet_clear_sticky_notes': {
      manager.clearStickyNotes()
      return JSON.stringify({ success: true })
    }
    default:
      return JSON.stringify({ success: false, error: `Unknown pet tool: ${toolName}` })
  }
}
