import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BranchReading, ContextFill, LimitsReading, RateLimit } from '../types'
import { registerSessions, startSessions, watchCall } from './sessions'
import { endTasks, runningTasks, startTask, takeAgents } from './tasks'

const fill = atom({ plugin: 'context-band', key: 'fill' } as const, null as ContextFill | null)
const alerted = atom({ plugin: 'context-band', key: 'alerted' } as const, 0)
const limits = atom({ plugin: 'context-band', key: 'limits' } as const, null as LimitsReading | null)
// Bumped every minute so the reset countdowns redraw.
const minute = atom({ plugin: 'context-band', key: 'minute' } as const, 0)
// The branch checked out where the session runs; null until checked.
const branch = atom({ plugin: 'context-band', key: 'branch' } as const, null as BranchReading | null)

// The limits are the account's, not the session's: the last reading any session got is kept
// across sessions, so a session that has had no response yet still shows them.
const STORE_KEY = 'limits'

const THRESHOLDS = [90, 75]
const BAR_CELLS = 10
const BAR_WIDTH = 37
// The shorter bar a desktop band takes once every detail is gone and it still does not fit.
const BAR_NARROW_WIDTH = 32
const BAR_HEIGHT = 6
// Widths in CSS pixels, measured on each surface: a `bodyColumns` cell and a text cell (cellsOf
// counts a Hangul character as two). VS Code's panel counts its columns by the width of `─` in its
// own font, a full-width glyph there, so one of its columns holds about two text cells.
type Metric = { columnPx: number; textCellPx: number }
const METRICS: Record<'desktop' | 'vscode', Metric> = {
  desktop: { columnPx: 7, textCellPx: 6.4 },
  vscode: { columnPx: 13, textCellPx: 6.8 },
}
// The sm gap inside an item, and a divider with its xs gaps.
const GAP_PX = 8
const DIVIDER_PX = 16
const SPARE_PX = 16
const BRANCH_MAX = 24
const FILL_COLORS = { normal: '#8b8f98', warning: '#d9922e', error: '#d9534f' }
const LIMIT_LABELS: Record<string, string> = { five_hour: '세션', seven_day: '주간', spend_limit: '지출' }
const LIMIT_ORDER = ['five_hour', 'seven_day', 'spend_limit']

type Level = keyof typeof FILL_COLORS
// `detail` is the parenthesized rest, the first thing a narrow band gives up, one item at a time in
// `detailRank` order: the context's token counts (1, the percent already says it), the weekly reset
// (2, days off), then the session's countdown (3, the one that matters soonest).
type Part = { name: string; percent: number; text: string; detail: string; detailRank: number }
const DETAIL_RANKS: Record<string, number> = { seven_day: 2, five_hour: 3 }
// Said after each percent while there is room; a word the percent can do without.
const USE = ' 사용'
// What a desktop band shows at a given width, from the whole of it to the least, each step giving
// up one thing more: the token counts, the weekly reset, the word 사용, the session's countdown,
// shorter bars, the bars, and the item names. The percents and the tags (the branch, the
// background count) always stay: "14% │ 6% │ 12% │ main │ bg (0)" is the least a band shows.
// `detailsDropped`: the details of that rank and below are left out.
type Fit = { barWidth: number; detailsDropped: number; showsUse: boolean; showsNames: boolean }
const FITS: Fit[] = [
  { barWidth: BAR_WIDTH, detailsDropped: 0, showsUse: true, showsNames: true },
  { barWidth: BAR_WIDTH, detailsDropped: 1, showsUse: true, showsNames: true },
  { barWidth: BAR_WIDTH, detailsDropped: 2, showsUse: true, showsNames: true },
  { barWidth: BAR_WIDTH, detailsDropped: 2, showsUse: false, showsNames: true },
  { barWidth: BAR_WIDTH, detailsDropped: 9, showsUse: false, showsNames: true },
  { barWidth: BAR_NARROW_WIDTH, detailsDropped: 9, showsUse: false, showsNames: true },
  { barWidth: 0, detailsDropped: 9, showsUse: false, showsNames: true },
  { barWidth: 0, detailsDropped: 9, showsUse: false, showsNames: false },
]

