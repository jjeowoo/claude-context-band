import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { TurnReading } from '../types'
import { runningTasks } from './tasks'

// What each desktop session is doing, as a mark at the front of its own title in the app's sidebar.
// The sidebar says it only by a shimmer over a working title and a gray dot on a finished one, and
// not at all for a session whose turn has ended while its background work goes on:
//
//   🔵 working        ❗ waiting on the person: a question, a plan, a permission or the app's own card
//   🏃 the turn has ended, but background tasks it started still run
//   ✅ ended since the person last had it on screen        no mark: ended and seen
//
// Each mark differs from the others in shape as well as color, so they tell apart at a glance. A mark
// says what that session itself is doing: a side session it started has its own title to mark.
//
// A session is on screen while the app has it attached: the app attaches the session it shows (two in
// a split view) and lets the others go.
//
// Each session marks only its own title, through the app's own rename tool, and only while a
// permission rule allows that tool outright: a mark is never worth a dialog or a classifier's call.

const turn = atom({ plugin: 'context-band', key: 'turn' } as const, { startedAt: null, endedAt: null } as TurnReading)
// When the session was last seen on screen; 0 until it is.
const seen = atom({ plugin: 'context-band', key: 'seen' } as const, 0)

const TICK_MS = 5_000
const RENAME_TOOL = 'mcp__ccd_session_mgmt__set_session_title'
// A title asked for this recently is not asked again while the app's record still shows the old one.
const ASKED_WAIT_MS = 15_000
// After a rename fails (the person declined it, say), none is asked for this long.
const FAILED_WAIT_MS = 10 * 60_000
const MARKS = { asking: '❗', working: '🔵', background: '🏃', done: '✅' } as const
type Mark = keyof typeof MARKS
// A mark this mod put at a title's front, taken off before another goes on: these, or one an earlier
// version put there (its emoji with the variation selector the app may add, or a plain symbol).
const MARKED = /^(?:[🔵🏃🟠🟣🟢]|[❗⏳✅]️?|[!●◐✓]) /u
// Tools whose call is a question to the person, waiting on them from its start.
const PERSON_TOOLS = ['AskUserQuestion', 'ExitPlanMode']
// The app's own tools answer at once unless the app asks the person first (a delete to confirm, a
// session offered): one still running this long waits on them.
const APP_TOOL_PREFIX = 'mcp__ccd_'
const APP_WAIT_MS = 2_000
// The pane an earlier version listed the sessions in.
const OLD_PANE = 'sessions'

// What the app's record of this session says of it.
type OwnRecord = { title: string; lastFocusedAt: number }
// The record parsed, and the time and size it was read at, which tell when it changed.
type Cached = { stamp: string; value: OwnRecord | null }

let recordCache: Cached | null = null
// The main loop's tool calls now running, by id: the tool, when it started, and whether a permission
// dialog was put to the person for it.
const calls = new Map<string, { tool: string; at: number; isAsked: boolean }>()
// The title last asked for, and when.
let asked: { title: string; at: number } | null = null
let isRenaming = false
let pausedUntil = 0

// Where the app keeps this session's record; null outside a desktop session.
async function recordPath($: EngineInterface): Promise<string | null> {
  const selfId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  const account = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  const org = await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (selfId === undefined || account === undefined || org === undefined || home === undefined) {
    return null
  }
  const appData = (await $.env.get('APPDATA')) ?? `${home}/Library/Application Support`
  return `${appData}/Claude/claude-code-sessions/${account}/${org}/${selfId}.json`.replace(/\\/g, '/')
}

function toRecord(data: unknown): OwnRecord | null {
  const d = data as Record<string, unknown> | null
  if (typeof d !== 'object' || d === null || typeof d.title !== 'string') {
    return null
  }
  return { title: d.title, lastFocusedAt: typeof d.lastFocusedAt === 'number' ? d.lastFocusedAt : 0 }
}

// The app's record of this session, read again only once it changed; one half written keeps what it
// last read.
async function ownRecord($: EngineInterface, path: string): Promise<OwnRecord | null> {
  try {
    const { mtimeMs, size } = await $.fs.stat(path)
    const stamp = `${mtimeMs}:${size}`
    if (recordCache === null || recordCache.stamp !== stamp) {
      recordCache = { stamp, value: toRecord(JSON.parse(await $.fs.read(path))) }
    }
  } catch {
    // Kept as it last read.
  }
  return recordCache?.value ?? null
}

// Whether a call of the main loop waits on the person's answer now.
function isWaitingOnPerson(now: number): boolean {
  return [...calls.values()].some(call => call.isAsked || PERSON_TOOLS.includes(call.tool) ||
    (call.tool.startsWith(APP_TOOL_PREFIX) && now - call.at >= APP_WAIT_MS))
}

