import type { DeliveryMode } from '../../../shared/dynamic-delivery'

export function consumeThoroughDeliveryOverride(enabled: boolean): {
  deliveryMode: DeliveryMode | undefined
  nextEnabled: false
} {
  return { deliveryMode: enabled ? 'thorough' : undefined, nextEnabled: false }
}

export function createThoroughDeliveryOverrideLatch(): {
  setEnabled: (enabled: boolean) => void
  consume: () => ReturnType<typeof consumeThoroughDeliveryOverride>
} {
  let enabled = false
  return {
    setEnabled: (nextEnabled) => { enabled = nextEnabled },
    consume: () => {
      const consumed = consumeThoroughDeliveryOverride(enabled)
      enabled = consumed.nextEnabled
      return consumed
    },
  }
}
