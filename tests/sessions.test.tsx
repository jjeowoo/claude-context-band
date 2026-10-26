import { test, expect, mock } from 'claude-code/testing'

const NOW = Date.parse('2026-10-26T10:00:00Z')
const MIN = 60_000

const RECORDS = 'C:/Users/u/AppData/Roaming/Claude/claude-code-sessions/acc/org'
const RECORD = `${RECORDS}/local_self.json`
const DESKTOP_ENV = {
  CLAUDE_CODE_HOST_SESSION_ID: 'local_self',
  CLAUDE_CODE_ACCOUNT_UUID: 'acc',
  CLAUDE_CODE_ORGANIZATION_UUID: 'org',
  APPDATA: String.raw`C:\Users\u\AppData\Roaming`,
  USERPROFILE: String.raw`C:\Users\u`,
}
const RENAME_TOOL = 'mcp__ccd_session_mgmt__set_session_title'

type Disk = Map<string, { text: string; mtimeMs: number }>

// A disk of the given files, which the plugin's own writes land on too.
function mockDisk(on: any, clock: { now: () => number }, files: Record<string, unknown>): Disk {
  const disk: Disk = new Map(Object.entries(files).map(([path, data]) => [path, { text: JSON.stringify(data), mtimeMs: clock.now() }]))
  const norm = (path: string) => path.replace(/\\/g, '/')
  const missing = (path: string) => { throw new Error(`ENOENT: ${path}`) }
  on('fs.stat', (_$: unknown, e: { path: string }) => {
    const file = disk.get(norm(e.path)) ?? missing(e.path)
    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.list', (_$: unknown, e: { path: string }) => {
    const dir = `${norm(e.path)}/`
    const names = [...disk.keys()].filter(path => path.startsWith(dir) && !path.slice(dir.length).includes('/'))
    if (names.length === 0) missing(e.path)
    return { value: names.map(path => ({ name: path.slice(dir.length), kind: 'file', size: disk.get(path)!.text.length, mtimeMs: disk.get(path)!.mtimeMs, isLink: false })) }
  })
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: (disk.get(norm(e.path)) ?? missing(e.path)).text }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    disk.set(norm(e.path), { text: e.text, mtimeMs: clock.now() })
    return { value: undefined }
  })
  return disk
}

function put(disk: Disk, clock: { now: () => number }, path: string, change: (data: any) => any) {
  const data = change(JSON.parse(disk.get(path)?.text ?? '{}'))
  disk.set(path, { text: JSON.stringify(data), mtimeMs: clock.now() })
}

// Whether the app has the session on screen, which a test turns on and off.
type Screen = { isShown: boolean }

// The engine of a desktop session whose app renames it as asked, and the titles asked for.
function startEngine(on: any, disk: Disk, clock: { now: () => number }, decision = 'allow', screen: Screen = { isShown: false }): string[] {
  const renames: string[] = []
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: screen.isShown ? ['desktop'] : [] }))
  on('session.repo', () => ({ value: null }))
  on('ui.panes', () => ({ value: [] }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.check', () => ({ decision }))
  on('tool.call', { tool: RENAME_TOOL }, (_$: unknown, e: { title: string }) => {
    renames.push(e.title)
    put(disk, clock, RECORD, data => ({ ...data, title: e.title }))
    return { result: { content: 'renamed' } }
  })
  return renames
}

const titleOf = (disk: Disk) => JSON.parse(disk.get(RECORD)!.text).title

test('marks its title working through a turn, done once it ends off screen, and plain once opened again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, DESKTOP_ENV)
  const disk = mockDisk(on, clock, { [RECORD]: { sessionId: 'local_self', title: '세션 패널', lastFocusedAt: NOW - MIN } })
  const screen = { isShown: false }
  const renames = startEngine(on, disk, clock, 'allow', screen)

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  // Nothing has run yet: the title stays as the app named it.
  expect(renames).toEqual([])

  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.settle()
  expect(titleOf(disk)).toBe('🔵 세션 패널')

  await clock.advance(MIN)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(titleOf(disk)).toBe('✅ 세션 패널')

  // The person opens the session: the app attaches it, and the mark comes off at the next look.
  await clock.advance(MIN)
  screen.isShown = true
  await clock.advance(5000)
  expect(renames).toEqual(['🔵 세션 패널', '✅ 세션 패널', '세션 패널'])

  // ...and stays off once they move on to another session.
  screen.isShown = false
  await clock.advance(MIN)
  expect(titleOf(disk)).toBe('세션 패널')
})

