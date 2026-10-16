import { test, expect } from 'claude-code/testing'

test('shows context fill in the band above the prompt on terminal and desktop', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { tokens: 84000, window: 200000, percent: 42 }, rateLimits: [], changed: ['context'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-band', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 } } as any })
    expect(await ui.find({ type: 'Text', text: /42% 사용 \(84k \/ 200k\)/ })).toBeDefined()
    await ui.unmount()
  }
})

test('toasts once when crossing 75% and 90%, again after dropping back', async ($, on) => {
  const toasts: string[] = []
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  const measure = (percent: number) =>
    $.session.measure({ context: { tokens: percent * 2000, window: 200000, percent }, rateLimits: [], changed: ['context'] })
  for (const p of [50, 76, 80, 91, 95, 20, 77]) await measure(p)
  expect(toasts).toEqual(['컨텍스트 76% 사용됨', '컨텍스트 91% 사용됨', '컨텍스트 77% 사용됨'])
})
