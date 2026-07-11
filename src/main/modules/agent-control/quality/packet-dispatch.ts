import type { TaskExecutionBinding } from '../../../../shared/agent-execution-profile'
import type { WorkPackage } from '../../../../shared/dynamic-delivery'

export const DYNAMIC_DELIVERY_PACKET_CHANNELS = ['model_subagent'] as const
export type DynamicDeliveryPacketChannel = typeof DYNAMIC_DELIVERY_PACKET_CHANNELS[number]

export interface DynamicDeliveryDispatchInput {
  workPackage: WorkPackage
  binding: TaskExecutionBinding
  userRequestVerbatim: string
  contextRefIds: string[]
}

export function validateDynamicDeliveryDispatch(input: DynamicDeliveryDispatchInput): void {
  if (!input.userRequestVerbatim) throw new Error('delivery_dispatch_verbatim_required')
  if (!input.workPackage.packageId || !input.workPackage.deliverable.trim()) {
    throw new Error('delivery_dispatch_package_invalid')
  }
  if (input.binding.kind !== 'registered_agent' && input.binding.kind !== 'ephemeral') {
    throw new Error('delivery_dispatch_binding_invalid')
  }
  const allowedRefs = new Set(input.workPackage.contextRefIds)
  if (input.contextRefIds.some((ref) => !allowedRefs.has(ref))) {
    throw new Error('delivery_dispatch_context_ref_denied')
  }
}

export async function dispatchDynamicDeliveryPackage<T>(input: DynamicDeliveryDispatchInput & {
  executeModelSubagent: (validated: DynamicDeliveryDispatchInput) => Promise<T>
}): Promise<{ channel: DynamicDeliveryPacketChannel; result: T }> {
  validateDynamicDeliveryDispatch(input)
  return { channel: 'model_subagent', result: await input.executeModelSubagent(input) }
}
