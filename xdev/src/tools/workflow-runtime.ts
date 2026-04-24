import * as fs from 'fs/promises'
import * as path from 'path'
import { PATHS } from '../config'
import { createLogger } from '../utils/logger'

const logger = createLogger('workflow-runtime')

export type WorkflowRunStatus = 'pending' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type WorkflowStageStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
export type WorkflowPassCriterionStatus = 'pending' | 'passed' | 'failed' | 'waived'
export type WorkflowEventType =
  | 'workflow_created'
  | 'workflow_started'
  | 'workflow_resumed'
  | 'workflow_paused'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'workflow_cancelled'
  | 'stage_started'
  | 'stage_completed'
  | 'checkpoint_created'
  | 'criterion_updated'
  | 'pivot_recorded'
  | 'task_attached'
  | 'task_state_changed'
  | 'background_task_attached'
  | 'background_task_state_changed'

export interface WorkflowPassCriterion {
  id: string
  description: string
  status: WorkflowPassCriterionStatus
  evidence?: string
  updatedAt?: number
}

export interface WorkflowPivot {
  id: string
  stageId: string
  reason: string
  fromApproach?: string
  toApproach?: string
  createdAt: number
}

export interface WorkflowCheckpoint {
  id: string
  stageId: string
  summary: string
  evidence: string[]
  metadata?: Record<string, unknown>
  createdAt: number
}

export interface WorkflowEvent {
  id: string
  type: WorkflowEventType
  workflowId: string
  stageId?: string
  taskId?: string
  backgroundTaskId?: string
  summary: string
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface WorkflowStage {
  id: string
  name: string
  description: string
  status: WorkflowStageStatus
  order: number
  passCriteria: WorkflowPassCriterion[]
  taskIds: string[]
  backgroundTaskIds: string[]
  pivotHistory: WorkflowPivot[]
  startedAt?: number
  completedAt?: number
  updatedAt: number
  lastCheckpointId?: string
  lastCheckpointAt?: number
}

export interface WorkflowRun {
  id: string
  title: string
  description: string
  status: WorkflowRunStatus
  stages: WorkflowStage[]
  currentStageId: string | null
  checkpoints: WorkflowCheckpoint[]
  events: WorkflowEvent[]
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  resumeToken: string
  workDir?: string
  tags: string[]
  metadata?: Record<string, unknown>
  failureReason?: string
}

export interface WorkflowRuntimeConfig {
  filePath: string
  autoSaveInterval: number
  maxWorkflows: number
}

export interface CreateWorkflowStageInput {
  id?: string
  name: string
  description?: string
  passCriteria?: Array<string | { id?: string; description: string }>
}

export interface CreateWorkflowOptions {
  stages: CreateWorkflowStageInput[]
  workDir?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

function getDefaultConfig(): WorkflowRuntimeConfig {
  return {
    filePath: path.join(PATHS.XDEV_HOME, 'workflows', 'workflow-runs.json'),
    autoSaveInterval: 10000,
    maxWorkflows: 100,
  }
}

export class WorkflowRuntime {
  private config: WorkflowRuntimeConfig
  private workflows: Map<string, WorkflowRun> = new Map()
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false
  private initialized = false

  constructor(config: Partial<WorkflowRuntimeConfig> = {}) {
    this.config = { ...getDefaultConfig(), ...config }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await fs.mkdir(path.dirname(this.config.filePath), { recursive: true })
    await this.load()
    this.startAutoSave()
    this.initialized = true
    logger.info(`工作流运行时已初始化，当前 ${this.workflows.size} 个工作流`)
  }

