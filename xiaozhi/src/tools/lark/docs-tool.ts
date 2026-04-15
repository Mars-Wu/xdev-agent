import type { Tool, ToolParameterSchema, ToolResult } from '../tool-interface'
import { errorResult, successResult } from '../tool-interface'
import {
  appendBooleanFlag,
  appendNumberFlag,
  appendStringFlag,
  asRecordArray,
  isRecord,
  readString,
  runLarkCli,
} from './runner'

const larkDocsSearchDefinition = {
  name: 'lark_docs_search',
  description:
    '搜索飞书云文档、知识库和表格文件。适合先按关键词定位文档资源，再进一步读取或更新。',
  parameters: {
    query: {
      type: 'string' as const,
      description: '搜索关键词',
      minLength: 1,
    },
    identity: {
      type: 'string' as const,
      description: '调用身份，默认 user',
      enum: ['user', 'bot'],
      default: 'user',
    },
    page_size: {
      type: 'number' as const,
      description: '最多返回多少个结果，默认 10，最大 20',
      default: 10,
      minimum: 1,
      maximum: 20,
    },
  } as Record<string, ToolParameterSchema>,
  required: ['query'],
  readOnly: true,
}

const larkDocsFetchDefinition = {
  name: 'lark_docs_fetch',
  description:
    '读取飞书文档内容，支持传入文档 URL 或 token。适合在定位到文档后抓取正文内容做分析。',
  parameters: {
    doc: {
      type: 'string' as const,
      description: '文档 URL 或 token',
      minLength: 1,
    },
    identity: {
      type: 'string' as const,
      description: '调用身份，默认 user',
      enum: ['user', 'bot'],
      default: 'user',
    },
    limit: {
      type: 'number' as const,
      description: '分页 limit',
      minimum: 1,
    },
    offset: {
      type: 'number' as const,
      description: '分页 offset',
      minimum: 0,
    },
    dry_run: {
      type: 'boolean' as const,
      description: '仅输出将调用的 CLI 请求，不实际执行',
      default: false,
    },
  } as Record<string, ToolParameterSchema>,
  required: ['doc'],
  readOnly: true,
}

const larkDocsCreateDefinition = {
  name: 'lark_docs_create',
  description:
    '创建飞书文档，可指定标题、Markdown 内容以及目标文件夹或知识库位置。',
  parameters: {
    identity: {
      type: 'string' as const,
      description: '调用身份，默认 user',
      enum: ['user', 'bot'],
      default: 'user',
    },
    title: {
      type: 'string' as const,
      description: '文档标题',
    },
    markdown: {
      type: 'string' as const,
      description: 'Markdown 正文内容',
    },
    folder_token: {
      type: 'string' as const,
      description: '父文件夹 token',
    },
    wiki_node: {
      type: 'string' as const,
      description: '知识库节点 token',
    },
    wiki_space: {
      type: 'string' as const,
      description: '知识库空间 ID，例如 my_library',
    },
    dry_run: {
      type: 'boolean' as const,
      description: '仅输出将调用的 CLI 请求，不实际执行',
      default: false,
    },
  } as Record<string, ToolParameterSchema>,
  readOnly: false,
}

const larkDocsUpdateDefinition = {
  name: 'lark_docs_update',
  description:
    '更新飞书文档内容，支持追加、覆盖、范围替换、插入和删除，并可同时改标题。',
  parameters: {
    doc: {
      type: 'string' as const,
      description: '文档 URL 或 token',
      minLength: 1,
    },
    identity: {
      type: 'string' as const,
      description: '调用身份，默认 user',
      enum: ['user', 'bot'],
      default: 'user',
    },
    mode: {
      type: 'string' as const,
      description: '更新模式',
      enum: ['append', 'overwrite', 'replace_range', 'replace_all', 'insert_before', 'insert_after', 'delete_range'],
      default: 'append',
    },
    markdown: {
      type: 'string' as const,
      description: '新的 Markdown 内容',
    },
    new_title: {
      type: 'string' as const,
      description: '新的文档标题',
    },
    selection_by_title: {
      type: 'string' as const,
      description: '按标题定位目标区块',
    },
    selection_with_ellipsis: {
      type: 'string' as const,
      description: '按内容片段定位目标区块，格式如 start...end',
    },
    dry_run: {
      type: 'boolean' as const,
      description: '仅输出将调用的 CLI 请求，不实际执行',
      default: false,
    },
  } as Record<string, ToolParameterSchema>,
  required: ['doc'],
  readOnly: false,
}