// `seenAt`: when the person last had the session on screen or opened it.
function markOf(t: TurnReading, isAsking: boolean, tasks: number, seenAt: number): Mark | null {
  if (isAsking) {
    return 'asking'
  }
  if (t.startedAt !== null) {
    return 'working'
  }
  if (tasks > 0) {
    return 'background'
  }
  return t.endedAt !== null && seenAt < t.endedAt ? 'done' : null
}

// Puts `mark` at the front of the title in place of the one there, through the app's rename tool.
async function retitle($: EngineInterface, current: string, mark: Mark | null, now: number): Promise<void> {
  const base = current.replace(MARKED, '')
  const title = mark === null ? base : `${MARKS[mark]} ${base}`
  if (title === current || base.trim() === '' || isRenaming || now < pausedUntil) {
    return
  }
  if (asked !== null && asked.title === title && now - asked.at < ASKED_WAIT_MS) {
    return
  }
  const input = { session_id: 'self', title }
  if ((await $.tool.check({ tool: RENAME_TOOL, input })).decision !== 'allow') {
    return
  }
  isRenaming = true
  asked = { title, at: now }
  try {
    const result = await $.tool.call({ tool: RENAME_TOOL, ...input })
    if (result.isError === true) {
      pausedUntil = now + FAILED_WAIT_MS
    } else if (recordCache?.value != null) {
      // The record rewritten within the same millisecond and size would read as unchanged.
      recordCache = { ...recordCache, value: { ...recordCache.value, title } }
    }
  } catch {
    pausedUntil = now + FAILED_WAIT_MS
  } finally {
    isRenaming = false
  }
}

// Brings the title's mark up to date.
async function refresh($: EngineInterface, isEnding = false): Promise<void> {
  const path = await recordPath($)
  const own = path === null ? null : await ownRecord($, path)
  if (own === null) {
    return
  }
  const now = await $.clock.now()
  const t = await read($, turn)
  if (!isEnding && (await $.session.surfaces()).length > 0) {
    await update($, seen, () => now)
  }
  const seenAt = Math.max(own.lastFocusedAt, await read($, seen))
  // An ending process takes its turn, its calls and its background tasks with it.
  const mark = isEnding
    ? markOf({ ...t, startedAt: null }, false, 0, seenAt)
    : markOf(t, isWaitingOnPerson(now), await runningTasks($), seenAt)
  await retitle($, own.title, mark, now)
}

async function setTurn($: EngineInterface, change: (t: TurnReading) => TurnReading): Promise<void> {
  await update($, turn, change)
  void refresh($).catch(() => {})
}

// Runs a main-loop tool call, kept among `calls` while it runs so the mark can tell one that waits on
// the person; a call that did so redraws the mark as it ends. Its own bookkeeping never fails the call.
export async function watchCall<R>($: EngineInterface, e: { tool: string; tool_use_id: string; agentId?: string }, call: () => Promise<R>): Promise<R> {
  if (e.agentId !== undefined || e.tool === RENAME_TOOL) {
    return call()
  }
  const at = await $.clock.now().catch(() => 0)
  calls.set(e.tool_use_id, { tool: e.tool, at, isAsked: false })
  const timer = e.tool.startsWith(APP_TOOL_PREFIX) ? $.clock.after(APP_WAIT_MS, () => void refresh($).catch(() => {})) : null
  if (PERSON_TOOLS.includes(e.tool)) {
    void refresh($).catch(() => {})
  }
  try {
    return await call()
  } finally {
    timer?.cancel()
    const now = await $.clock.now().catch(() => at)
    const hasWaited = isWaitingOnPerson(now)
    calls.delete(e.tool_use_id)
    if (hasWaited) {
      void refresh($).catch(() => {})
    }
  }
}

// Run at the session's start, once it is bound: in a desktop session, the first mark, then the timer
// that keeps it current.
export async function startSessions($: EngineInterface): Promise<void> {
  if ((await recordPath($)) === null) {
    return
  }
  if ((await $.ui.panes()).some(pane => pane.id === OLD_PANE)) {
    await $.ui.close({ id: OLD_PANE }).catch(() => {})
  }
  await refresh($).catch(() => {})
  $.clock.every(TICK_MS, () => {
    void refresh($).catch(() => {})
  })
}

export function registerSessions(on: On): void {
  // The main loop's turns, kept for the mark; a subagent's run is the session's background, which the
  // band counts. These sit in the path of every turn and call, so a slip here is caught.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await setTurn($, t => ({ ...t, startedAt: now })).catch(() => {})
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      // A call cut off with the turn never ends on its own.
      calls.clear()
      await setTurn($, () => ({ startedAt: null, endedAt: now })).catch(() => {})
    }
    return next(e)
  })

  // A permission dialog put to the person for a main-loop call: they are waited on until it ends.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (e.agent_id === undefined) {
      for (const call of calls.values()) {
        call.isAsked ||= call.tool === e.tool_name
      }
      void refresh($).catch(() => {})
    }
    return next(e)
  })

  // A closing process takes its mark down to what holds once it is gone: done, or nothing.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      await refresh($, true).catch(() => {})
    }
    return next(e)
  })
}
