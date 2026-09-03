import type { PetStickyNoteInput } from '../../../shared/pet'

export {
  PET_TOOLS,
  getPetAnthropicTools,
  getPetOpenAITools,
} from './pet-tool-defs'

const PET_ACTIONS: Record<string, string> = {
  pet_show_sticky_note: 'pet.showStickyNote',
  pet_dismiss_sticky_note: 'pet.dismissStickyNote',
  pet_clear_sticky_notes: 'pet.clearStickyNotes',
}

export async function executePetTool(
  toolName: string,
  args: Record<string, unknown>,
  context?: {
    requestModuleToolAction?: (
      action: string,
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>
  },
): Promise<string> {
  const action = PET_ACTIONS[toolName]
  if (!action) return JSON.stringify({ success: false, error: `Unknown pet tool: ${toolName}` })
  if (!context?.requestModuleToolAction) {
    return JSON.stringify({
      success: false,
      ok: false,
      errorKind: 'product_action_bridge_missing',
    })
  }
  const payload = await context.requestModuleToolAction(action, args as PetStickyNoteInput & Record<string, unknown>)
  return JSON.stringify({ success: payload.ok !== false, ...payload })
}
