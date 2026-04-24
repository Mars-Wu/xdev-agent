// src/skills/skill-tool.ts
// Skill 工具注册

import type { Tool, ToolResult } from '../tools/tool-interface'
import { successResult, errorResult } from '../tools/tool-interface'
import { getSkillRegistry } from './registry'
import { getSkillExecutor } from './executor'
import { createLogger } from '../utils/logger'

const logger = createLogger('skill-tool')

/**
 * 创建 Skill 工具
 *
 * 注意：此工具会使用免费模型（glm-4-flash, glm-4.7-flash 等）
 * 适合翻译、摘要、代码审查等特定任务，可以节省主力模型资源
 */
export function createSkillTool(): Tool {
  return {
    definition: {
      name: 'use_skill',
      description:
        '使用预定义的 Skill 处理特定任务。Skill 会自动使用免费模型，节省主力模型资源。' +
        '遇到以下任务时应该使用此工具：' +
        '- 翻译文本 → use_skill name=translate params={to:"目标语言"} message="要翻译的内容"' +
        '- 总结内容 → use_skill name=summarize params={style:"brief"} message="要总结的内容"' +
        '- 代码审查 → use_skill name=code-review params={language:"语言"} message="要审查的代码"' +
        '- 解释代码 → use_skill name=explain params={level:"深度"} message="要解释的代码"',
      parameters: {
        name: {
          type: 'string',
          description: 'Skill 名称。可用: translate(翻译), summarize(摘要), code-review(代码审查), explain(解释)',
        },
        params: {
          type: 'object',
          description: 'Skill 参数。translate: {from, to, style}; summarize: {style, maxLength, language}; code-review: {language, focus}; explain: {level, focus}',
        },
        message: {
          type: 'string',
          description: '要处理的内容（文本或代码）',
        },
      },
      required: ['name', 'message'],
      dangerous: false,
      readOnly: false,
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const skillName = params.name as string
      const skillParams = (params.params as Record<string, unknown>) || {}
      const message = params.message as string | undefined

      if (!skillName) {
        return errorResult('缺少技能名称')
      }

      try {
        const executor = getSkillExecutor()
        const result = await executor.execute(skillName, skillParams, message)

        if (result.success) {
          return successResult(result.content)
        } else {
          return errorResult(result.error || '技能执行失败')
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        logger.error(`技能执行失败: ${skillName}`, error)
        return errorResult(`技能执行失败: ${errorMsg}`)
      }
    },
  }
}

/**
 * 创建列出技能工具
 */
export function createListSkillsTool(): Tool {
  return {
    definition: {
      name: 'list_skills',
      description: '列出所有可用的技能',
      parameters: {},
      required: [],
      dangerous: false,
      readOnly: true,
    },

    async execute(): Promise<ToolResult> {
      const registry = getSkillRegistry()
      const skills = registry.list()

      if (skills.length === 0) {
        return successResult('暂无可用技能')
      }

      const lines = ['可用技能:', '']

      for (const skill of skills) {
        lines.push(`- **${skill.name}**`)
        if (skill.description) {
          lines.push(`  ${skill.description}`)
        }
        if (skill.parameters && skill.parameters.length > 0) {
          const params = skill.parameters
            .map(p => {
              const req = p.required ? '*' : ''
              return `${p.name}${req}`
            })
            .join(', ')
          lines.push(`  参数: ${params}`)
        }
        lines.push('')
      }

      lines.push('* = 必需参数')

      return successResult(lines.join('\n'))
    },
  }
}

/**
 * 创建获取技能详情工具
 */
export function createGetSkillInfoTool(): Tool {
  return {
    definition: {
      name: 'get_skill_info',
      description: '获取技能的详细信息',
      parameters: {
        name: {
          type: 'string',
          description: '技能名称',
        },
      },
      required: ['name'],
      dangerous: false,
      readOnly: true,
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const skillName = params.name as string

      if (!skillName) {
        return errorResult('缺少技能名称')
      }

      const registry = getSkillRegistry()
      const skill = registry.get(skillName)

      if (!skill) {
        return errorResult(`技能不存在: ${skillName}`)
      }

      const lines = [`# ${skill.name}`, '']

      if (skill.description) {
        lines.push(skill.description)
        lines.push('')
      }

      if (skill.version || skill.author) {
        lines.push('---')
        if (skill.version) lines.push(`版本: ${skill.version}`)
        if (skill.author) lines.push(`作者: ${skill.author}`)
        lines.push('')
      }

      if (skill.parameters && skill.parameters.length > 0) {
        lines.push('## 参数')
        lines.push('')
        for (const param of skill.parameters) {
          const req = param.required ? ' (必需)' : ''
          lines.push(`- **${param.name}**${req}`)
          if (param.description) {
            lines.push(`  ${param.description}`)
          }
          if (param.type) {
            lines.push(`  类型: ${param.type}`)
          }
          if (param.default !== undefined) {
            lines.push(`  默认值: ${param.default}`)
          }
        }
        lines.push('')
      }

      lines.push('## 系统提示词')
      lines.push('')
      lines.push('```')
      lines.push(skill.systemPrompt.slice(0, 1000))
      if (skill.systemPrompt.length > 1000) {
        lines.push('...(已截断)')
      }
      lines.push('```')

      return successResult(lines.join('\n'))
    },
  }
}
