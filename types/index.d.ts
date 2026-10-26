export type ContextFill = { tokens?: number; window: number; percent?: number }
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }
// The last rate-limit reading and when it was taken ($.clock.now()).
export type LimitsReading = { at: number; list: RateLimit[] }
// The checked-out branch, or a detached HEAD's short commit; null outside git.
export type BranchReading = { name: string | null }
// This session's main loop: when the turn now running began (null between turns), when the last one
// ended, and whether it waits on the person's answer.
export type TurnReading = { startedAt: number | null; endedAt: number | null; isAsking: boolean }
// What each desktop session writes for the others every few seconds while its process lives: its turn,
// how many background tasks it runs, the session that started it (a side session's), and when.
export type SessionStatus = TurnReading & { at: number; background: number; parentId: string | null }

declare module 'claude-code' {
  interface PluginState {
    'context-band': { fill: ContextFill | null; alerted: number; limits: LimitsReading | null; minute: number; branch: BranchReading | null; background: string[]; agents: string[] | null; turn: TurnReading }
  }
}
