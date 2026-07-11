import type { DeliveryMode } from '../../../shared/dynamic-delivery'

export function consumeThoroughDeliveryOverride(enabled: boolean): {
  deliveryMode: DeliveryMode | undefined
  nextEnabled: false
} {
  return { deliveryMode: enabled ? 'thorough' : undefined, nextEnabled: false }
}
