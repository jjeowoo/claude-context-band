import { test, expect, mock } from 'claude-code/testing'

const NOW = Date.parse('2026-10-26T10:00:00Z')
const MIN = 60_000

const RECORDS = 'C:/Users/u/AppData/Roaming/Claude/claude-code-sessions/acc/org'
const STATUSES = 'C:/Users/u/.claude/context-band/sessions'
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

// The engine of a desktop session whose app renames it as asked, and the titles asked for.
function startEngine(on: any, disk: Disk, clock: { now: () => number }, decision = 'allow'): string[] {
  const renames: string[] = []
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
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

test('marks its title working through a turn, done once it ends, and plain once opened again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, DESKTOP_ENV)
  const disk = mockDisk(on, clock, { [RECORD]: { sessionId: 'local_self', title: '세션 패널', lastFocusedAt: NOW - MIN } })
  const renames = startEngine(on, disk, clock)

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  // Nothing has run yet: the title stays as the app named it.
  expect(renames).toEqual([])

  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.settle()
  expect(titleOf(disk)).toBe('● 세션 패널')
  // The others read its turn from its status.
  expect(JSON.parse(disk.get(`${STATUSES}/local_self.json`)!.text)).toMatchObject({ at: NOW, startedAt: NOW, isAsking: false, background: 0, parentId: null })

  await clock.advance(MIN)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(titleOf(disk)).toBe('✓ 세션 패널')

  // The person opens the session: the app records it, and the mark comes off at the next look.
  await clock.advance(MIN)
  put(disk, clock, RECORD, data => ({ ...data, lastFocusedAt: clock.now() }))
  await clock.advance(5000)
  expect(renames).toEqual(['● 세션 패널', '✓ 세션 패널', '세션 패널'])
})

test('marks its title ◐ while a side session it started is at work, done once that one ends', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, DESKTOP_ENV)
  const child = `${STATUSES}/local_child.json`
  const disk = mockDisk(on, clock, {
    [RECORD]: { sessionId: 'local_self', title: '하네스 검증', lastFocusedAt: NOW - MIN },
    [child]: { at: NOW, startedAt: NOW - MIN, endedAt: null, isAsking: false, background: 0, parentId: 'local_self' },
    // Another session's side session, at work too: not this one's.
    [`${STATUSES}/local_other.json`]: { at: NOW, startedAt: NOW - MIN, endedAt: null, isAsking: false, background: 0, parentId: 'local_x' },
  })
  startEngine(on, disk, clock)

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.settle()
  await $.turn.complete({ answer: 'started a side session', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(titleOf(disk)).toBe('◐ 하네스 검증')

  await clock.advance(5000)
  put(disk, clock, child, data => ({ ...data, at: clock.now(), startedAt: null, endedAt: clock.now() }))
  await clock.advance(5000)
  expect(titleOf(disk)).toBe('✓ 하네스 검증')
})

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
