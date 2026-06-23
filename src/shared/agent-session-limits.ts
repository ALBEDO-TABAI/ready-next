/**
 * Single source of truth for the concurrent-live agent-session cap.
 *
 * Imported by BOTH the renderer (session-tab create guard + "+" disable in
 * `useAgent.ts` / `ChatPanel.tsx`) and the main-process orchestrator's
 * defense-in-depth admission guard (`MAX_CONCURRENT_SESSIONS` in
 * `runtime-core/orchestrator.ts`). The two MUST agree: when the renderer cap
 * was 5 but the main cap was 3, sessions 4–5 looked creatable yet got rejected
 * with `session_limit_exceeded` on the first send / background create
 * (closed-loop gap fixed 2026-06-23). `agent-session-limit-parity.test.ts`
 * locks both sides to this constant so they can never drift apart again.
 *
 * A "live" session is one whose state is NOT terminal
 * (done / error|failed / cancelled / closed). Finished sessions are reclaimed
 * and never count, so this bounds only concurrent *unfinished* conversations,
 * not a lifetime total of how many you can start.
 */
export const MAX_AGENT_SESSIONS = 5
