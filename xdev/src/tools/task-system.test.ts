import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskSystem, renderTaskGraphAnalysisMarkdown } from './task-system'

const tempDirs: string[] = []
const systems: TaskSystem[] = []

async function createTaskSystem(): Promise<TaskSystem> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-task-system-'))
  tempDirs.push(dir)
  const system = new TaskSystem({ graphPath: path.join(dir, 'task-graph.json'), autoSaveInterval: 50 })
  await system.initialize()
  systems.push(system)
  return system
}

describe('TaskSystem analysis', () => {
  afterEach(async () => {
    await Promise.all(systems.splice(0).map(system => system.shutdown()))
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  it('builds critical path and blocked reasons', async () => {
    const system = await createTaskSystem()
    const plan = system.createTask('Plan', '')
    const build = system.createTask('Build', '', { dependencies: [plan.id] })
    const verify = system.createTask('Verify', '', { dependencies: [build.id] })

    const analysis = system.buildGraphAnalysis()
    const markdown = renderTaskGraphAnalysisMarkdown(analysis)

    expect(analysis.summary.total).toBe(3)
    expect(analysis.summary.blocked).toBe(2)
    expect(analysis.criticalPath).toEqual([plan.id, build.id, verify.id])
    expect(markdown).toContain('# Task Graph Report')
    expect(markdown).toContain(plan.id)
  })
})
