/**
 * AgentTabControlGate — freeze-then-confirm supervision for the agent's browser
 * tab (plan §3.6, Codex R2 #2).
 *
 * The write-lease (idle/held/takeover/expired) is deliberately NOT a task state
 * machine, so the "user is interrupting, freeze the agent's writes until they
 * confirm stop/takeover" concern lives here, separate from the lease. Per agent
 * surface:
 *
 *   active          — agent may write (subject to the lease).
 *   pending_confirm — a user interruption is awaiting a secondary confirmation;
 *                     the agent's writes are FROZEN (blocked, not cancelled).
 *   frozen          — the user confirmed; the agent is suspended while the
 *                     caller performs the cancel (release lease) or takeover.
 *
 * The facade consults isWriteBlocked() before every agent write. Transitions are
 * driven by the supervision UI / main-process input signals, never by the agent.
 *
 * Pure module — no Electron, no IO.
 */

export type AgentTabControlState = 'active' | 'pending_confirm' | 'frozen'

export class AgentTabControlGate {
  private state: AgentTabControlState = 'active'

  getState(): AgentTabControlState {
    return this.state
  }

  /** Agent writes are blocked while a confirmation is pending or after confirm. */
  isWriteBlocked(): boolean {
    return this.state !== 'active'
  }

  /**
   * A user interaction with the agent tab (page click/input/navigate/close) or
   * an explicit stop/takeover button. Freezes agent writes pending the
   * secondary confirmation. Returns true if it transitioned active→pending.
   */
  requestInterruption(): boolean {
    if (this.state === 'active') {
      this.state = 'pending_confirm'
      return true
    }
    return false
  }

  /** User dismissed the secondary confirmation → unfreeze, agent resumes. */
  dismissInterruption(): void {
    if (this.state === 'pending_confirm') {
      this.state = 'active'
    }
  }

  /**
   * User confirmed the interruption (stop or takeover). The gate moves to
   * `frozen`; the caller then cancels the child-run (release lease) or applies a
   * lease takeover. Writes stay blocked. Returns true if it transitioned.
   */
  confirmInterruption(): boolean {
    if (this.state === 'pending_confirm') {
      this.state = 'frozen'
      return true
    }
    return false
  }

  /** Reset to active (e.g. a fresh agent run reuses the surface). */
  reset(): void {
    this.state = 'active'
  }
}