export function createLarkDocsSearchTool(): Tool {
  return {
    definition: larkDocsSearchDefinition,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const query = typeof params.query === 'string' ? params.query.trim() : ''
      const identity = params.identity === 'bot' ? 'bot' : 'user'
      const pageSize =
        typeof params.page_size === 'number' && Number.isFinite(params.page_size)
          ? Math.max(1, Math.min(20, Math.floor(params.page_size)))
          : 10

      if (!query) {
        return errorResult('缺少 query 参数')
      }

      const args = ['docs', '+search', '--query', query, '--format', 'json']
      appendStringFlag(args, '--as', identity)
      appendNumberFlag(args, '--page-size', pageSize)

      const result = await runLarkCli(args, { parseMode: 'json' })
      if (!result.ok) {
        return errorResult(`飞书文档搜索失败: ${result.error}`)
      }

      if (!isRecord(result.parsed)) {
        return errorResult('飞书文档搜索输出格式无效')
      }

      const data = isRecord(result.parsed.data) ? result.parsed.data : null
      const results = asRecordArray(data?.results)
      const total = typeof data?.total === 'number' ? data.total : results.length

      if (results.length === 0) {
        return successResult(`未找到与 "${query}" 匹配的飞书文档资源。`, {
          query,
          count: 0,
          total,
          results: [],
          raw: result.parsed,
        })
      }

      const lines = [`找到 ${results.length} 个飞书文档资源（total=${total}）：`]
      for (const item of results.slice(0, 10)) {
        const meta = isRecord(item.result_meta) ? item.result_meta : null
        lines.push(
          `- ${readString(item, 'title_highlighted') || 'untitled'} (${readString(meta, 'doc_types') || 'unknown'}, token=${readString(meta, 'token') || 'unknown'})`,
        )
      }

      return successResult(lines.join('\n'), {
        query,
        count: results.length,
        total,
        results,
        raw: result.parsed,
      })
    },

    validateParams: validateDocsSearchParams,
  }
}

export function createLarkDocsFetchTool(): Tool {
  return {
    definition: larkDocsFetchDefinition,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const doc = typeof params.doc === 'string' ? params.doc.trim() : ''
      const identity = params.identity === 'bot' ? 'bot' : 'user'
      const limit =
        typeof params.limit === 'number' && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : undefined
      const offset =
        typeof params.offset === 'number' && Number.isFinite(params.offset)
          ? Math.max(0, Math.floor(params.offset))
          : undefined
      const dryRun = params.dry_run === true

      if (!doc) {
        return errorResult('缺少 doc 参数')
      }

      const args = ['docs', '+fetch', '--doc', doc, '--format', 'json']
      appendStringFlag(args, '--as', identity)
      appendNumberFlag(args, '--limit', limit)
      appendNumberFlag(args, '--offset', offset)
      appendBooleanFlag(args, '--dry-run', dryRun)

      const result = await runLarkCli(args, { parseMode: 'json' })
      if (!result.ok) {
        return errorResult(`飞书文档读取失败: ${result.error}`)
      }

      const output = dryRun
        ? formatDryRunOutput('fetch-doc', result.parsed)
        : formatFetchOutput(doc, result.parsed)

      return successResult(output, {
        doc,
        dry_run: dryRun,
        raw: result.parsed,
      })
    },

    validateParams: validateDocsFetchParams,
  }
}

export function createLarkDocsCreateTool(): Tool {
  return {
    definition: larkDocsCreateDefinition,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const identity = params.identity === 'bot' ? 'bot' : 'user'
      const title = typeof params.title === 'string' ? params.title : ''
      const markdown = typeof params.markdown === 'string' ? params.markdown : ''
      const folderToken = typeof params.folder_token === 'string' ? params.folder_token.trim() : ''
      const wikiNode = typeof params.wiki_node === 'string' ? params.wiki_node.trim() : ''
      const wikiSpace = typeof params.wiki_space === 'string' ? params.wiki_space.trim() : ''
      const dryRun = params.dry_run === true

      const args = ['docs', '+create', '--as', identity]
      appendStringFlag(args, '--title', title)
      appendStringFlag(args, '--markdown', markdown)
      appendStringFlag(args, '--folder-token', folderToken)
      appendStringFlag(args, '--wiki-node', wikiNode)
      appendStringFlag(args, '--wiki-space', wikiSpace)
      appendBooleanFlag(args, '--dry-run', dryRun)

      const result = await runLarkCli(args, { parseMode: 'json' })
      if (!result.ok) {
        return errorResult(`飞书文档创建失败: ${result.error}`)
      }

      const output = dryRun
        ? formatDryRunOutput('create-doc', result.parsed)
        : formatMutationOutput('文档已创建', result.parsed)

      return successResult(output, {
        title: title || undefined,
        dry_run: dryRun,
        raw: result.parsed,
      })
    },

    validateParams: validateDocsCreateParams,
  }
}

