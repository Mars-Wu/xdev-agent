import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowRuntime, resetWorkflowRuntime } from './workflow-runtime'

const tempDirs: string[] = []
const runtimes: WorkflowRuntime[] = []

async function createRuntime(): Promise<{ runtime: WorkflowRuntime; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-workflow-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, 'workflow-runs.json')
  const runtime = new WorkflowRuntime({ filePath, autoSaveInterval: 50 })
  await runtime.initialize()
  runtimes.push(runtime)
  return { runtime, filePath }
}

describe('WorkflowRuntime', () => {
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown()))
    await resetWorkflowRuntime()
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  it('creates, starts, checkpoints, and completes workflow stages with pass criteria', async () => {
    const { runtime } = await createRuntime()
    const workflow = runtime.createWorkflow('Publish release', 'Release pipeline', {
      stages: [
        {
          id: 'plan',
          name: 'Plan',
          passCriteria: ['design approved'],
        },
        {
          id: 'ship',
          name: 'Ship',
          passCriteria: ['tests green'],
        },
      ],
      workDir: '/repo',
    })

    const started = runtime.startWorkflow(workflow.id)
    expect(started?.status).toBe('active')
    expect(started?.currentStageId).toBe('plan')
    expect(started?.stages[0].status).toBe('in_progress')

    const checkpointed = runtime.checkpointWorkflow(workflow.id, 'Design reviewed', {
      stageId: 'plan',
      evidence: ['doc link'],
    })
    expect(checkpointed?.checkpoints[0].summary).toBe('Design reviewed')

    const criterionId = checkpointed?.stages[0].passCriteria[0].id as string
    runtime.updatePassCriterion(workflow.id, 'plan', criterionId, 'passed', 'approved by reviewer')
    const completedStage = runtime.completeStage(workflow.id, 'plan', { summary: 'Planning done' })

    expect(completedStage?.stages[0].status).toBe('completed')
    expect(completedStage?.currentStageId).toBe('ship')
    expect(completedStage?.stages[1].status).toBe('in_progress')
    expect(completedStage?.events.some(event => event.type === 'workflow_created')).toBe(true)
    expect(completedStage?.events.some(event => event.type === 'stage_completed')).toBe(true)
    expect(completedStage?.events.some(event => event.type === 'criterion_updated')).toBe(true)
  })

  it('persists workflows and supports pause/resume plus pivot history', async () => {
    const { runtime, filePath } = await createRuntime()
    const workflow = runtime.createWorkflow('Investigate bug', 'Bugfix workflow', {
      stages: [{ id: 'debug', name: 'Debug', passCriteria: ['root cause identified'] }],
      workDir: '/repo',
    })

    runtime.startWorkflow(workflow.id)
    runtime.recordPivot(workflow.id, 'debug', 'First hypothesis failed', {
      fromApproach: 'inspect logs',
      toApproach: 'trace state transitions',
    })
    runtime.pauseWorkflow(workflow.id)
    await runtime.save()
    await runtime.shutdown()

    const reloaded = new WorkflowRuntime({ filePath })
    await reloaded.initialize()
    const loaded = reloaded.getWorkflow(workflow.id)

    expect(loaded?.status).toBe('paused')
    expect(loaded?.stages[0].pivotHistory).toHaveLength(1)

    const resumed = reloaded.resumeWorkflow(workflow.id)
    expect(resumed?.status).toBe('active')
    expect(resumed?.currentStageId).toBe('debug')
  })
})