  createWorkflow(title: string, description: string, options: CreateWorkflowOptions): WorkflowRun {
    if (!title.trim()) {
      throw new Error('工作流标题不能为空')
    }
    if (!Array.isArray(options.stages) || options.stages.length === 0) {
      throw new Error('工作流至少需要一个阶段')
    }
    if (this.workflows.size >= this.config.maxWorkflows) {
      throw new Error(`工作流数量已达上限 (${this.config.maxWorkflows})`)
    }

    const now = Date.now()
    const workflowId = this.generateId('wf')
    const stages = options.stages.map((stage, index) => {
      const stageId = stage.id?.trim() || `stage-${index + 1}`
      const passCriteria = (stage.passCriteria || []).map((criterion, criterionIndex) => {
        if (typeof criterion === 'string') {
          return {
            id: `criterion-${criterionIndex + 1}`,
            description: criterion,
            status: 'pending' as WorkflowPassCriterionStatus,
          }
        }
        return {
          id: criterion.id?.trim() || `criterion-${criterionIndex + 1}`,
          description: criterion.description,
          status: 'pending' as WorkflowPassCriterionStatus,
        }
      })

      return {
        id: stageId,
        name: stage.name,
        description: stage.description || '',
        status: 'pending' as WorkflowStageStatus,
        order: index,
        passCriteria,
        taskIds: [],
        backgroundTaskIds: [],
        pivotHistory: [],
        updatedAt: now,
      }
    })

    assertUniqueIds(stages.map(stage => stage.id), '阶段')
    for (const stage of stages) {
      assertUniqueIds(stage.passCriteria.map(criterion => criterion.id), `阶段 ${stage.id} 的门禁`)
    }

    const workflow: WorkflowRun = {
      id: workflowId,
      title: title.trim(),
      description: description.trim(),
      status: 'pending',
      stages,
      currentStageId: stages[0]?.id || null,
      checkpoints: [],
      events: [],
      createdAt: now,
      updatedAt: now,
      resumeToken: this.generateResumeToken(),
      workDir: options.workDir,
      tags: options.tags || [],
      metadata: options.metadata,
    }

    this.workflows.set(workflow.id, workflow)
    this.recordEvent(workflow, {
      type: 'workflow_created',
      summary: `创建工作流：${workflow.title}`,
    })
    this.markDirty()
    logger.info(`创建工作流: ${workflow.id} - ${workflow.title}`)
    return cloneWorkflow(workflow)
  }

  startWorkflow(id: string): WorkflowRun | null {
    const workflow = this.workflows.get(id)
    if (!workflow) return null
    if (isTerminalStatus(workflow.status)) {
      throw new Error(`工作流已结束，无法启动: ${workflow.status}`)
    }

    const now = Date.now()
    const stage = this.getCurrentOrNextStage(workflow)
    if (!stage) {
      workflow.status = 'completed'
      workflow.completedAt = now
      workflow.updatedAt = now
      this.markDirty()
      return cloneWorkflow(workflow)
    }

    const previousStatus = workflow.status
    workflow.status = 'active'
    workflow.startedAt = workflow.startedAt || now
    workflow.updatedAt = now
    workflow.currentStageId = stage.id
    if (stage.status === 'pending') {
      stage.status = 'in_progress'
      stage.startedAt = stage.startedAt || now
      stage.updatedAt = now
      this.recordEvent(workflow, {
        type: 'stage_started',
        stageId: stage.id,
        summary: `阶段开始：${stage.name}`,
      })
    }

    workflow.resumeToken = this.generateResumeToken()
    this.recordEvent(workflow, {
      type: previousStatus === 'paused' ? 'workflow_resumed' : 'workflow_started',
      stageId: stage.id,
      summary:
        previousStatus === 'paused'
          ? `恢复工作流：${workflow.title}`
          : `启动工作流：${workflow.title}`,
    })
    this.markDirty()
    return cloneWorkflow(workflow)
  }

  pauseWorkflow(id: string): WorkflowRun | null {
    const workflow = this.workflows.get(id)
    if (!workflow) return null
    if (workflow.status !== 'active') {
      throw new Error(`只有 active 工作流才能暂停，当前状态: ${workflow.status}`)
    }

    workflow.status = 'paused'
    workflow.updatedAt = Date.now()
    workflow.resumeToken = this.generateResumeToken()
    this.recordEvent(workflow, {
      type: 'workflow_paused',
      stageId: workflow.currentStageId || undefined,
      summary: `暂停工作流：${workflow.title}`,
    })
    this.markDirty()
    return cloneWorkflow(workflow)
  }

