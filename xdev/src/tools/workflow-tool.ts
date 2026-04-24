import type { Tool, ToolResult } from './tool-interface'
import { errorResult, successResult } from './tool-interface'
import {
  CreateWorkflowStageInput,
  getWorkflowRuntime,
  WorkflowPassCriterionStatus,
  WorkflowRun,
} from './workflow-runtime'
import { createLogger } from '../utils/logger'

const logger = createLogger('workflow-tool')

export function createWorkflowTool(): Tool {
  return {
    definition: {
      name: 'workflow',
      description:
        '管理可恢复的多阶段工作流。支持阶段启动、暂停恢复、checkpoint、pass criteria、pivot 记录。' +
        '适用场景：复杂任务分阶段执行、需要中断恢复、需要明确阶段门禁和转向记录。',
      parameters: {
        action: {
          type: 'string',
          description:
            '操作类型: create, start, pause, resume, checkpoint, criterion, complete_stage, pivot, attach_task, attach_background, fail, cancel, get, list, summary',
          enum: [
            'create',
            'start',
            'pause',
            'resume',
            'checkpoint',
            'criterion',
            'complete_stage',
            'pivot',
            'attach_task',
            'attach_background',
            'fail',
            'cancel',
            'get',
            'list',
            'summary',
          ],
        },
        id: {
          type: 'string',
          description: '工作流 ID',
        },
        title: {
          type: 'string',
          description: '工作流标题（create 时必需）',
        },
        description: {
          type: 'string',
          description: '工作流描述（create 时可选）',
        },
        path: {
          type: 'string',
          description: '工作目录路径（默认当前目录）',
        },
        stages: {
          type: 'array',
          description: '阶段定义数组（create 时必需）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              passCriteria: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        stageId: {
          type: 'string',
          description: '阶段 ID',
        },
        criterionId: {
          type: 'string',
          description: '门禁 ID',
        },
        status: {
          type: 'string',
          description: '门禁状态（criterion 操作时必需）',
          enum: ['pending', 'passed', 'failed', 'waived'],
        },
        summary: {
          type: 'string',
          description: 'checkpoint 或 complete_stage 的摘要',
        },
        evidence: {
          type: 'array',
          description: '相关证据列表',
          items: { type: 'string' },
        },
        reason: {
          type: 'string',
          description: '失败或 pivot 原因',
        },
        fromApproach: {
          type: 'string',
          description: 'pivot 前的方法',
        },
        toApproach: {
          type: 'string',
          description: 'pivot 后的方法',
        },
        taskId: {
          type: 'string',
          description: '要关联的 task/background task ID',
        },
      },
      required: ['action'],
      dangerous: false,
      readOnly: false,
    },

    async execute(params: Record<string, unknown>, context?: Record<string, unknown>): Promise<ToolResult> {
      const runtime = getWorkflowRuntime()
      await runtime.initialize()

      const action = params.action as string
      const workflowId = params.id as string | undefined
      const workDir = ((params.path as string) || (context?.workDir as string) || process.cwd()).trim()

      try {
        switch (action) {
          case 'create': {
            const title = (params.title as string) || ''
            const description = (params.description as string) || ''
            const stages = normalizeStages(params.stages)
            if (!title) return errorResult('create 需要提供 title')
            if (!stages || stages.length === 0) return errorResult('create 需要提供 stages')

            const workflow = runtime.createWorkflow(title, description, {
              stages,
              workDir,
            })
            return successResult(
              `工作流已创建: ${workflow.id}\n标题: ${workflow.title}\n阶段数: ${workflow.stages.length}\n状态: ${workflow.status}`,
            )
          }

          case 'start': {
            if (!workflowId) return errorResult('start 需要提供 id')
            const workflow = runtime.startWorkflow(workflowId)
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowBrief(workflow))
          }

          case 'pause': {
            if (!workflowId) return errorResult('pause 需要提供 id')
            const workflow = runtime.pauseWorkflow(workflowId)
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowBrief(workflow))
          }

          case 'resume': {
            if (!workflowId) return errorResult('resume 需要提供 id')
            const workflow = runtime.resumeWorkflow(workflowId)
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowBrief(workflow))
          }

          case 'checkpoint': {
            if (!workflowId) return errorResult('checkpoint 需要提供 id')
            const summary = (params.summary as string) || ''
            if (!summary) return errorResult('checkpoint 需要提供 summary')

            const workflow = runtime.checkpointWorkflow(workflowId, summary, {
              stageId: params.stageId as string | undefined,
              evidence: (params.evidence as string[]) || [],
            })
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowBrief(workflow))
          }

          case 'criterion': {
            if (!workflowId) return errorResult('criterion 需要提供 id')
            const stageId = params.stageId as string
            const criterionId = params.criterionId as string
            const status = params.status as WorkflowPassCriterionStatus
            if (!stageId || !criterionId || !status) {
              return errorResult('criterion 需要提供 stageId、criterionId、status')
            }

            const workflow = runtime.updatePassCriterion(
              workflowId,
              stageId,
              criterionId,
              status,
              params.summary as string | undefined,
            )
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowBrief(workflow))
          }

          case 'complete_stage': {
            if (!workflowId) return errorResult('complete_stage 需要提供 id')
            const stageId = params.stageId as string
            if (!stageId) return errorResult('complete_stage 需要提供 stageId')
            const workflow = runtime.completeStage(workflowId, stageId, {
              summary: params.summary as string | undefined,
              evidence: (params.evidence as string[]) || [],
            })
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowBrief(workflow))
          }

          case 'pivot': {
            if (!workflowId) return errorResult('pivot 需要提供 id')
            const stageId = params.stageId as string
            const reason = params.reason as string
            if (!stageId || !reason) return errorResult('pivot 需要提供 stageId 和 reason')

            const workflow = runtime.recordPivot(workflowId, stageId, reason, {
              fromApproach: params.fromApproach as string | undefined,
              toApproach: params.toApproach as string | undefined,
            })
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowBrief(workflow))
          }

          case 'attach_task': {
            if (!workflowId) return errorResult('attach_task 需要提供 id')
            const stageId = params.stageId as string
            const taskId = params.taskId as string
            if (!stageId || !taskId) return errorResult('attach_task 需要提供 stageId 和 taskId')
            const workflow = runtime.attachTask(workflowId, stageId, taskId)
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowBrief(workflow))
          }

          case 'attach_background': {
            if (!workflowId) return errorResult('attach_background 需要提供 id')
            const stageId = params.stageId as string
            const taskId = params.taskId as string
            if (!stageId || !taskId) return errorResult('attach_background 需要提供 stageId 和 taskId')
            const workflow = runtime.attachBackgroundTask(workflowId, stageId, taskId)
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowBrief(workflow))
          }

          case 'fail': {
            if (!workflowId) return errorResult('fail 需要提供 id')
            const reason = (params.reason as string) || '未提供失败原因'
            const workflow = runtime.failWorkflow(workflowId, reason)
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowBrief(workflow))
          }

          case 'cancel': {
            if (!workflowId) return errorResult('cancel 需要提供 id')
            const workflow = runtime.cancelWorkflow(workflowId)
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowBrief(workflow))
          }

          case 'get': {
            if (!workflowId) return errorResult('get 需要提供 id')
            const workflow = runtime.getWorkflow(workflowId)
            if (!workflow) return errorResult(`工作流不存在: ${workflowId}`)
            return successResult(renderWorkflowDetail(workflow))
          }

          case 'list': {
            const workflows = runtime.getAllWorkflows()
            if (workflows.length === 0) return successResult('暂无工作流')
            return successResult(
              workflows
                .map(workflow => renderWorkflowBrief(workflow))
                .join('\n\n'),
            )
          }

          case 'summary': {
            return successResult(runtime.getSummary(workDir))
          }

          default:
            return errorResult(`未知操作: ${action}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`工作流操作失败: ${action}`, error)
        return errorResult(`工作流操作失败: ${message}`)
      }
    },
  }
}

function normalizeStages(value: unknown): CreateWorkflowStageInput[] | null {
  if (!Array.isArray(value)) return null
  const stages: CreateWorkflowStageInput[] = []

  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const name = raw.name as string | undefined
    if (!name) continue

    const passCriteria: Array<string | { id?: string; description: string }> = []
    if (Array.isArray(raw.passCriteria)) {
      for (const entry of raw.passCriteria) {
        if (typeof entry === 'string') {
          passCriteria.push(entry)
          continue
        }
        if (!entry || typeof entry !== 'object') continue
        const criterion = entry as Record<string, unknown>
        const description = criterion.description as string | undefined
        if (!description) continue
        passCriteria.push({
          id: criterion.id as string | undefined,
          description,
        })
      }
    }

    stages.push({
      id: raw.id as string | undefined,
      name,
      description: raw.description as string | undefined,
      passCriteria,
    })
  }

  return stages
}

function renderWorkflowBrief(workflow: WorkflowRun): string {
  const currentStage = workflow.currentStageId
    ? workflow.stages.find(stage => stage.id === workflow.currentStageId)
    : undefined
  return [
    `工作流: ${workflow.title}`,
    `- ID: ${workflow.id}`,
    `- 状态: ${workflow.status}`,
    `- 当前阶段: ${currentStage ? `${currentStage.name} (${currentStage.status})` : '无'}`,
    `- Resume Token: ${workflow.resumeToken}`,
  ].join('\n')
}

function renderWorkflowDetail(workflow: WorkflowRun): string {
  const lines = [
    `# 工作流: ${workflow.title}`,
    '',
    `- ID: ${workflow.id}`,
    `- 状态: ${workflow.status}`,
    `- 描述: ${workflow.description || '（无）'}`,
    `- 工作目录: ${workflow.workDir || '（未设置）'}`,
    `- Resume Token: ${workflow.resumeToken}`,
    `- 更新时间: ${new Date(workflow.updatedAt).toLocaleString()}`,
    '',
    '## 阶段',
    '',
  ]

  for (const stage of workflow.stages) {
    lines.push(`### ${stage.name} (${stage.id})`)
    lines.push(`- 状态: ${stage.status}`)
    if (stage.description) lines.push(`- 描述: ${stage.description}`)
    if (stage.passCriteria.length > 0) {
      lines.push(`- 门禁:`)
      for (const criterion of stage.passCriteria) {
        lines.push(`  - [${criterion.status}] ${criterion.description}`)
      }
    }
    if (stage.taskIds.length > 0) {
      lines.push(`- 关联任务: ${stage.taskIds.join(', ')}`)
    }
    if (stage.backgroundTaskIds.length > 0) {
      lines.push(`- 后台任务: ${stage.backgroundTaskIds.join(', ')}`)
    }
    if (stage.pivotHistory.length > 0) {
      lines.push(`- Pivot 次数: ${stage.pivotHistory.length}`)
    }
    lines.push('')
  }

  if (workflow.checkpoints.length > 0) {
    lines.push('## 最近检查点', '')
    for (const checkpoint of workflow.checkpoints.slice(0, 3)) {
      lines.push(`- ${checkpoint.stageId}: ${checkpoint.summary}`)
    }
  }

  if (workflow.events.length > 0) {
    lines.push('', '## 最近事件', '')
    for (const event of workflow.events.slice(0, 5)) {
      lines.push(`- [${event.type}] ${event.summary}`)
    }
  }

  return lines.join('\n')
}

export const workflowTool = createWorkflowTool()
