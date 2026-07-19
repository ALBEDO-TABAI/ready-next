import type { BrowserOperationId } from '../../../shared/browser-capability-registry'
import type { BrowserController } from '../browser-engine/ipc-handler'
import {
  BROWSER_CONTROLLER_STATE_TARGET,
  browserSnapshotService,
} from '../browser-engine/browser-snapshot-service'
import type { BrowserMutationBoundary } from './browser-action-executor'

const DIRECT_DELIVERY_TRANSPORTS = new Set<PropertyKey>([
  'createTab',
  'switchTab',
  'closeTab',
  'navigate',
  'goBack',
  'goForward',
  'reload',
  'setFileInputFiles',
  'handleBrowserDialog',
  'archivePage',
  'clearConsoleMessages',
  'clearBrowserOriginData',
  'setBrowserPermission',
  'resetBrowserPermission',
  'openForCaptureTarget',
  'scrollCollect',
])

const TRANSPORT_METHODS = new Set<PropertyKey>([
  'createTab',
  'switchTab',
  'closeTab',
  'navigate',
  'goBack',
  'goForward',
  'reload',
  'dispatchMouse',
  'dispatchKey',
  'typeTextDirectly',
  'setFileInputFiles',
  'handleBrowserDialog',
  'archivePage',
  'clearConsoleMessages',
  'clearBrowserOriginData',
  'setBrowserPermission',
  'resetBrowserPermission',
  'openForCaptureTarget',
  'scrollCollect',
])

const TAB_ID_FIRST_TRANSPORTS = new Set<PropertyKey>([
  'switchTab',
  'closeTab',
  'navigate',
  'goBack',
  'goForward',
  'reload',
  'dispatchMouse',
  'dispatchKey',
  'typeTextDirectly',
  'setFileInputFiles',
  'handleBrowserDialog',
  'archivePage',
  'clearConsoleMessages',
  'clearBrowserOriginData',
  'resetBrowserPermission',
  'scrollCollect',
])

function scriptArgument(property: PropertyKey, args: unknown[]): string {
  if (property === 'executeJS') return typeof args[1] === 'string' ? args[1] : ''
  if (property === 'executeJSInFrame') return typeof args[2] === 'string' ? args[2] : ''
  if (property === 'callFunctionOnBackendNode') return typeof args[2] === 'string' ? args[2] : ''
  return ''
}

function deliveryReadbackKind(property: PropertyKey, args: unknown[]): 'click' | 'text' | 'submit' | 'key' | null {
  const code = scriptArgument(property, args)
  if (!code) return null
  if (code.includes('__readyClickDeliveryProbe') && code.includes('Number(state.count')) return 'click'
  if (code.includes('__readyTextDeliveryProbe') && code.includes('changed: after !== state.before')) return 'text'
  if (code.includes('__readySubmitDeliveryProbe') && code.includes('keydown: Number')) return 'submit'
  if (code.includes('__readyKeyDeliveryProbe') && code.includes('Number(state.count')) return 'key'
  return null
}

function deliveryFromProbe(kind: 'click' | 'text' | 'submit' | 'key', value: unknown): 'delivered' | 'not_delivered' | 'unknown' {
  if (kind === 'click' || kind === 'key') {
    return typeof value === 'number' ? value > 0 ? 'delivered' : 'not_delivered' : 'unknown'
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown'
  const record = value as Record<string, unknown>
  if (kind === 'text') {
    return Number(record.count || 0) > 0 || record.changed === true ? 'delivered' : 'not_delivered'
  }
  return Number(record.keydown || 0) > 0 || Number(record.submit || 0) > 0 ? 'delivered' : 'not_delivered'
}

function transportSucceeded(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true
  const success = (value as Record<string, unknown>).success
  const ok = (value as Record<string, unknown>).ok
  return success !== false && ok !== false
}

/**
 * Bind every controller transport used by the current leaf to the durable
 * mutation boundary. Read-only controller methods remain ordinary probes.
 */
export function browserMutationController(
  controller: BrowserController,
  operationId: BrowserOperationId,
  boundary: BrowserMutationBoundary,
): BrowserController {
  return new Proxy(controller, {
    get(target, property) {
      if (property === BROWSER_CONTROLLER_STATE_TARGET) return target
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const invoke = () => Reflect.apply(value, target, args)
        const readbackKind = deliveryReadbackKind(property, args)
        if (readbackKind) {
          const result = invoke()
          const record = (resolved: unknown) => {
            boundary.recordMechanicalFact({ delivery: deliveryFromProbe(readbackKind, resolved) })
            return resolved
          }
          return result && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function'
            ? Promise.resolve(result).then(record)
            : record(result)
        }
        if (!TRANSPORT_METHODS.has(property)) {
          return invoke()
        }
        const result = boundary.invokeTransport(() => {
          const tabId = TAB_ID_FIRST_TRANSPORTS.has(property) && typeof args[0] === 'string'
            ? args[0]
            : null
          browserSnapshotService.markDirty(target, tabId)
          return invoke()
        })
        const record = (resolved: unknown) => {
          if (DIRECT_DELIVERY_TRANSPORTS.has(property)) {
            boundary.recordMechanicalFact({
              delivery: transportSucceeded(resolved) ? 'delivered' : 'not_delivered',
              ...(property === 'createTab' && resolved && typeof resolved === 'object'
                ? {
                    effect: 'popup' as const,
                    postActionTabId: typeof (resolved as Record<string, unknown>).id === 'string'
                      ? String((resolved as Record<string, unknown>).id)
                      : null,
                  }
                : {}),
              ...(property === 'handleBrowserDialog' ? { effect: 'dialog' as const } : {}),
              ...(property === 'archivePage' ? { effect: 'download' as const } : {}),
              ...(property === 'setFileInputFiles' ? { effect: 'target_value' as const } : {}),
            })
          }
          return resolved
        }
        return result && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function'
          ? Promise.resolve(result).then(record)
          : record(result)
      }
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target)
    },
  })
}