  resumeWorkflow(id: string): WorkflowRun | null {
    const workflow = this.workflows.get(id)
    if (!workflow) return null
    if (workflow.status !== 'paused' && workflow.status !== 'pending') {
      throw new Error(`当前状态不可恢复: ${workflow.status}`)
    }
    return this.startWorkflow(id)
  }

  failWorkflow(id: string, reason: string): WorkflowRun | null {
    const workflow = this.workflows.get(id)
    if (!workflow) return null

    const currentStage = workflow.currentStageId
      ? workflow.stages.find(stage => stage.id === workflow.currentStageId)
      : undefined
    if (currentStage && currentStage.status === 'in_progress') {
      currentStage.status = 'failed'
      currentStage.updatedAt = Date.now()
    }

    workflow.status = 'failed'
    workflow.failureReason = reason
    workflow.completedAt = Date.now()
    workflow.updatedAt = workflow.completedAt
    workflow.resumeToken = this.generateResumeToken()
    this.recordEvent(workflow, {
      type: 'workflow_failed',
      stageId: workflow.currentStageId || undefined,
      summary: `工作流失败：${reason}`,
      metadata: { reason },
    })
    this.markDirty()
    return cloneWorkflow(workflow)
  }

  cancelWorkflow(id: string): WorkflowRun | null {
    const workflow = this.workflows.get(id)
    if (!workflow) return null

    workflow.status = 'cancelled'
    workflow.completedAt = Date.now()
    workflow.updatedAt = workflow.completedAt
    workflow.resumeToken = this.generateResumeToken()
    this.recordEvent(workflow, {
      type: 'workflow_cancelled',
      stageId: workflow.currentStageId || undefined,
      summary: `取消工作流：${workflow.title}`,
    })
    this.markDirty()
    return cloneWorkflow(workflow)
  }

  checkpointWorkflow(
    id: string,
    summary: string,
    options: { stageId?: string; evidence?: string[]; metadata?: Record<string, unknown> } = {},
  ): WorkflowRun | null {
    const workflow = this.workflows.get(id)
    if (!workflow) return null
    const stage = this.resolveStage(workflow, options.stageId || workflow.currentStageId)
    if (!stage) {
      throw new Error('无法为不存在的阶段创建检查点')
    }

    const checkpoint: WorkflowCheckpoint = {
      id: this.generateId('checkpoint'),
      stageId: stage.id,
      summary,
      evidence: options.evidence || [],
      metadata: options.metadata,
      createdAt: Date.now(),
    }

    workflow.checkpoints.unshift(checkpoint)
    workflow.updatedAt = checkpoint.createdAt
    workflow.resumeToken = this.generateResumeToken()
    stage.lastCheckpointId = checkpoint.id
    stage.lastCheckpointAt = checkpoint.createdAt
    stage.updatedAt = checkpoint.createdAt
    this.recordEvent(workflow, {
      type: 'checkpoint_created',
      stageId: stage.id,
      summary,
      metadata: {
        checkpointId: checkpoint.id,
        evidenceCount: checkpoint.evidence.length,
      },
    })
    this.markDirty()
    return cloneWorkflow(workflow)
  }

  updatePassCriterion(
    workflowId: string,
    stageId: string,
    criterionId: string,
    status: WorkflowPassCriterionStatus,
    evidence?: string,
  ): WorkflowRun | null {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) return null
    const stage = this.resolveStage(workflow, stageId)
    if (!stage) {
      throw new Error(`阶段不存在: ${stageId}`)
    }
    const criterion = stage.passCriteria.find(item => item.id === criterionId)
    if (!criterion) {
      throw new Error(`门禁不存在: ${criterionId}`)
    }

    criterion.status = status
    criterion.evidence = evidence
    criterion.updatedAt = Date.now()
    stage.updatedAt = criterion.updatedAt
    workflow.updatedAt = criterion.updatedAt
    workflow.resumeToken = this.generateResumeToken()
    this.recordEvent(workflow, {
      type: 'criterion_updated',
      stageId,
      summary: `门禁更新：${criterion.description} -> ${status}`,
      metadata: {
        criterionId,
        status,
        evidence,
      },
    })
    this.markDirty()
    return cloneWorkflow(workflow)
  }

