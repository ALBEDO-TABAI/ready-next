import type { AgentInputItem } from '@openai/agents'

export function prependSystemReminderInput(
  input: string | AgentInputItem[],
  reminderText: string,
): AgentInputItem[] {
  const reminderItem = {
    role: 'system',
    content: reminderText,
  } as AgentInputItem
  if (typeof input !== 'string') return [reminderItem, ...input]
  return [
    reminderItem,
    {
      role: 'user',
      content: input,
    } as AgentInputItem,
  ]
}
