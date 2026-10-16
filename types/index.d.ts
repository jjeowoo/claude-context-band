export type ContextFill = { tokens?: number; window: number; percent?: number }

declare module 'claude-code' {
  interface PluginState {
    'context-band': { fill: ContextFill | null; alerted: number }
  }
}