  completeStage(
    workflowId: string,
    stageId: string,
    options: { summary?: string; evidence?: string[] } = {},
  ): WorkflowRun | null {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) return null
    const stage = this.resolveStage(workflow, stageId)
    if (!stage) {
      throw new Error(`阶段不存在: ${stageId}`)
    }
    if (!this.canCompleteStage(stage)) {
      throw new Error(`阶段 ${stageId} 仍有未通过的门禁`)
    }

    const now = Date.now()
    stage.status = 'completed'
    stage.completedAt = now
    stage.updatedAt = now
    workflow.updatedAt = now
    workflow.resumeToken = this.generateResumeToken()
    this.recordEvent(workflow, {
      type: 'stage_completed',
      stageId: stage.id,
      summary: `阶段完成：${stage.name}`,
    })

    if (options.summary) {
      const checkpoint: WorkflowCheckpoint = {
        id: this.generateId('checkpoint'),
        stageId: stage.id,
        summary: options.summary,
        evidence: options.evidence || [],
        createdAt: now,
      }
      workflow.checkpoints.unshift(checkpoint)
      stage.lastCheckpointId = checkpoint.id
      stage.lastCheckpointAt = checkpoint.createdAt
    }

    const nextStage = workflow.stages
      .filter(candidate => candidate.order > stage.order && candidate.status === 'pending')
      .sort((a, b) => a.order - b.order)[0]

    if (!nextStage) {
      workflow.status = 'completed'
      workflow.currentStageId = null
      workflow.completedAt = now
      this.recordEvent(workflow, {
        type: 'workflow_completed',
        summary: `工作流完成：${workflow.title}`,
      })
    } else {
      workflow.currentStageId = nextStage.id
      if (workflow.status === 'active') {
        nextStage.status = 'in_progress'
        nextStage.startedAt = nextStage.startedAt || now
        nextStage.updatedAt = now
        this.recordEvent(workflow, {
          type: 'stage_started',
          stageId: nextStage.id,
          summary: `阶段开始：${nextStage.name}`,
        })
      }
    }

    this.markDirty()
    return cloneWorkflow(workflow)
  }

  recordPivot(
    workflowId: string,
    stageId: string,
    reason: string,
    options: { fromApproach?: string; toApproach?: string } = {},
  ): WorkflowRun | null {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) return null
    const stage = this.resolveStage(workflow, stageId)
    if (!stage) {
      throw new Error(`阶段不存在: ${stageId}`)
    }

    const pivot: WorkflowPivot = {
      id: this.generateId('pivot'),
      stageId,
      reason,
      fromApproach: options.fromApproach,
      toApproach: options.toApproach,
      createdAt: Date.now(),
    }

