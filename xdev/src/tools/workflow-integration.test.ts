import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskTool } from './task-tool'
import { createBackgroundTool } from './background-tool'
import { getWorkflowRuntime, resetWorkflowRuntime } from './workflow-runtime'
import { resetTaskSystem } from './task-system'
import { getBackgroundTaskManager, resetBackgroundTaskManager } from './background-tasks'

const tempDirs: string[] = []

async function createWorkflowHome(): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-workflow-integration-'))
  tempDirs.push(home)
  process.env.XDEV_HOME = home
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('workflow integration', () => {
  afterEach(async () => {
    resetTaskSystem()
    resetBackgroundTaskManager()
    await resetWorkflowRuntime()
    delete process.env.XDEV_HOME
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  it('links task lifecycle into workflow stages automatically', async () => {
    await createWorkflowHome()
    const runtime = getWorkflowRuntime()
    await runtime.initialize()

    const workflow = runtime.createWorkflow('Implement feature', 'Task-linked workflow', {
      stages: [{ id: 'impl', name: 'Implement' }],
      workDir: '/repo',
    })
    runtime.startWorkflow(workflow.id)

    const tool = createTaskTool()
    const created = await tool.execute({
      action: 'create',
      title: 'Write integration',
      workflowId: workflow.id,
      stageId: 'impl',
    })

    expect(created.success).toBe(true)
    const taskId = created.output?.match(/任务已创建: ([a-z0-9-]+)/)?.[1]
    expect(taskId).toBeTruthy()

    await tool.execute({ action: 'start', id: taskId })
    await tool.execute({ action: 'complete', id: taskId, result: 'done' })

    const updated = runtime.getWorkflow(workflow.id)
    expect(updated?.stages[0].taskIds).toContain(taskId)
    expect(updated?.events.some(event => event.type === 'task_attached' && event.taskId === taskId)).toBe(true)
    expect(
      updated?.events.some(
        event =>
          event.type === 'task_state_changed' &&
          event.taskId === taskId &&
          event.metadata?.state === 'completed',
      ),
    ).toBe(true)
  })

  it('links background task lifecycle into workflow stages automatically', async () => {
    await createWorkflowHome()
    const runtime = getWorkflowRuntime()
    await runtime.initialize()

    const workflow = runtime.createWorkflow('Run checks', 'Background-linked workflow', {
      stages: [{ id: 'verify', name: 'Verify' }],
      workDir: '/repo',
    })
    runtime.startWorkflow(workflow.id)

    const tool = createBackgroundTool()
    const started = await tool.execute({
      action: 'start',
      name: 'quick-check',
      command: 'true',
      workflowId: workflow.id,
      stageId: 'verify',
    })

    expect(started.success).toBe(true)
    const taskId = started.output?.match(/ID: ([a-z0-9-]+)/)?.[1]
    expect(taskId).toBeTruthy()

    await waitFor(() => getBackgroundTaskManager().getTask(taskId as string)?.status !== 'running')
    await waitFor(() =>
      Boolean(
        runtime
          .getWorkflow(workflow.id)
          ?.events.some(
            event =>
              event.type === 'background_task_state_changed' &&
              event.backgroundTaskId === taskId &&
              event.metadata?.state === 'completed',
          ),
      ),
    )

    const updated = runtime.getWorkflow(workflow.id)
    expect(updated?.stages[0].backgroundTaskIds).toContain(taskId)
    expect(
      updated?.events.some(
        event =>
          event.type === 'background_task_state_changed' &&
          event.backgroundTaskId === taskId &&
          event.metadata?.state === 'completed',
      ),
    ).toBe(true)
  })
})
