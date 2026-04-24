import type { Tool, ToolResult } from './tool-interface'
import { errorResult, successResult } from './tool-interface'
import {
  generateCodebaseSnapshot,
  generateOrLoadCodebaseSnapshot,
  getCodebaseSnapshotArtifactPaths,
  loadCodebaseSnapshot,
  renderCodebaseSnapshotMarkdown,
  saveCodebaseSnapshot,
} from '../context/codebase-map'
import { createLogger } from '../utils/logger'

const logger = createLogger('map-tool')

export function createMapTool(): Tool {
  return {
    definition: {
      name: 'map',
      description:
        '生成或读取代码库快照，帮助 Agent/Worker 快速建立项目上下文。' +
        '适用场景：进入陌生仓库、开始复杂任务前先看结构、需要项目目录/技术栈/核心模块/命令概览时。',
      parameters: {
        action: {
          type: 'string',
          description: '操作类型：generate(生成快照) 或 get(读取已保存的快照)',
          enum: ['generate', 'get'],
        },
        path: {
          type: 'string',
          description: '目标代码库路径，默认使用当前工作目录',
        },
        format: {
          type: 'string',
          description: '输出格式：markdown(完整快照), summary(摘要), json(结构化 JSON)',
          enum: ['markdown', 'summary', 'json'],
          default: 'markdown',
        },
        save: {
          type: 'boolean',
          description: '生成时是否保存到 ~/.xdev/cache/codebase-maps/，默认 true',
          default: true,
        },
      },
      required: ['action'],
      dangerous: false,
      readOnly: false,
    },

    async execute(params: Record<string, unknown>, context?: Record<string, unknown>): Promise<ToolResult> {
      const action = (params.action as string) || 'generate'
      const format = (params.format as string) || 'markdown'
      const rootPath = ((params.path as string) || (context?.workDir as string) || process.cwd()).trim()

      try {
        if (action === 'get') {
          const snapshot = await loadCodebaseSnapshot(rootPath)
          if (!snapshot) {
            const artifactPaths = getCodebaseSnapshotArtifactPaths(rootPath)
            return errorResult(`未找到已保存的代码库快照：${artifactPaths.jsonPath}`)
          }

          return successResult(formatSnapshotOutput(snapshot, format), {
            rootPath: snapshot.rootPath,
            ...getCodebaseSnapshotArtifactPaths(rootPath),
          })
        }

        if (action !== 'generate') {
          return errorResult(`不支持的 action: ${action}`)
        }

        const { snapshot, cacheHit } = await generateOrLoadCodebaseSnapshot(rootPath)
        let savedPaths: { jsonPath: string; markdownPath: string } | undefined
        if (params.save !== false) {
          savedPaths = await saveCodebaseSnapshot(snapshot)
        }

        logger.info(`代码库快照已生成: ${snapshot.rootPath}`)

        const output = [
          formatSnapshotOutput(snapshot, format),
          savedPaths
            ? `\n已保存：\n- JSON: ${savedPaths.jsonPath}\n- Markdown: ${savedPaths.markdownPath}\n- 缓存命中: ${cacheHit ? 'yes' : 'no'}`
            : '',
        ].join('')

        return successResult(output.trim(), {
          rootPath: snapshot.rootPath,
          saved: Boolean(savedPaths),
          cacheHit,
          ...savedPaths,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error(`代码库快照生成失败: ${rootPath}`, error)
        return errorResult(`代码库快照生成失败: ${errorMessage}`)
      }
    },
  }
}

export const mapTool = createMapTool()

function formatSnapshotOutput(snapshot: Awaited<ReturnType<typeof generateCodebaseSnapshot>>, format: string): string {
  switch (format) {
    case 'json':
      return JSON.stringify(snapshot, null, 2)
    case 'summary':
      return [
        `# ${snapshot.rootName} 代码库摘要`,
        `- 根目录：${snapshot.rootPath}`,
        `- 语言：${snapshot.techStack.languages.map(item => `${item.name}(${item.fileCount})`).join('，') || '（未检测到）'}`,
        `- 核心模块数：${snapshot.coreModules.length}`,
        `- 测试文件数：${snapshot.testFiles.count}`,
        `- 常用命令：${[...snapshot.commands.build, ...snapshot.commands.test, ...snapshot.commands.dev].join('；') || '（未检测到）'}`,
      ].join('\n')
    case 'markdown':
    default:
      return renderCodebaseSnapshotMarkdown(snapshot)
  }
}
