export type ContextFill = { tokens?: number; window: number; percent?: number }
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }
// The last rate-limit reading and when it was taken ($.clock.now()).
export type LimitsReading = { at: number; list: RateLimit[] }
// The checked-out branch, or a detached HEAD's short commit; null outside git.
export type BranchReading = { name: string | null }
// This session's main loop: when the turn now running began (null between turns), and when the last
// one ended.
export type TurnReading = { startedAt: number | null; endedAt: number | null }

declare module 'claude-code' {
  interface PluginState {
    'context-band': { fill: ContextFill | null; alerted: number; limits: LimitsReading | null; minute: number; branch: BranchReading | null; background: string[]; agents: string[] | null; turn: TurnReading; seen: number; question: boolean }
  }
}
