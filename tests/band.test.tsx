import { test, expect, mock } from 'claude-code/testing'

const NOW = Date.parse('2026-10-16T01:00:00Z')

test('shows context fill in the band above the prompt on terminal and desktop', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { tokens: 84000, window: 200000, percent: 42 }, rateLimits: [], changed: ['context'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-band', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 9 } } as any })
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
      // Friday 03:00 in the machine's own time zone, a week on: shown as a time, not a countdown.
      { kind: 'seven_day', percentUsed: 22, resetsAt: new Date(2026, 9, 23, 3, 0).toISOString() },
      { kind: 'five_hour', percentUsed: 5, resetsAt: at((4 * 60 + 23) * 60000 + 30000) },
    ],
    changed: ['context', 'rateLimits'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-band', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 9 } } as any })
    expect(await ui.find({ type: 'Text', text: /29% 사용 \(294k \/ 1000k\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5% 사용 \(4시간 23분 후 재설정\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /22% 사용 \(금요일 03:00 재설정\)/ })).toBeDefined()
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
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 9 } } as any })
  expect(await ui.find({ type: 'Text', text: /41% 사용 \(1시간 30분 후 재설정\)/ })).toBeDefined()
  // The weekly window reset after that reading, so its stale figure is not shown.
  expect(await ui.find({ type: 'Text', text: /12% 사용/ })).toBeUndefined()
  await ui.unmount()
})

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 9 } } as any

// A working copy laid out as `files` says: a path names a folder (`dir`) or a file's text.
function mockCheckout(on: any, root: string, files: Record<string, string>) {
  on('session.repo', () => ({ value: { root: 'C:/repo', remote: null, internal: false, name: null } }))
  on('session.root', () => ({ value: root }))
  // The engine hands paths on with backslashes; a missing one falls to the kit's bottom hook, which throws.
  const at = (path: string) => files[path.replace(/\\/g, '/')]
  on('fs.stat', (_$: unknown, e: { path: string }, next: (e: unknown) => unknown) => {
    const entry = at(e.path)
    if (entry === undefined) return next(e)
    return { value: { kind: entry === 'dir' ? 'dir' : 'file', size: entry.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$: unknown, e: { path: string }, next: (e: unknown) => unknown) => {
    const entry = at(e.path)
    if (entry === undefined || entry === 'dir') return next(e)
    return { value: entry }
  })
}

test('ends the band with worktree, not its branch, in a worktree session', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  mockCheckout(on, String.raw`C:\repo\.claude\worktrees\abc`, {
    'C:/repo/.claude/worktrees/abc/.git': 'gitdir: C:/repo/.git/worktrees/abc\n',
    'C:/repo/.git/worktrees/abc/HEAD': 'ref: refs/heads/claude/fix-band\n',
  })
  await $.session.measure({ context: { tokens: 20000, window: 200000, percent: 10 }, rateLimits: [], changed: ['context'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-band', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: 'worktree' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /fix-band/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('finds the branch from a folder inside the main checkout', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  mockCheckout(on, 'C:/repo/sub/', { 'C:/repo/.git': 'dir', 'C:/repo/.git/HEAD': 'ref: refs/heads/main\n' })
  await $.session.measure({ context: { tokens: 20000, window: 200000, percent: 10 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: 'main' })).toBeDefined()
  await ui.unmount()
})

test('cuts a long branch name with an ellipsis so the band stays one row', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  mockCheckout(on, 'C:/repo', { 'C:/repo/.git': 'dir', 'C:/repo/.git/HEAD': 'ref: refs/heads/feature/deep-seawater-public-acceptance\n' })
  await $.session.measure({ context: { tokens: 20000, window: 200000, percent: 10 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: 'feature/deep-seawater-p…' })).toBeDefined()
  await ui.unmount()
})

test('shows a detached HEAD as its short commit', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  mockCheckout(on, 'C:/repo', { 'C:/repo/.git': 'dir', 'C:/repo/.git/HEAD': '6209fb2a1c0d9e8f7b6a5c4d3e2f1a0b9c8d7e6f\n' })
  await $.session.measure({ context: { tokens: 20000, window: 200000, percent: 10 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: '6209fb2' })).toBeDefined()
  await ui.unmount()
})

test('shows no branch outside git', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.repo', () => ({ value: null }))
  await $.session.measure({ context: { tokens: 20000, window: 200000, percent: 10 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  // The background count alone follows the context fill.
  expect(await ui.find({ type: 'Text', text: 'bg (0)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'main' })).toBeUndefined()
  await ui.unmount()
})

test('a narrow desktop band gives up one thing at a time, down to the percents and the tags', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  mockCheckout(on, 'C:/repo', { 'C:/repo/.git': 'dir', 'C:/repo/.git/HEAD': 'ref: refs/heads/main\n' })
  await $.session.measure({
    context: { tokens: 221000, window: 1000000, percent: 22 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 9, resetsAt: new Date(NOW + (2 * 60 + 37) * 60000 + 30000).toISOString() },
      { kind: 'seven_day', percentUsed: 42, resetsAt: new Date(2026, 9, 23, 3, 0).toISOString() },
    ],
    changed: ['context', 'rateLimits'],
  })
  const mount = (bodyColumns: number) =>
    $.ui.mount({ plugin: 'context-band', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns } })

  const wide = await mount(200)
  expect(await wide.find({ type: 'Text', text: /^22% 사용 \(221k \/ 1000k\)$/ })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /^9% 사용 \(2시간 37분 후 재설정\)$/ })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: 'main' })).toBeDefined()
  await wide.unmount()

  // One step in: the context's token counts go first, the rest stays.
  const middle = await mount(130)
  expect(await middle.find({ type: 'Text', text: /^22% 사용$/ })).toBeDefined()
  expect(await middle.find({ type: 'Text', text: /^9% 사용 \(2시간 37분 후 재설정\)$/ })).toBeDefined()
  expect(await middle.find({ type: 'Text', text: /^42% 사용 \(금요일 03:00 재설정\)$/ })).toBeDefined()
  await middle.unmount()

  // Tighter: the weekly reset goes next; the session's countdown, needed soonest, stays, bars whole.
  const tighter = await mount(110)
  expect(await tighter.find({ type: 'Text', text: /^42% 사용$/ })).toBeDefined()
  expect(await tighter.find({ type: 'Text', text: /^9% 사용 \(2시간 37분 후 재설정\)$/ })).toBeDefined()
  expect(await tighter.find({ type: 'Svg', props: { width: 37 } })).toBeDefined()
  expect(await tighter.find({ type: 'Text', text: 'main' })).toBeDefined()
  await tighter.unmount()

  // Tighter still: the word 사용 goes before the countdown, the bars or the branch do.
  const terse = await mount(95)
  expect(await terse.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
  expect(await terse.find({ type: 'Text', text: /^9% \(2시간 37분 후 재설정\)$/ })).toBeDefined()
  expect(await terse.find({ type: 'Svg', props: { width: 37 } })).toBeDefined()
  expect(await terse.find({ type: 'Text', text: 'main' })).toBeDefined()
  await terse.unmount()

  // Narrow: the bars are gone before the names.
  const narrow = await mount(55)
  expect(await narrow.find({ type: 'Text', text: '세션' })).toBeDefined()
  expect(await narrow.find({ type: 'Svg' })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: 'main' })).toBeDefined()
  await narrow.unmount()

  // The least a band shows: "22% │ 9% │ 42% │ main │ bg (0)".
  const least = await mount(30)
  expect(await least.find({ type: 'Text', text: '세션' })).toBeUndefined()
  for (const percent of ['22%', '9%', '42%', 'main', 'bg (0)']) {
    expect(await least.find({ type: 'Text', text: percent })).toBeDefined()
  }
  await least.unmount()
})