test('a session on screen as its turn ends gets no done mark, then or after the person leaves it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, DESKTOP_ENV)
  // Opened long before: the app's own record says nothing of the person watching since.
  const disk = mockDisk(on, clock, { [RECORD]: { sessionId: 'local_self', title: '세션 패널', lastFocusedAt: NOW - 30 * MIN } })
  const screen = { isShown: true }
  const renames = startEngine(on, disk, clock, 'allow', screen)

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(MIN)
  await $.turn.complete({ answer: 'done', durationMs: MIN, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(titleOf(disk)).toBe('세션 패널')

  screen.isShown = false
  await clock.advance(MIN)
  expect(renames).toEqual(['🔵 세션 패널', '세션 패널'])
})

test('marks its title 🏃 while a background task it started runs past its turn, done once the task ends', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, DESKTOP_ENV)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }))
  const disk = mockDisk(on, clock, { [RECORD]: { sessionId: 'local_self', title: '하네스 검증', lastFocusedAt: NOW - MIN } })
  startEngine(on, disk, clock)

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'tests', run_in_background: true } as any)
  await $.turn.complete({ answer: 'tests running', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(titleOf(disk)).toBe('🏃 하네스 검증')

  await $.session.append({
    message: { type: 'user', role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>' },
    door: 'notification',
    origin: { kind: 'task-notification' },
    uuid: 'row-b1',
  } as any)
  await clock.advance(5000)
  expect(titleOf(disk)).toBe('✅ 하네스 검증')
})

// A tool call the test holds open until it lets it go.
function held() {
  let release = () => {}
  const until = new Promise<void>(resolve => { release = resolve })
  return { until, release }
}

// A desktop session titled `title`, its record on a mocked disk.
async function desktopSession(on: any, clock: any, title: string) {
  mock.store(on)
  mock.env(on, DESKTOP_ENV)
  const disk = mockDisk(on, clock, { [RECORD]: { sessionId: 'local_self', title, lastFocusedAt: NOW - MIN } })
  startEngine(on, disk, clock)
  return disk
}

test('marks ❗ while the app holds one of its own tools for the person to confirm, not for one it answers at once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const card = held()
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__delete_session' }, async () => { await card.until; return { result: { content: 'deleted' } } })
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__list_sessions' }, () => ({ result: { content: '[]' } }))
  const disk = await desktopSession(on, clock, '세션 정리')

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__ccd_session_mgmt__list_sessions' } as any)
  await clock.advance(5000)
  expect(titleOf(disk)).toBe('🔵 세션 정리')

  const deleting = $.tool.call({ tool: 'mcp__ccd_session_mgmt__delete_session', session_id: 'local_x' } as any)
  await clock.advance(1000)
  expect(titleOf(disk)).toBe('🔵 세션 정리')
  await clock.advance(1500)
  expect(titleOf(disk)).toBe('❗ 세션 정리')

  card.release()
  await deleting
  await clock.settle()
  expect(titleOf(disk)).toBe('🔵 세션 정리')
})

test('marks ❗ from the start of a question to the person until it is answered', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const answer = held()
  on('tool.call', { tool: 'AskUserQuestion' }, async () => { await answer.until; return { result: { answers: {} } } })
  const disk = await desktopSession(on, clock, '설계 질문')

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const asking = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
  await clock.settle()
  expect(titleOf(disk)).toBe('❗ 설계 질문')

  answer.release()
  await asking
  await clock.settle()
  expect(titleOf(disk)).toBe('🔵 설계 질문')
})

test('marks ❗ while a permission dialog is put to the person for a running call', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const dialog = held()
  on('tool.call', { tool: 'Bash' }, async () => { await dialog.until; return { result: { stdout: '', stderr: '', interrupted: false } } })
  const disk = await desktopSession(on, clock, '빌드 정리')

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const running = $.tool.call({ tool: 'Bash', command: 'rm -rf build', description: 'clean' } as any)
  await clock.settle()
  expect(titleOf(disk)).toBe('🔵 빌드 정리')

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }).catch(() => {})
  await clock.settle()
  expect(titleOf(disk)).toBe('❗ 빌드 정리')

  dialog.release()
  await running
  await clock.settle()
  expect(titleOf(disk)).toBe('🔵 빌드 정리')
})

// Marks earlier versions left, one the app gave an emoji variation selector, and one of this version's.
for (const left of ['◐ 세션 패널', '! 세션 패널', '✅️ 세션 패널', '❗ 세션 패널', '🟢 세션 패널', '⏳ 세션 패널']) {
  test(`swaps the mark on "${left}" rather than adding another`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    mock.env(on, DESKTOP_ENV)
    const disk = mockDisk(on, clock, { [RECORD]: { sessionId: 'local_self', title: left, lastFocusedAt: NOW - MIN } })
    startEngine(on, disk, clock)
    await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.settle()
    expect(titleOf(disk)).toBe('🔵 세션 패널')
  })
}

test('renames nothing unless a permission rule allows the rename outright', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, DESKTOP_ENV)
  const disk = mockDisk(on, clock, { [RECORD]: { sessionId: 'local_self', title: '세션 패널', lastFocusedAt: NOW - MIN } })
  const renames = startEngine(on, disk, clock, 'ask')

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(5000)
  expect(renames).toEqual([])
})

test('writes nothing outside a desktop session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, {})
  const disk = mockDisk(on, clock, {})
  const renames = startEngine(on, disk, clock)
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(5000)
  expect(disk.size).toBe(0)
  expect(renames).toEqual([])
})
