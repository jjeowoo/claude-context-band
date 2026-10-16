import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextFill } from '../types'

const fill = atom({ plugin: 'context-band', key: 'fill' } as const, null as ContextFill | null)
const alerted = atom({ plugin: 'context-band', key: 'alerted' } as const, 0)

const THRESHOLDS = [90, 75]
const BAR_CELLS = 10
const BAR_WIDTH = 96
const BAR_HEIGHT = 6
const FILL_COLORS = { normal: '#8b8f98', warning: '#d9922e', error: '#d9534f' }

function barSvg(percent: number, level: keyof typeof FILL_COLORS): string {
  const r = BAR_HEIGHT / 2
  const w = Math.max(0, Math.min(BAR_WIDTH, (percent / 100) * BAR_WIDTH))
  const fillRect = w === 0 ? '' : `<rect width="${Math.max(w, BAR_HEIGHT).toFixed(1)}" height="${BAR_HEIGHT}" rx="${r}" fill="${FILL_COLORS[level]}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="${BAR_HEIGHT}" viewBox="0 0 ${BAR_WIDTH} ${BAR_HEIGHT}"><rect width="${BAR_WIDTH}" height="${BAR_HEIGHT}" rx="${r}" fill="#8b8f98" fill-opacity="0.25"/>${fillRect}</svg>`
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
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
    return result
  })

  on('session.measure', async ($, e, next) => {
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
    // A session opened without a fresh start (unarchived, resumed) may not have filled it yet.
    const stored = await read($, fill)
    const current = stored?.percent !== undefined ? stored : await estimate($)
    if (current === null || current.percent === undefined) {
      return next(e)
    }

    const percent = current.percent
    const level = percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'normal'
    const label = `${percent}% 사용` + (current.tokens === undefined ? '' : ` (${formatTokens(current.tokens)} / ${formatTokens(current.window)})`)

    if (e.surface === 'desktop') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Text size="footnote" dimColor>컨텍스트</Text>
          <Svg source={barSvg(percent, level)} alt={`컨텍스트 ${label}`} width={BAR_WIDTH} height={BAR_HEIGHT} />
          <Text size="footnote" dimColor>{label}</Text>
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    const filled = Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS))
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
    return (
      <Box>
        <Text dimColor>
          컨텍스트 <Text color={level === 'normal' ? 'subtle' : level}>{bar}</Text> {label}
        </Text>
      </Box>
    )
  })
}
