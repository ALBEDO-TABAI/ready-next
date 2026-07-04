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

/**
 * D8（真机反复实锚）：pending_confirm 没有 TTL——用户擦碰一下 agent 页
 * 然后走开，横幅常驻且 agent 写入被永久冻结。惰性回落（与写租约过期同款
 * reconcile 模式）：pending_confirm 超时未确认视同 dismiss，回到 active。
 * 真想接管的用户有更强的租约级 takeover 信号兜底，不受此影响。
 */
const DEFAULT_PENDING_CONFIRM_TTL_MS = 45_000

export class AgentTabControlGate {
  private state: AgentTabControlState = 'active'
  private pendingSince: number | null = null
  private readonly pendingConfirmTtlMs: number
  private readonly now: () => number

  constructor(options: { pendingConfirmTtlMs?: number; now?: () => number } = {}) {
    this.pendingConfirmTtlMs = options.pendingConfirmTtlMs ?? DEFAULT_PENDING_CONFIRM_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** Lazily expire a stale pending_confirm before any read of state. */
  private reconcile(): void {
    if (
      this.state === 'pending_confirm'
      && this.pendingSince !== null
      && this.now() - this.pendingSince > this.pendingConfirmTtlMs
    ) {
      this.state = 'active'
      this.pendingSince = null
    }
  }

  getState(): AgentTabControlState {
    this.reconcile()
    return this.state
  }

  /** Agent writes are blocked while a confirmation is pending or after confirm. */
  isWriteBlocked(): boolean {
    this.reconcile()
    return this.state !== 'active'
  }

  /**
   * Whether the user has CONFIRMED the interruption. Distinct from
   * isWriteBlocked: `pending_confirm` blocks writes but must NOT cancel the
   * background task — only a confirmed freeze does (Codex result-review #1
   * residual). The runner's stop probe consumes this, not isWriteBlocked.
   */
  isFrozen(): boolean {
    this.reconcile()
    return this.state === 'frozen'
  }

  /**
   * A user interaction with the agent tab (page click/input/navigate/close) or
   * an explicit stop/takeover button. Freezes agent writes pending the
   * secondary confirmation. Returns true if it transitioned active→pending.
   */
  requestInterruption(): boolean {
    this.reconcile()
    if (this.state === 'active') {
      this.state = 'pending_confirm'
      this.pendingSince = this.now()
      return true
    }
    return false
  }

  /** User dismissed the secondary confirmation → unfreeze, agent resumes. */
  dismissInterruption(): void {
    if (this.state === 'pending_confirm') {
      this.state = 'active'
      this.pendingSince = null
    }
  }

  /**
   * User confirmed the interruption (stop or takeover). The gate moves to
   * `frozen`; the caller then cancels the child-run (release lease) or applies a
   * lease takeover. Writes stay blocked. Returns true if it transitioned.
   */
  confirmInterruption(): boolean {
    this.reconcile()
    if (this.state === 'pending_confirm') {
      this.state = 'frozen'
      this.pendingSince = null
      return true
    }
    return false
  }

  /** Reset to active (e.g. a fresh agent run reuses the surface). */
  reset(): void {
    this.state = 'active'
    this.pendingSince = null
  }
}