function levelOf(percent: number): Level {
  return percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'normal'
}

function barSvg(percent: number, level: Level, width: number): string {
  const r = BAR_HEIGHT / 2
  const w = Math.max(0, Math.min(width, (percent / 100) * width))
  const fillRect = w === 0 ? '' : `<rect width="${Math.max(w, BAR_HEIGHT).toFixed(1)}" height="${BAR_HEIGHT}" rx="${r}" fill="${FILL_COLORS[level]}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAR_HEIGHT}" viewBox="0 0 ${width} ${BAR_HEIGHT}"><rect width="${width}" height="${BAR_HEIGHT}" rx="${r}" fill="#8b8f98" fill-opacity="0.25"/>${fillRect}</svg>`
}

// Hangul Jamo, CJK, Hangul syllables, compatibility ideographs, fullwidth forms.
const WIDE_RANGES: [number, number][] = [[0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xff00, 0xff60], [0xffe0, 0xffe6]]

// Cells a text takes: two for a Hangul or other wide character, one for the rest.
function cellsOf(text: string): number {
  let cells = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const isWide = WIDE_RANGES.some(([from, to]) => cp >= from && cp <= to)
    cells += isWide ? 2 : 1
  }
  return cells
}

// The fullest band that fits `columns`, its width in pixels estimated from the texts and bars it
// would draw; the least of them when none does.
function fitFor(parts: Part[], tags: string[], columns: number, { columnPx, textCellPx }: Metric): Fit {
  for (const fit of FITS) {
    let px = SPARE_PX
    parts.forEach((part, index) => {
      const detail = part.detailRank > fit.detailsDropped ? part.detail : ''
      const text = part.text + (fit.showsUse ? USE : '') + detail
      px += (index === 0 ? 0 : DIVIDER_PX) + cellsOf(text) * textCellPx
      px += fit.showsNames ? cellsOf(part.name) * textCellPx + GAP_PX : 0
      px += fit.barWidth === 0 ? 0 : fit.barWidth + GAP_PX
    })
    tags.forEach((tag, index) => {
      px += (parts.length === 0 && index === 0 ? 0 : DIVIDER_PX) + cellsOf(tag) * textCellPx
    })
    if (px <= columns * columnPx) {
      return fit
    }
  }
  return FITS[FITS.length - 1]
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// " (4시간 23분 후 재설정)", " (2일 5시간 후 재설정)", " (12분 후 재설정)", counted from now so it never needs the time zone.
function untilText(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((at - now) / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const span = days > 0 ? `${days}일 ${hours}시간` : hours > 0 ? `${hours}시간 ${mins}분` : `${mins}분`
  return ` (${span} 후 재설정)`
}

// The weekly reset as a weekday and a 24-hour time in the person's own time zone:
// " (금요일 03:00 재설정)".
function resetAtText(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return ` (${'일월화수목금토'[d.getDay()]}요일 ${pad(d.getHours())}:${pad(d.getMinutes())} 재설정)`
}

// A window whose reset has passed since the reading is dropped: its figure no longer holds.
function limitParts(list: RateLimit[], now: number): Part[] {
  const rank = (kind: string) => LIMIT_ORDER.indexOf(kind) + 1 || 99
  const parts: Part[] = []
  for (const l of [...list].sort((a, b) => rank(a.kind) - rank(b.kind))) {
    const at = l.resetsAt === undefined ? NaN : Date.parse(l.resetsAt)
    if (!Number.isNaN(at) && at <= now) continue
    parts.push({
      name: LIMIT_LABELS[l.kind] ?? l.kind,
      percent: l.percentUsed,
      text: `${Math.round(l.percentUsed)}%`,
      detail: Number.isNaN(at) ? '' : l.kind === 'seven_day' ? resetAtText(at) : untilText(at, now),
      detailRank: DETAIL_RANKS[l.kind] ?? 4,
    })
  }
  return parts
}

function toLimits(list: { kind: string; percentUsed: number; resetsAt?: string }[]): RateLimit[] {
  return list.map(({ kind, percentUsed, resetsAt }) => (resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt }))
}

function isReading(value: unknown): value is LimitsReading {
  return typeof value === 'object' && value !== null && typeof (value as LimitsReading).at === 'number' &&
    Array.isArray((value as LimitsReading).list)
}

async function storedLimits($: EngineInterface): Promise<LimitsReading | null> {
  try {
    const stored = await $.store.get(STORE_KEY)
    return isReading(stored) ? stored : null
  } catch {
    return null
  }
}

// A live reading is stored for the other sessions; otherwise a newer stored one is taken.
async function takeLimits($: EngineInterface, live?: RateLimit[]): Promise<void> {
  if (live !== undefined && live.length > 0) {
    const reading = { at: await $.clock.now(), list: live }
    await update($, limits, () => reading)
    try {
      await $.store.set(STORE_KEY, reading)
    } catch {
      // Not shared this time; this session still shows it.
    }
    return
  }
  const stored = await storedLimits($)
  const current = await read($, limits)
  if (stored !== null && (current === null || stored.at > current.at)) {
    await update($, limits, () => stored)
  }
}

// The live figure once the session has had a response; before that, a local estimate
// (`breakdown: 'summary'` sends no request). Null when neither is available.
async function estimate($: EngineInterface): Promise<ContextFill | null> {
  try {
    const { context } = await $.session.usage()
    if (context.percent !== undefined) {
      return { tokens: context.tokens, window: context.window, percent: context.percent }
    }
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (b !== undefined) {
      return { tokens: b.totalTokens, window: b.rawMaxTokens, percent: Math.round(b.percentage) }
    }
  } catch {
    // No session bound yet: the first response fills it in through session.measure.
  }
  return null
}

// The checkout's git directory: `.git` itself, or in a worktree the folder its `.git` file points to.
async function gitDir($: EngineInterface, dir: string): Promise<string | null> {
  const dotGit = `${dir}/.git`
  const { kind } = await $.fs.stat(dotGit)
  if (kind === 'dir') {
    return dotGit
  }
  const pointed = /^gitdir:\s*(.+?)\s*$/m.exec(await $.fs.read(dotGit))?.[1]
  if (pointed === undefined) {
    return null
  }
  return /^([A-Za-z]:)?[\\/]/.test(pointed) ? pointed : `${dir}/${pointed}`
}

// The branch checked out in the session's own working copy: read from its HEAD, found by walking
// up from the session's directory. A detached HEAD reads as its short commit, a worktree as `worktree`.
async function currentBranch($: EngineInterface): Promise<BranchReading> {
  try {
    if ((await $.session.repo()) === null) {
      return { name: null }
    }
    let dir = (await $.session.root()).replace(/\\/g, '/').replace(/\/+$/, '')
    for (let depth = 0; depth < 64; depth++) {
      const git = await gitDir($, dir).catch(() => undefined)
      if (git !== undefined) {
        if (git === null) {
          return { name: null }
        }
        // A worktree's branch names are long and its own anyway: the band says only that it is one.
        if (/\/worktrees\/[^/]+\/?$/.test(git.replace(/\\/g, '/'))) {
          return { name: 'worktree' }
        }
        const head = (await $.fs.read(`${git}/HEAD`)).trim()
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1]
        return { name: ref ?? (/^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : null) }
      }
      const parent = dir.replace(/\/[^/]*$/, '')
      if (parent === dir || parent === '') {
        break
      }
      dir = parent
    }
  } catch {
    // Unreadable: no branch shown.
  }
  return { name: null }
}