    stage.pivotHistory.unshift(pivot)
    stage.updatedAt = pivot.createdAt
    workflow.updatedAt = pivot.createdAt
    workflow.resumeToken = this.generateResumeToken()
    this.recordEvent(workflow, {
      type: 'pivot_recorded',
      stageId,
      summary: `记录 pivot：${reason}`,
      metadata: {
        pivotId: pivot.id,
        fromApproach: options.fromApproach,
        toApproach: options.toApproach,
      },
    })
    this.markDirty()
    return cloneWorkflow(workflow)
  }

  attachTask(workflowId: string, stageId: string, taskId: string): WorkflowRun | null {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) return null
    const stage = this.resolveStage(workflow, stageId)
    if (!stage) {
      throw new Error(`阶段不存在: ${stageId}`)
    }

    if (!stage.taskIds.includes(taskId)) {
      stage.taskIds.push(taskId)
      stage.updatedAt = Date.now()
      workflow.updatedAt = stage.updatedAt
      this.recordEvent(workflow, {
        type: 'task_attached',
        stageId,
        taskId,
        summary: `关联任务：${taskId}`,
      })
      this.markDirty()
    }

    return cloneWorkflow(workflow)
  }

  attachBackgroundTask(workflowId: string, stageId: string, taskId: string): WorkflowRun | null {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) return null
    const stage = this.resolveStage(workflow, stageId)
    if (!stage) {
      throw new Error(`阶段不存在: ${stageId}`)
    }

    if (!stage.backgroundTaskIds.includes(taskId)) {
      stage.backgroundTaskIds.push(taskId)
      stage.updatedAt = Date.now()
      workflow.updatedAt = stage.updatedAt
      this.recordEvent(workflow, {
        type: 'background_task_attached',
        stageId,
        backgroundTaskId: taskId,
        summary: `关联后台任务：${taskId}`,
      })
      this.markDirty()
    }

    return cloneWorkflow(workflow)
  }

  noteTaskLifecycle(
    workflowId: string,
    stageId: string,
    taskId: string,
    state: 'created' | 'started' | 'completed' | 'failed' | 'cancelled',
    detail?: string,
  ): WorkflowRun | null {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) return null
    const stage = this.resolveStage(workflow, stageId)
    if (!stage) {
      throw new Error(`阶段不存在: ${stageId}`)
    }

    if (!stage.taskIds.includes(taskId)) {
      stage.taskIds.push(taskId)
    }
    stage.updatedAt = Date.now()
    workflow.updatedAt = stage.updatedAt
    this.recordEvent(workflow, {
      type: 'task_state_changed',
      stageId,
      taskId,
      summary: `任务${state}：${taskId}${detail ? ` (${detail})` : ''}`,
      metadata: {
        state,
        detail,
      },
    })
    this.markDirty()
    return cloneWorkflow(workflow)
  }

  noteBackgroundTaskLifecycle(
    workflowId: string,
    stageId: string,
    backgroundTaskId: string,
    state: 'started' | 'completed' | 'failed' | 'cancelled',
    detail?: string,
  ): WorkflowRun | null {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) return null
    const stage = this.resolveStage(workflow, stageId)
    if (!stage) {
      throw new Error(`阶段不存在: ${stageId}`)
    }

    if (!stage.backgroundTaskIds.includes(backgroundTaskId)) {
      stage.backgroundTaskIds.push(backgroundTaskId)
    }
    stage.updatedAt = Date.now()
    workflow.updatedAt = stage.updatedAt
    this.recordEvent(workflow, {
      type: 'background_task_state_changed',
      stageId,
      backgroundTaskId,
      summary: `后台任务${state}：${backgroundTaskId}${detail ? ` (${detail})` : ''}`,
      metadata: {
        state,
        detail,
      },
    })
    this.markDirty()
    return cloneWorkflow(workflow)
  }

  getWorkflow(id: string): WorkflowRun | undefined {
    const workflow = this.workflows.get(id)
    return workflow ? cloneWorkflow(workflow) : undefined
  }

  getAllWorkflows(): WorkflowRun[] {
    return Array.from(this.workflows.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneWorkflow)
  }

  getResumableWorkflows(workDir?: string): WorkflowRun[] {
    return this.getAllWorkflows().filter(workflow => {
      if (!['pending', 'active', 'paused'].includes(workflow.status)) return false
      if (!workDir) return true
      return workflow.workDir === workDir
    })
  }

  getSummary(workDir?: string): string {
    const workflows = workDir ? this.getResumableWorkflows(workDir) : this.getAllWorkflows()
    if (workflows.length === 0) {
      return '暂无工作流'
    }

    const lines = [
      '# 工作流概览',
      '',
      `- 总计: ${workflows.length}`,
      `- 可恢复: ${workflows.filter(workflow => workflow.status === 'paused').length}`,
      `- 进行中: ${workflows.filter(workflow => workflow.status === 'active').length}`,
      '',
    ]

    for (const workflow of workflows.slice(0, 10)) {
      const stage = workflow.currentStageId
        ? workflow.stages.find(item => item.id === workflow.currentStageId)
        : undefined
      lines.push(
        `- **${workflow.title}** (${workflow.id}) ` +
        `status=${workflow.status} ` +
        `${stage ? `stage=${stage.name}` : 'stage=已完成'} ` +
        `resume=${workflow.resumeToken.slice(0, 8)}...`,
      )
    }

    return lines.join('\n')
  }

  async save(): Promise<void> {
    const data = {
      version: 1,
      workflows: Array.from(this.workflows.values()),
      savedAt: Date.now(),
    }

    await fs.mkdir(path.dirname(this.config.filePath), { recursive: true })
    await fs.writeFile(this.config.filePath, JSON.stringify(data, null, 2), 'utf-8')
    this.dirty = false
    logger.debug('工作流运行时已保存')
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.config.filePath, 'utf-8')
      const data = JSON.parse(content)
      if (data.version === 1 && Array.isArray(data.workflows)) {
        this.workflows.clear()
        for (const workflow of data.workflows) {
          workflow.events = Array.isArray(workflow.events) ? workflow.events : []
          this.workflows.set(workflow.id, workflow)
        }
        logger.info(`加载了 ${this.workflows.size} 个工作流`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('加载工作流运行时失败:', error)
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopAutoSave()
    if (this.dirty) {
      await this.save()
    }
    this.initialized = false
  }

  private getCurrentOrNextStage(workflow: WorkflowRun): WorkflowStage | undefined {
    const current = workflow.currentStageId
      ? workflow.stages.find(stage => stage.id === workflow.currentStageId)
      : undefined
    if (current && current.status !== 'completed' && current.status !== 'skipped') {
      return current
    }

    return workflow.stages
      .filter(stage => stage.status === 'pending' || stage.status === 'in_progress')
      .sort((a, b) => a.order - b.order)[0]
  }

  private resolveStage(workflow: WorkflowRun, stageId: string | null | undefined): WorkflowStage | undefined {
    if (!stageId) return undefined
    return workflow.stages.find(stage => stage.id === stageId)
  }

  private canCompleteStage(stage: WorkflowStage): boolean {
    return stage.passCriteria.every(criterion => criterion.status === 'passed' || criterion.status === 'waived')
  }

  private startAutoSave(): void {
    if (this.saveTimer) return

    this.saveTimer = setInterval(() => {
      if (this.dirty) {
        this.save().catch(error => logger.error('工作流自动保存失败:', error))
      }
    }, this.config.autoSaveInterval)
    this.saveTimer.unref?.()
    process.once('exit', () => this.stopAutoSave())
  }

  private stopAutoSave(): void {
    if (!this.saveTimer) return
    clearInterval(this.saveTimer)
    this.saveTimer = null
  }

  private markDirty(): void {
    this.dirty = true
  }

  private recordEvent(
    workflow: WorkflowRun,
    event: {
      type: WorkflowEventType
      summary: string
      stageId?: string
      taskId?: string
      backgroundTaskId?: string
      metadata?: Record<string, unknown>
    },
  ): void {
    const record: WorkflowEvent = {
      id: this.generateId('event'),
      workflowId: workflow.id,
      createdAt: Date.now(),
      ...event,
    }
    workflow.events.unshift(record)
    if (workflow.events.length > 100) {
      workflow.events = workflow.events.slice(0, 100)
    }
  }

  private generateId(prefix: string): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).slice(2, 6)
    return `${prefix}-${timestamp}-${random}`
  }

  private generateResumeToken(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

function cloneWorkflow(workflow: WorkflowRun): WorkflowRun {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowRun
}

function assertUniqueIds(ids: string[], label: string): void {
  const set = new Set(ids)
  if (set.size !== ids.length) {
    throw new Error(`${label} ID 不能重复`)
  }
}

function isTerminalStatus(status: WorkflowRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

let defaultRuntime: WorkflowRuntime | null = null

export function getWorkflowRuntime(): WorkflowRuntime {
  if (!defaultRuntime) {
    defaultRuntime = new WorkflowRuntime()
  }
  return defaultRuntime
}

export async function resetWorkflowRuntime(): Promise<void> {
  if (defaultRuntime) {
    await defaultRuntime.shutdown()
  }
  defaultRuntime = null
}
