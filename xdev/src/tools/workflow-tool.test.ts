import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkflowTool } from './workflow-tool'
import { resetWorkflowRuntime } from './workflow-runtime'

const tempDirs: string[] = []

describe('workflow-tool', () => {
  afterEach(async () => {
    await resetWorkflowRuntime()
    delete process.env.XDEV_HOME
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  it('creates and lists workflows', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-workflow-home-'))
    tempDirs.push(home)
    process.env.XDEV_HOME = home

    const tool = createWorkflowTool()
    const created = await tool.execute({
      action: 'create',
      title: 'Refactor feature',
      description: 'Multi-step workflow',
      stages: [
        { id: 'plan', name: 'Plan', passCriteria: [{ id: 'approved', description: 'plan approved' }] },
        { id: 'impl', name: 'Implement' },
      ],
    }, { workDir: '/repo' })

    expect(created.success).toBe(true)
    expect(created.output).toContain('工作流已创建')

    const listed = await tool.execute({ action: 'list' }, { workDir: '/repo' })
    expect(listed.success).toBe(true)
    expect(listed.output).toContain('Refactor feature')
  })

  it('supports criterion updates and stage completion', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-workflow-home-'))
    tempDirs.push(home)
    process.env.XDEV_HOME = home

    const tool = createWorkflowTool()
    const created = await tool.execute({
      action: 'create',
      title: 'Release',
      stages: [
        { id: 'plan', name: 'Plan', passCriteria: [{ id: 'approved', description: 'plan approved' }] },
      ],
    }, { workDir: '/repo' })
    expect(created.success).toBe(true)
    const workflowId = created.output?.match(/工作流已创建: ([a-z0-9-]+)/)?.[1]
    expect(workflowId).toBeTruthy()

    const started = await tool.execute({ action: 'start', id: workflowId }, { workDir: '/repo' })
    expect(started.success).toBe(true)

    const criterion = await tool.execute({
      action: 'criterion',
      id: workflowId,
      stageId: 'plan',
      criterionId: 'approved',
      status: 'passed',
      summary: 'review passed',
    }, { workDir: '/repo' })
    expect(criterion.success).toBe(true)

    const completed = await tool.execute({
      action: 'complete_stage',
      id: workflowId,
      stageId: 'plan',
      summary: 'Planning complete',
    }, { workDir: '/repo' })
    expect(completed.success).toBe(true)
    expect(completed.output).toContain('completed')
  })
})