export function createLarkDocsUpdateTool(): Tool {
  return {
    definition: larkDocsUpdateDefinition,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const doc = typeof params.doc === 'string' ? params.doc.trim() : ''
      const identity = params.identity === 'bot' ? 'bot' : 'user'
      const mode = typeof params.mode === 'string' && params.mode ? params.mode : 'append'
      const markdown = typeof params.markdown === 'string' ? params.markdown : ''
      const newTitle = typeof params.new_title === 'string' ? params.new_title : ''
      const selectionByTitle =
        typeof params.selection_by_title === 'string' ? params.selection_by_title : ''
      const selectionWithEllipsis =
        typeof params.selection_with_ellipsis === 'string' ? params.selection_with_ellipsis : ''
      const dryRun = params.dry_run === true

      if (!doc) {
        return errorResult('缺少 doc 参数')
      }

      const args = ['docs', '+update', '--doc', doc, '--as', identity, '--mode', mode]
      appendStringFlag(args, '--markdown', markdown)
      appendStringFlag(args, '--new-title', newTitle)
      appendStringFlag(args, '--selection-by-title', selectionByTitle)
      appendStringFlag(args, '--selection-with-ellipsis', selectionWithEllipsis)
      appendBooleanFlag(args, '--dry-run', dryRun)

      const result = await runLarkCli(args, { parseMode: 'json' })
      if (!result.ok) {
        return errorResult(`飞书文档更新失败: ${result.error}`)
      }

      const output = dryRun
        ? formatDryRunOutput('update-doc', result.parsed)
        : formatMutationOutput(`文档已更新（mode=${mode}）`, result.parsed)

      return successResult(output, {
        doc,
        mode,
        dry_run: dryRun,
        raw: result.parsed,
      })
    },

    validateParams: validateDocsUpdateParams,
  }
}

function validateDocsSearchParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
  const errors: string[] = []

  if (!params.query || typeof params.query !== 'string' || params.query.trim().length === 0) {
    errors.push('query 参数必须是非空字符串')
  }

  if (params.identity !== undefined && params.identity !== 'user' && params.identity !== 'bot') {
    errors.push('identity 参数必须是 user 或 bot')
  }

  if (params.page_size !== undefined) {
    if (typeof params.page_size !== 'number' || !Number.isFinite(params.page_size)) {
      errors.push('page_size 参数必须是数字')
    } else if (params.page_size < 1 || params.page_size > 20) {
      errors.push('page_size 参数必须在 1 到 20 之间')
    }
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
}

function validateDocsFetchParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
  const errors: string[] = []

  if (!params.doc || typeof params.doc !== 'string' || params.doc.trim().length === 0) {
    errors.push('doc 参数必须是非空字符串')
  }

  if (params.identity !== undefined && params.identity !== 'user' && params.identity !== 'bot') {
    errors.push('identity 参数必须是 user 或 bot')
  }

  if (params.limit !== undefined && (typeof params.limit !== 'number' || !Number.isFinite(params.limit) || params.limit < 1)) {
    errors.push('limit 参数必须是大于 0 的数字')
  }

  if (params.offset !== undefined && (typeof params.offset !== 'number' || !Number.isFinite(params.offset) || params.offset < 0)) {
    errors.push('offset 参数必须是大于等于 0 的数字')
  }

  if (params.dry_run !== undefined && typeof params.dry_run !== 'boolean') {
    errors.push('dry_run 参数必须是布尔值')
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
}

function validateDocsCreateParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
  const errors: string[] = []

  if (params.identity !== undefined && params.identity !== 'user' && params.identity !== 'bot') {
    errors.push('identity 参数必须是 user 或 bot')
  }

  const hasTitle = typeof params.title === 'string' && params.title.trim().length > 0
  const hasMarkdown = typeof params.markdown === 'string' && params.markdown.length > 0
  if (!hasTitle && !hasMarkdown) {
    errors.push('title 和 markdown 至少需要提供一个')
  }

  if (params.dry_run !== undefined && typeof params.dry_run !== 'boolean') {
    errors.push('dry_run 参数必须是布尔值')
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
}

function validateDocsUpdateParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
  const errors: string[] = []

  if (!params.doc || typeof params.doc !== 'string' || params.doc.trim().length === 0) {
    errors.push('doc 参数必须是非空字符串')
  }

  if (params.identity !== undefined && params.identity !== 'user' && params.identity !== 'bot') {
    errors.push('identity 参数必须是 user 或 bot')
  }

  const allowedModes = new Set([
    'append',
    'overwrite',
    'replace_range',
    'replace_all',
    'insert_before',
    'insert_after',
    'delete_range',
  ])
  if (params.mode !== undefined && (typeof params.mode !== 'string' || !allowedModes.has(params.mode))) {
    errors.push('mode 参数不合法')
  }
  const mode = typeof params.mode === 'string' && allowedModes.has(params.mode) ? params.mode : 'append'

  const hasMarkdown = typeof params.markdown === 'string' && params.markdown.length > 0
  const hasNewTitle = typeof params.new_title === 'string' && params.new_title.length > 0
  const hasSelectionByTitle =
    typeof params.selection_by_title === 'string' && params.selection_by_title.length > 0
  const hasSelectionWithEllipsis =
    typeof params.selection_with_ellipsis === 'string' && params.selection_with_ellipsis.length > 0

  if (!hasMarkdown && !hasNewTitle && !hasSelectionByTitle && !hasSelectionWithEllipsis) {
    errors.push('markdown、new_title、selection_by_title、selection_with_ellipsis 至少需要提供一个')
  }

  const hasSelection = hasSelectionByTitle || hasSelectionWithEllipsis
  if (mode === 'delete_range' && !hasSelection) {
    errors.push('delete_range 模式必须提供 selection_by_title 或 selection_with_ellipsis')
  }

  if (mode === 'replace_range' && !hasSelection) {
    errors.push('replace_range 模式必须提供 selection_by_title 或 selection_with_ellipsis')
  }

  if (mode === 'insert_before' && !hasSelection) {
    errors.push('insert_before 模式必须提供 selection_by_title 或 selection_with_ellipsis')
  }

  if (mode === 'insert_after' && !hasSelection) {
    errors.push('insert_after 模式必须提供 selection_by_title 或 selection_with_ellipsis')
  }

  if (mode !== 'delete_range' && !hasMarkdown && !hasNewTitle) {
    errors.push(`${mode} 模式至少需要提供 markdown 或 new_title`)
  }

  if (params.dry_run !== undefined && typeof params.dry_run !== 'boolean') {
    errors.push('dry_run 参数必须是布尔值')
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
}

function formatDryRunOutput(expectedTool: string, payload: unknown): string {
  if (isRecord(payload)) {
    const toolName = readString(payload, 'mcp_tool') || expectedTool
    return `dry run prepared for ${toolName}`
  }

  return `dry run prepared for ${expectedTool}`
}

function formatFetchOutput(doc: string, payload: unknown): string {
  if (!isRecord(payload)) {
    return `文档内容已读取：${doc}`
  }

  const data = isRecord(payload.data) ? payload.data : payload
  const title =
    readString(data, 'title') ||
    readString(data, 'doc_title') ||
    readString(data, 'name')
  const content =
    readString(data, 'content') ||
    readString(data, 'markdown') ||
    readString(data, 'text')

  const lines = [`文档内容已读取：${title || doc}`]
  if (content) {
    lines.push(content.replace(/\s+/g, ' ').trim().slice(0, 240))
  }

  return lines.join('\n')
}

function formatMutationOutput(prefix: string, payload: unknown): string {
  if (!isRecord(payload)) {
    return prefix
  }

  const data = isRecord(payload.data) ? payload.data : payload
  const token =
    readString(data, 'token') ||
    readString(data, 'doc_token') ||
    readString(data, 'document_id')
  const url = readString(data, 'url') || readString(data, 'doc_url')

  const lines = [prefix]
  if (token) {
    lines.push(`token: ${token}`)
  }
  if (url) {
    lines.push(`url: ${url}`)
  }

  return lines.join('\n')
}
