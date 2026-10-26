import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, On } from 'claude-code'

import type { SessionStatus, TurnReading } from '../types'
import { runningTasks } from './tasks'

// What each desktop session is doing, as a mark at the front of its own title in the app's sidebar.
// The sidebar says it only by a shimmer over a working title and a gray dot on a finished one, and
// not at all for a session whose turn has ended while its background work goes on:
//
//   🔵 working        ❗ waiting on the person: a question, a plan, a permission or the app's own card
//   🏃 the turn has ended, but background tasks or a side session it started still run
//   ✅ ended since the person last had it on screen        no mark: ended and seen
//
// Each mark differs from the others in shape as well as color, so they tell apart at a glance.
//
// A session is on screen while the app has it attached: the app attaches the session it shows (two in
// a split view) and lets the others go.
//
// Each session marks only its own title, through the app's own rename tool, and only while a
// permission rule allows that tool outright: a mark is never worth a dialog or a classifier's call.
// To tell when its side sessions are at work, each writes its status to a small file every few
// seconds, which the others read.

const turn = atom({ plugin: 'context-band', key: 'turn' } as const, { startedAt: null, endedAt: null } as TurnReading)
// When the session was last seen on screen; 0 until it is.
const seen = atom({ plugin: 'context-band', key: 'seen' } as const, 0)

const TICK_MS = 5_000
// A status is written again this often while nothing changes, so the others can tell its process
// lives; one older than STALE_MS is a process gone, its session running nothing.
const HEARTBEAT_MS = 15_000
const STALE_MS = 45_000
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

type Paths = { selfId: string; record: string; statuses: string }
// What the app's record of this session says of it.
type OwnRecord = { title: string; lastFocusedAt: number; parentId: string | null }
// A parsed file and the time and size it was read at, which tell when it changed.
type Cached<T> = { stamp: string; value: T | null }

let recordCache: Cached<OwnRecord> | null = null
const statusCache = new Map<string, Cached<SessionStatus>>()
// What this session last wrote, without its time, and when.
let written: { text: string; at: number } | null = null
// The main loop's tool calls now running, by id: the tool, when it started, and whether a permission
// dialog was put to the person for it.
const calls = new Map<string, { tool: string; at: number; isAsked: boolean }>()
// The title last asked for, and when.
let asked: { title: string; at: number } | null = null
let isRenaming = false
let pausedUntil = 0

// Where the app keeps this session's record and where the statuses go; null outside a desktop session.
async function pathsOf($: EngineInterface): Promise<Paths | null> {
  const selfId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  const account = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  const org = await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (selfId === undefined || account === undefined || org === undefined || home === undefined) {
    return null
  }
  const appData = (await $.env.get('APPDATA')) ?? `${home}/Library/Application Support`
  return {
    selfId,
    record: `${appData}/Claude/claude-code-sessions/${account}/${org}/${selfId}.json`.replace(/\\/g, '/'),
    statuses: `${home}/.claude/context-band/sessions`.replace(/\\/g, '/'),
  }
}

const numberOr = (value: unknown, fallback: number) => (typeof value === 'number' ? value : fallback)

function toRecord(data: unknown): OwnRecord | null {
  const d = data as Record<string, unknown> | null
  if (typeof d !== 'object' || d === null || typeof d.title !== 'string') {
    return null
  }
  const parent = (d.spawnedFrom as { sessionId?: unknown } | undefined)?.sessionId
  return { title: d.title, lastFocusedAt: numberOr(d.lastFocusedAt, 0), parentId: typeof parent === 'string' ? parent : null }
}

function toStatus(data: unknown): SessionStatus | null {
  const s = data as Partial<SessionStatus> | null
  if (typeof s !== 'object' || s === null || typeof s.at !== 'number') {
    return null
  }
  return {
    at: s.at,
    startedAt: typeof s.startedAt === 'number' ? s.startedAt : null,
    endedAt: typeof s.endedAt === 'number' ? s.endedAt : null,
    isAsking: s.isAsking === true,
    background: numberOr(s.background, 0),
    parentId: typeof s.parentId === 'string' ? s.parentId : null,
  }
}

// The app's record of this session, read again only once it changed; one half written keeps what it
// last read.
async function ownRecord($: EngineInterface, paths: Paths): Promise<OwnRecord | null> {
  try {
    const { mtimeMs, size } = await $.fs.stat(paths.record)
    const stamp = `${mtimeMs}:${size}`
    if (recordCache === null || recordCache.stamp !== stamp) {
      recordCache = { stamp, value: toRecord(JSON.parse(await $.fs.read(paths.record))) }
    }
  } catch {
    // Kept as it last read.
  }
  return recordCache?.value ?? null
}

