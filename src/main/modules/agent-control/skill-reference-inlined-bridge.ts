/**
 * Bridge between `SkillContextOrchestrator.maybeInjectExplicitSkillContext`
 * (the caller that actually performs the SKILL.md direct-read injection) and
 * the IPC layer (which owns the renderer `mainWindow` reference). The
 * orchestrator lives under agent-control and must not pull electron into its
 * module tree — emitting through a bridge keeps the orchestrator testable
 * under `tsx --test`.
 *
 * When no emitter is registered (unit tests, headless boot, mainWindow not
 * yet wired), reads return a no-op — the `skill_reference_inlined` metric
 * written by `logAgentMetric` remains the authoritative record and the UI
 * just doesn't get the banner.
 */

export interface SkillReferenceInlinedEvent {
  sessionId: string | null
  skillId: string
  skillName: string
  source: 'direct_read' | 'tool_fallback'
  bytesInjected: number
  truncated: boolean
  at: number
}

export type EmitSkillReferenceInlined = (event: SkillReferenceInlinedEvent) => void

const noopEmitter: EmitSkillReferenceInlined = () => {}

let registeredEmitter: EmitSkillReferenceInlined = noopEmitter

export function registerSkillReferenceInlinedEmitter(emitter: EmitSkillReferenceInlined | null): void {
  registeredEmitter = emitter || noopEmitter
}

export function emitSkillReferenceInlined(event: SkillReferenceInlinedEvent): void {
  registeredEmitter(event)
}

// Exposed for tests that want to swap the emitter in-place and read events.
export function _resetSkillReferenceInlinedBridgeForTests(): void {
  registeredEmitter = noopEmitter
}
