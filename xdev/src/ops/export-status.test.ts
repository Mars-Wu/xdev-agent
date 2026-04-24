import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportStatus } from './export-status'
import { TopicGraph } from '../storage/topic-graph'
import { TaskSystem } from '../tools/task-system'
import { MemoryManager } from '../memory/memory-manager'
import { MemoryType, MemoryScope } from '../memory/types'

const tempDirs: string[] = []

async function createProjectRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-export-project-'))
  tempDirs.push(root)
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'export-project', scripts: { build: 'tsc', test: 'vitest run' } }, null, 2),
    'utf-8',
  )
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const ok = true\n', 'utf-8')
  return root
}

describe('export-status', () => {
  afterEach(async () => {
    delete process.env.XDEV_HOME
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  it('exports codebase/topic/task/memory artifacts and reuses cached observability artifacts', async () => {
    const xdevHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-export-home-'))
    tempDirs.push(xdevHome)
    process.env.XDEV_HOME = xdevHome

    const projectRoot = await createProjectRoot()

    const topicGraph = new TopicGraph(path.join(xdevHome, 'topics', 'index.db'))
    topicGraph.init()
    topicGraph.getOrCreate('T_1', 'code_task')
    topicGraph.updateSummary('T_1', 'Investigating exports', ['export'])
    topicGraph.close()

    const taskSystem = new TaskSystem({ graphPath: path.join(xdevHome, 'tasks', 'task-graph.json') })
    await taskSystem.initialize()
    taskSystem.createTask('Export reports', '')
    await taskSystem.shutdown()

    const memoryManager = new MemoryManager()
    await memoryManager.initialize()
    await memoryManager.addMemory({
      content: 'Prefer export status for diagnostics',
      type: MemoryType.SEMANTIC,
      scope: MemoryScope.PRIVATE,
      category: 'preference',
      importance: 7,
      tags: ['export'],
      metadata: { confidence: 0.8 },
    })

    const first = await exportStatus({ projectPath: projectRoot })
    const second = await exportStatus({ projectPath: projectRoot })

    expect(first.topicGraph.cacheHit).toBe(false)
    expect(second.topicGraph.cacheHit).toBe(true)
    expect(second.taskGraph.cacheHit).toBe(true)
    expect(second.memory.cacheHit).toBe(true)

    await fs.access(first.topicGraph.jsonPath)
    await fs.access(first.taskGraph.markdownPath)
    await fs.access(first.memory.jsonPath)
  })
})