// A long name would wrap the band onto a second row: cut it, ending in an ellipsis.
function shortBranch(name: string | null): string | null {
  const chars = name === null ? [] : [...name]
  return chars.length > BRANCH_MAX ? `${chars.slice(0, BRANCH_MAX - 1).join('')}…` : name
}

async function takeBranch($: EngineInterface): Promise<void> {
  const reading = await currentBranch($)
  const current = await read($, branch)
  if (current?.name !== reading.name) {
    await update($, branch, () => reading)
  }
}

// The background task a tool call started that the session's agent record does not hold: a
// background or Ctrl+B'd command, a monitor, a remote agent.
function startedTask(tool: string, result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined
  }
  const r = result as Record<string, unknown>
  const id = tool === 'Bash' ? r.backgroundTaskId
    : tool === 'Monitor' ? r.taskId
    : tool === 'Agent' && r.status === 'remote_launched' ? r.taskId
    : undefined
  return typeof id === 'string' && id !== '' ? id : undefined
}

// The tasks a notification row says have ended: each <task-id> with an ending <status> after it.
function endedTasks(content: unknown): string[] {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  const ended: string[] = []
  for (const m of text.matchAll(/<task-id>([^<]+)<\/task-id>(?:(?!<task-id>)[\s\S])*?<status>(completed|failed|killed|stopped)<\/status>/g)) {
    ended.push(m[1].trim())
  }
  return ended
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const estimated = await estimate($)
    if (estimated !== null) {
      await update($, fill, () => estimated)
    }
    let live: RateLimit[] | undefined
    try {
      live = toLimits((await $.session.usage()).rateLimits)
    } catch {
      // No reading yet: the stored one stands until the first response.
    }
    await takeLimits($, live)
    await takeBranch($)
    await takeAgents($)
    // Each minute: redraw the countdowns, take a newer reading another session stored,
    // and catch a branch switched outside the session.
    $.clock.every(60_000, () => {
      void takeLimits($).then(() => update($, minute, n => n + 1))
      void takeBranch($)
    })
    // Every five seconds: agents start and end with no event of their own to say so.
    $.clock.every(5_000, () => {
      void takeAgents($).catch(() => {})
    })
    await startSessions($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await takeLimits($, toLimits(e.rateLimits))
    }
    if (e.changed.includes('context')) {
      const { tokens, window, percent } = e.context
      await update($, fill, () => ({ tokens, window, percent }))

      if (percent !== undefined) {
        const reached = THRESHOLDS.find(t => percent >= t) ?? 0
        const last = await read($, alerted)
        if (reached > last) {
          $.ui.toast(`컨텍스트 ${percent}% 사용됨`)
        }
        if (reached !== last) {
          await update($, alerted, () => reached)
        }
      }
    }
    return next(e)
  })

  // These sit in the path of every call and row: what they keep for the band is caught, so a slip
  // there never fails the call or the row.

  // A command the model runs may switch the branch: read it again once the command is done.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    await takeBranch($).catch(() => {})
    return result
  })

  // Background tasks: counted in when a main-loop call starts one, out when TaskStop ends one. The call
  // is watched while it runs, for the title's mark to tell one that waits on the person.
  on('tool.call', async ($, e, next) => {
    const result = await watchCall($, e as { tool: string; tool_use_id: string; agentId?: string }, () => next(e))
    if (result.result !== undefined && result.isError !== true && e.agentId === undefined) {
      const started = startedTask(e.tool, result.result)
      if (started !== undefined) {
        await startTask($, started).catch(() => {})
      }
      const stopped = e.tool === 'TaskStop' ? (result.result as { task_id?: unknown }).task_id : undefined
      if (typeof stopped === 'string') {
        await endTasks($, [stopped]).catch(() => {})
      }
    }
    if (e.tool === 'Agent' || e.tool === 'TaskStop') {
      await takeAgents($).catch(() => {})
    }
    return result
  })

  // ...and out when its notification says it ended.
  on('session.append', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const ended = endedTasks(e.message.content)
      if (ended.length > 0) {
        await endTasks($, ended).catch(() => {})
      }
      await takeAgents($).catch(() => {})
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    // A session opened without a fresh start (unarchived, resumed) may not have filled these yet.
    const stored = await read($, fill)
    const current = stored?.percent !== undefined ? stored : await estimate($)
    await read($, minute)
    // Drawing only reads: with no reading in this session yet, the stored one is shown as is.
    const reading = (await read($, limits)) ?? (await storedLimits($))

    const parts: Part[] = []
    if (current !== null && current.percent !== undefined) {
      parts.push({
        name: '컨텍스트',
        percent: current.percent,
        text: `${current.percent}%`,
        detail: current.tokens === undefined ? '' : ` (${formatTokens(current.tokens)} / ${formatTokens(current.window)})`,
        detailRank: 1,
      })
    }
    parts.push(...limitParts(reading?.list ?? [], await $.clock.now()))
    // Checked here when the session opened without a fresh start.
    const branchName = shortBranch(((await read($, branch)) ?? (await currentBranch($))).name)
    // Tags after the figures, never given up: the branch, and how many background tasks run.
    const tags = [...(branchName === null ? [] : [branchName]), `bg (${await runningTasks($)})`]

    // One row, side by side: the band is wide and short; a faint divider stands between items
    // so they read as separate figures. VS Code's panel draws Svg too, so it takes the same band.
    if (e.surface === 'desktop' || e.surface === 'vscode') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      // The row never wraps: as the window narrows the band picks the fullest form in FITS that fits.
      const fit = fitFor(parts, tags, e.props.bodyColumns, METRICS[e.surface])
      return (
        <Box flexDirection="row" alignItems="center" flexWrap="nowrap" columnGap="xs" overflow="hidden">
          {parts.flatMap((part, index) => [
            ...(index === 0 ? [] : [<Text key={`divider-${part.name}`} size="body" dimColor>│</Text>]),
            // A small inset before 컨텍스트 alone, off the band's left edge.
            <Box key={part.name} flexDirection="row" alignItems="center" gap="sm" {...(index === 0 ? { marginLeft: 0.25 } : {})}>
              {fit.showsNames ? <Text size="body" dimColor>{part.name}</Text> : null}
              {fit.barWidth === 0 ? null : (
                <Svg source={barSvg(part.percent, levelOf(part.percent), fit.barWidth)} alt={`${part.name} ${part.text}${USE}${part.detail}`} width={fit.barWidth} height={BAR_HEIGHT} />
              )}
              <Text size="body" dimColor>{part.text}{fit.showsUse ? USE : ''}{part.detailRank > fit.detailsDropped ? part.detail : ''}</Text>
            </Box>,
          ])}
          {/* Each tag wraps with its divider, so no divider is left at a row's end. */}
          {tags.map((tag, index) => (
            <Box key={`tag-${index}`} flexDirection="row" alignItems="center" columnGap="xs">
              {parts.length === 0 && index === 0 ? null : <Text size="body" dimColor>│</Text>}
              <Text size="body" dimColor>{tag}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {parts.flatMap((part, index) => {
          const filled = Math.min(BAR_CELLS, Math.round((part.percent / 100) * BAR_CELLS))
          const bar = '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
          const level = levelOf(part.percent)
          return [
            ...(index === 0 ? [] : [<Text key={`divider-${part.name}`} dimColor>│</Text>]),
            <Text key={part.name}>
              <Text dimColor>{part.name}</Text> <Text color={level === 'normal' ? 'subtle' : level}>{bar}</Text> <Text dimColor>{part.text}{USE}{part.detail}</Text>
            </Text>,
          ]
        })}
        {tags.flatMap((tag, index) => [
          ...(parts.length === 0 && index === 0 ? [] : [<Text key={`divider-tag-${index}`} dimColor>│</Text>]),
          <Text key={`tag-${index}`} dimColor>{tag}</Text>,
        ])}
      </Box>
    )
  })

  // In the desktop app, what the session is doing, marked at the front of its title in the sidebar.
  registerSessions(on)
}