test('VS Code draws the desktop band: rounded bars on one row, narrowing the same way', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  mockCheckout(on, 'C:/repo', { 'C:/repo/.git': 'dir', 'C:/repo/.git/HEAD': 'ref: refs/heads/main\n' })
  await $.session.measure({
    context: { tokens: 38000, window: 1000000, percent: 4 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 27, resetsAt: new Date(2026, 9, 23, 3, 0).toISOString() }],
    changed: ['context', 'rateLimits'],
  })
  const mount = (bodyColumns: number) =>
    $.ui.mount({ plugin: 'context-band', surface: 'vscode', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns } })

  const wide = await mount(200)
  expect(await wide.find({ type: 'Svg', props: { width: 37 } })).toBeDefined()
  expect(await wide.find({ type: 'Box', props: { flexWrap: 'nowrap' } })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /^4% 사용 \(38k \/ 1000k\)$/ })).toBeDefined()
  await wide.unmount()

  // 39 columns is what a ~540px panel reports: one of its columns is a full-width `─`, so the band
  // keeps its names, bars and 사용 there, giving up only the details.
  const panel = await mount(39)
  expect(await panel.find({ type: 'Text', text: '컨텍스트' })).toBeDefined()
  expect(await panel.find({ type: 'Svg', props: { width: 37 } })).toBeDefined()
  expect(await panel.find({ type: 'Text', text: /^4% 사용$/ })).toBeDefined()
  expect(await panel.find({ type: 'Text', text: /^27% 사용$/ })).toBeDefined()
  await panel.unmount()

  const narrow = await mount(15)
  expect(await narrow.find({ type: 'Text', text: '컨텍스트' })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: 'main' })).toBeDefined()
  await narrow.unmount()
})

test('counts background tasks in as they start and out as their notifications end them', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.repo', () => ({ value: null }))
  on('tool.call', (_$, e: any) => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: e.description } }))
  await $.session.measure({ context: { tokens: 20000, window: 200000, percent: 10 }, rateLimits: [], changed: ['context'] })
  const band = async (surface: 'terminal' | 'desktop', expected: string) => {
    const ui = await $.ui.mount({ plugin: 'context-band', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: expected })).toBeDefined()
    await ui.unmount()
  }

  await band('desktop', 'bg (0)')
  for (const id of ['b1', 'b2']) {
    await $.tool.call({ tool: 'Bash', command: 'sleep 60', description: id, run_in_background: true } as any)
  }
  await band('desktop', 'bg (2)')
  await band('terminal', 'bg (2)')

  const notify = (text: string) => $.session.append({
    message: { type: 'user', role: 'user', content: text },
    door: 'notification',
    origin: { kind: 'task-notification' },
    uuid: `row-${text.length}`,
  } as any)
  // A monitor's event, no ending status: still running.
  await notify('<task-notification>\n<task-id>b2</task-id>\n<event>line</event>\n</task-notification>')
  await notify('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>')
  await band('desktop', 'bg (1)')
})

test('counts the main loop agents already at work, from the session record', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.repo', () => ({ value: null }))
  const agent = (id: string, status: string, parentId?: string) =>
    ({ id, description: id, type: 'general-purpose', status, ...(parentId === undefined ? {} : { parentId }) })
  on('agent.list', () => ({ value: [agent('a1', 'running'), agent('a2', 'completed'), agent('a3', 'running', 'a1')] }))
  await $.session.measure({ context: { tokens: 20000, window: 200000, percent: 10 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  // a1 only: a2 has ended, and a3 is a1's own, listed under it.
  expect(await ui.find({ type: 'Text', text: 'bg (1)' })).toBeDefined()
  await ui.unmount()
})
