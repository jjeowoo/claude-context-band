import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextFill, LimitsReading, RateLimit } from '../types'

const fill = atom({ plugin: 'context-band', key: 'fill' } as const, null as ContextFill | null)
const alerted = atom({ plugin: 'context-band', key: 'alerted' } as const, 0)
const limits = atom({ plugin: 'context-band', key: 'limits' } as const, null as LimitsReading | null)
// Bumped every minute so the reset countdowns redraw.
const minute = atom({ plugin: 'context-band', key: 'minute' } as const, 0)

// The limits are the account's, not the session's: the last reading any session got is kept
// across sessions, so a session that has had no response yet still shows them.
const STORE_KEY = 'limits'

const THRESHOLDS = [90, 75]
const BAR_CELLS = 10
const BAR_WIDTH = 64
const BAR_HEIGHT = 6
const FILL_COLORS = { normal: '#8b8f98', warning: '#d9922e', error: '#d9534f' }
const LIMIT_LABELS: Record<string, string> = { five_hour: '세션', seven_day: '주간', spend_limit: '지출' }
const LIMIT_ORDER = ['five_hour', 'seven_day', 'spend_limit']

type Level = keyof typeof FILL_COLORS
type Part = { name: string; percent: number; text: string }

function levelOf(percent: number): Level {
  return percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'normal'
}

function barSvg(percent: number, level: Level): string {
  const r = BAR_HEIGHT / 2
  const w = Math.max(0, Math.min(BAR_WIDTH, (percent / 100) * BAR_WIDTH))
  const fillRect = w === 0 ? '' : `<rect width="${Math.max(w, BAR_HEIGHT).toFixed(1)}" height="${BAR_HEIGHT}" rx="${r}" fill="${FILL_COLORS[level]}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="${BAR_HEIGHT}" viewBox="0 0 ${BAR_WIDTH} ${BAR_HEIGHT}"><rect width="${BAR_WIDTH}" height="${BAR_HEIGHT}" rx="${r}" fill="#8b8f98" fill-opacity="0.25"/>${fillRect}</svg>`
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
      text: `${Math.round(l.percentUsed)}% 사용` + (Number.isNaN(at) ? '' : untilText(at, now)),
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
    // Each minute: redraw the countdowns, and take a newer reading another session stored.
    $.clock.every(60_000, () => {
      void takeLimits($).then(() => update($, minute, n => n + 1))
    })
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
      const label = `${current.percent}% 사용` + (current.tokens === undefined ? '' : ` (${formatTokens(current.tokens)} / ${formatTokens(current.window)})`)
      parts.push({ name: '컨텍스트', percent: current.percent, text: label })
    }
    parts.push(...limitParts(reading?.list ?? [], await $.clock.now()))
    if (parts.length === 0) {
      return next(e)
    }

    // One row, side by side: the band is wide and short; a faint divider stands between items
    // so they read as separate figures.
    if (e.surface === 'desktop') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" alignItems="center" flexWrap="wrap" columnGap="sm">
          {parts.flatMap((part, index) => [
            ...(index === 0 ? [] : [<Text key={`divider-${part.name}`} size="footnote" dimColor>│</Text>]),
            // A small inset before 컨텍스트 alone, off the band's left edge.
            <Box key={part.name} flexDirection="row" alignItems="center" gap="sm" {...(index === 0 ? { marginLeft: 'xs' as const } : {})}>
              <Text size="footnote" dimColor>{part.name}</Text>
              <Svg source={barSvg(part.percent, levelOf(part.percent))} alt={`${part.name} ${part.text}`} width={BAR_WIDTH} height={BAR_HEIGHT} />
              <Text size="footnote" dimColor>{part.text}</Text>
            </Box>,
          ])}
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
              <Text dimColor>{part.name}</Text> <Text color={level === 'normal' ? 'subtle' : level}>{bar}</Text> <Text dimColor>{part.text}</Text>
            </Text>,
          ]
        })}
      </Box>
    )
  })
}
