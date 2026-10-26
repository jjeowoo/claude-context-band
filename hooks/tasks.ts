import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

// The session's background tasks: the band counts them at its end, and the sessions pane tells by them
// a session whose turn has ended but whose work goes on.

// Ids of the background commands, monitors and remote agents the main loop started and that
// have not ended; seen as they start, so ones started before the mod loaded are missing.
const background = atom({ plugin: 'context-band', key: 'background' } as const, [] as string[])
// Ids of the session's own agents still at work, read from its record of them, so ones started
// before the mod loaded count too; null until read.
const agents = atom({ plugin: 'context-band', key: 'agents' } as const, null as string[] | null)

const AT_WORK = ['pending', 'running', 'waiting']

// The main loop's agents still at work: what the background tasks pane lists at its top level.
async function liveAgents($: EngineInterface): Promise<string[]> {
  try {
    return (await $.agent.list()).filter(a => a.parentId === undefined && AT_WORK.includes(a.status)).map(a => a.id)
  } catch {
    return []
  }
}

export async function takeAgents($: EngineInterface): Promise<void> {
  const ids = await liveAgents($)
  const current = await read($, agents)
  if (current === null || current.join() !== ids.join()) {
    await update($, agents, () => ids)
  }
}

export async function startTask($: EngineInterface, id: string): Promise<void> {
  await update($, background, ids => (ids.includes(id) ? ids : [...ids, id]))
}

export async function endTasks($: EngineInterface, ended: string[]): Promise<void> {
  await update($, background, ids => ids.filter(id => !ended.includes(id)))
}

// How many background tasks run: the ones tool calls started and the agents at work, each once.
export async function runningTasks($: EngineInterface): Promise<number> {
  return new Set([...(await read($, background)), ...((await read($, agents)) ?? (await liveAgents($)))]).size
}
