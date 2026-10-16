import { test, expect, mock } from 'claude-code/testing'

const NOW = Date.parse('2026-10-16T01:00:00Z')

test('shows context fill in the band above the prompt on terminal and desktop', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { tokens: 84000, window: 200000, percent: 42 }, rateLimits: [], changed: ['context'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-band', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 } } as any })
    expect(await ui.find({ type: 'Text', text: /42% 사용 \(84k \/ 200k\)/ })).toBeDefined()
    await ui.unmount()
  }
})

test('toasts once when crossing 75% and 90%, again after dropping back', async ($, on) => {
  mock.store(on)
  const toasts: string[] = []
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  const measure = (percent: number) =>
    $.session.measure({ context: { tokens: percent * 2000, window: 200000, percent }, rateLimits: [], changed: ['context'] })
  for (const p of [50, 76, 80, 91, 95, 20, 77]) await measure(p)
  expect(toasts).toEqual(['컨텍스트 76% 사용됨', '컨텍스트 91% 사용됨', '컨텍스트 77% 사용됨'])
})

test('adds the session and weekly limits with their reset countdowns', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const now = NOW
  const at = (ms: number) => new Date(now + ms).toISOString()
  await $.session.measure({
    context: { tokens: 294000, window: 1000000, percent: 29 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 22, resetsAt: at((2 * 24 * 60 + 5 * 60 + 10) * 60000 + 30000) },
      { kind: 'five_hour', percentUsed: 5, resetsAt: at((4 * 60 + 23) * 60000 + 30000) },
    ],
    changed: ['context', 'rateLimits'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-band', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 } } as any })
    expect(await ui.find({ type: 'Text', text: /29% 사용 \(294k \/ 1000k\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5% 사용 \(4시간 23분 후 재설정\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /22% 사용 \(2일 5시간 후 재설정\)/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a session with no reading of its own shows the last one another session stored', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, { limits: { at: NOW - 60000, list: [
    { kind: 'five_hour', percentUsed: 41, resetsAt: new Date(NOW + 90 * 60000 + 30000).toISOString() },
    { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW - 60000).toISOString() },
  ] } })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { tokens: 20000, window: 200000, percent: 10 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 } } as any })
  expect(await ui.find({ type: 'Text', text: /41% 사용 \(1시간 30분 후 재설정\)/ })).toBeDefined()
  // The weekly window reset after that reading, so its stale figure is not shown.
  expect(await ui.find({ type: 'Text', text: /12% 사용/ })).toBeUndefined()
  await ui.unmount()
})