// The files of `entries` parsed, by name: one read again only once it changed, and one half written
// or gone keeps what it last parsed to.
async function readChanged<T>($: EngineInterface, dir: string, entries: readonly FsEntry[], cache: Map<string, Cached<T>>, parse: (data: unknown) => T | null): Promise<Map<string, T>> {
  const values = new Map<string, T>()
  for (const entry of entries) {
    const stamp = `${entry.mtimeMs}:${entry.size}`
    let cached = cache.get(entry.name)
    if (cached === undefined || cached.stamp !== stamp) {
      try {
        cached = { stamp, value: parse(JSON.parse(await $.fs.read(`${dir}/${entry.name}`))) }
        cache.set(entry.name, cached)
      } catch {
        // Kept as it last read.
      }
    }
    if (cached !== undefined && cached.value !== null) {
      values.set(entry.name, cached.value)
    }
  }
  return values
}

// This session's status, written when it changed or the heartbeat is due.
async function publish($: EngineInterface, paths: Paths, status: Omit<SessionStatus, 'at'>, now: number): Promise<void> {
  const text = JSON.stringify(status)
  if (written !== null && written.text === text && now - written.at < HEARTBEAT_MS) {
    return
  }
  await $.fs.write(`${paths.statuses}/${paths.selfId}.json`, JSON.stringify({ at: now, ...status }))
  written = { text, at: now }
}

// How many side sessions this one started are at work now, by their own statuses.
async function busySides($: EngineInterface, paths: Paths, now: number): Promise<number> {
  const entries = (await $.fs.list(paths.statuses).catch(() => [] as FsEntry[]))
    .filter(e => e.kind === 'file' && e.name.endsWith('.json') && e.name !== `${paths.selfId}.json`)
  const statuses = await readChanged($, paths.statuses, entries, statusCache, toStatus)
  return [...statuses.values()].filter(s =>
    s.parentId === paths.selfId && now - s.at < STALE_MS && (s.isAsking || s.startedAt !== null || s.background > 0)).length
}

// Whether a call of the main loop waits on the person's answer now.
function isWaitingOnPerson(now: number): boolean {
  return [...calls.values()].some(call => call.isAsked || PERSON_TOOLS.includes(call.tool) ||
    (call.tool.startsWith(APP_TOOL_PREFIX) && now - call.at >= APP_WAIT_MS))
}

// `seenAt`: when the person last had the session on screen or opened it.
function markOf(t: TurnReading, isAsking: boolean, tasks: number, sides: number, seenAt: number): Mark | null {
  if (isAsking) {
    return 'asking'
  }
  if (t.startedAt !== null) {
    return 'working'
  }
  if (tasks > 0 || sides > 0) {
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

// Writes this session's status and brings its title's mark up to date.
async function refresh($: EngineInterface, isEnding = false): Promise<void> {
  const paths = await pathsOf($)
  if (paths === null) {
    return
  }
  const now = await $.clock.now()
  const own = await ownRecord($, paths)
  const t = await read($, turn)
  // An ending process takes its turn, its calls and its background tasks with it.
  const ending = isEnding ? { ...t, startedAt: null } : t
  const isAsking = !isEnding && isWaitingOnPerson(now)
  const tasks = isEnding ? 0 : await runningTasks($)
  await publish($, paths, { ...ending, isAsking, background: tasks, parentId: own?.parentId ?? null }, now)
  if (own === null) {
    return
  }
  const sides = isEnding ? 0 : await busySides($, paths, now)
  if (!isEnding && (await $.session.surfaces()).length > 0) {
    await update($, seen, () => now)
  }
  const seenAt = Math.max(own.lastFocusedAt, await read($, seen))
  await retitle($, own.title, markOf(ending, isAsking, tasks, sides, seenAt), now)
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

// Run at the session's start, once it is bound: in a desktop session, the first status and mark, then
// the timer that keeps them current.
export async function startSessions($: EngineInterface): Promise<void> {
  if ((await pathsOf($)) === null) {
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
  // The main loop's turns, kept for the status; a subagent's run is the session's background, which
  // the band counts. These sit in the path of every turn and call, so a slip here is caught.
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
