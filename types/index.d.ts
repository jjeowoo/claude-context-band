export type ContextFill = { tokens?: number; window: number; percent?: number }
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }
// The last rate-limit reading and when it was taken ($.clock.now()).
export type LimitsReading = { at: number; list: RateLimit[] }

declare module 'claude-code' {
  interface PluginState {
    'context-band': { fill: ContextFill | null; alerted: number; limits: LimitsReading | null; minute: number }
  }
}
