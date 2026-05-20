import { createStepBudgetState } from './task-projection/run-budget-policy'
import type { StepBudgetState, TaskStep } from './run-contracts'

export function detectTaskStepCompletionCue(text: string, currentStep?: TaskStep | null): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  if (/步骤\s*\d+\s*完成/.test(normalized)) return true
  if (/当前步骤已完成|本步骤已完成|进入下一步|继续下一步/.test(normalized)) return true
  if (currentStep?.title && normalized.includes(currentStep.title) && /完成|已完成/.test(normalized)) return true
  return false
}

export function initializeTaskStepProgress(steps: TaskStep[]): {
  steps: TaskStep[]
  currentStepId: string | null
} {
  if (steps.length === 0) {
    return {
      steps: [],
      currentStepId: null,
    }
  }
  return {
    steps: steps.map((step, index) => ({
      ...step,
      status: index === 0 ? 'running' : 'pending',
      updatedAt: step.updatedAt || new Date().toISOString(),
    })),
    currentStepId: steps[0]?.id || null,
  }
}

export function advanceTaskStepProgress(params: {
  steps: TaskStep[]
  currentStepId?: string | null
  totalIterations: number
  summary?: string | null
  timestamp?: string
}): {
  steps: TaskStep[]
  currentStepId: string | null
  stepBudget: StepBudgetState | null
  advanced: boolean
} {
  const currentIndex = Math.max(0, params.steps.findIndex((step) => step.id === params.currentStepId))
  if (params.steps.length === 0 || currentIndex < 0) {
    return {
      steps: params.steps,
      currentStepId: params.currentStepId || null,
      stepBudget: null,
      advanced: false,
    }
  }

  const timestamp = params.timestamp || new Date().toISOString()
  const nextIndex = currentIndex + 1
  const nextSteps = params.steps.map((step, index) => {
    if (index === currentIndex) {
      return {
        ...step,
        status: 'done' as const,
        detail: params.summary || step.detail || null,
        updatedAt: timestamp,
      }
    }
    if (index === nextIndex) {
      return {
        ...step,
        status: 'running' as const,
        updatedAt: timestamp,
      }
    }
    return step
  })

  if (!nextSteps[nextIndex]) {
    return {
      steps: nextSteps,
      currentStepId: nextSteps[currentIndex]?.id || null,
      stepBudget: null,
      advanced: false,
    }
  }

  return {
    steps: nextSteps,
    currentStepId: nextSteps[nextIndex].id,
    stepBudget: createStepBudgetState({
      stepId: nextSteps[nextIndex].id,
      totalIterations: params.totalIterations,
      stepCount: nextSteps.length,
      suggestedMaxIterations: nextSteps[nextIndex].budget,
    }),
    advanced: true,
  }
}
