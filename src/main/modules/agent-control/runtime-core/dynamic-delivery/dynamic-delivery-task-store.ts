import { createHash } from 'node:crypto'

import type { DeliveryStateV1, WorkPackage } from '../../../../../shared/dynamic-delivery'
import type { TaskProjectionRecord } from '../../contracts/run-contracts'
import type { TaskProjectionRepository } from '../../../repositories/task-projection-repository'

function stableSuffix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function deliveryAttemptIdentity(input: {
  parentTaskId: string
  parentGeneration: number
  packageId: string
  attempt: 0 | 1
}): { childTaskId: string; lifecycleId: string } {
  const logical = `${input.parentTaskId}|${input.parentGeneration}|${input.packageId}|${input.attempt}`
  const suffix = stableSuffix(logical)
  return {
    childTaskId: `delivery-child-${suffix}`,
    lifecycleId: `delivery-life-${suffix}`,
  }
}

export class DynamicDeliveryTaskStore {
  constructor(private readonly repository: TaskProjectionRepository) {}

  createPacketTree(input: {
    parent: TaskProjectionRecord
    deliveryState: DeliveryStateV1
    packages: readonly WorkPackage[]
    buildChild: (input: {
      workPackage: WorkPackage
      childTaskId: string
      lifecycleId: string
    }) => TaskProjectionRecord
  }): TaskProjectionRecord[] {
    if (input.deliveryState.decision === 'support_and_verify' && input.packages.length === 0) {
      throw new Error('[dynamic-delivery] support decision requires at least one work package')
    }
    if (input.deliveryState.decision !== 'support_and_verify' && input.packages.length > 0) {
      throw new Error('[dynamic-delivery] only support decision may create packet children')
    }
    const children = input.packages.map((workPackage) => {
      const identity = deliveryAttemptIdentity({
        parentTaskId: input.parent.taskId,
        parentGeneration: input.deliveryState.parentGeneration,
        packageId: workPackage.packageId,
        attempt: 0,
      })
      return input.buildChild({ workPackage, ...identity })
    })
    this.repository.createDeliveryTreeAtomic({
      parentTaskId: input.parent.taskId,
      deliveryState: input.deliveryState,
      children,
    })
    return children
  }

  reduceState(input: Parameters<TaskProjectionRepository['reduceDeliveryState']>[0]): DeliveryStateV1 {
    return this.repository.reduceDeliveryState(input)
  }
}
