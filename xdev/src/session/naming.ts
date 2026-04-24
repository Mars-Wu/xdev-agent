// src/session/naming.ts
// 会话自动命名

import { createLogger } from '../utils/logger'

const logger = createLogger('session-naming')

/**
 * 会话命名配置
 */
export interface SessionNamingConfig {
  maxLength: number
  style: 'kebab-case' | 'snake_case' | 'camelCase' | 'chinese'
}

const DEFAULT_CONFIG: SessionNamingConfig = {
  maxLength: 30,
  style: 'kebab-case',
}

/**
 * 从对话生成会话名称
 */
export async function generateSessionName(
  messages: Array<{ role: string; content: string }>,
  config: Partial<SessionNamingConfig> = {}
): Promise<string> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config }

  if (messages.length === 0) {
    return `session-${Date.now()}`
  }

  // 提取关键信息
  const userMessages = messages.filter(m => m.role === 'user')
  const assistantMessages = messages.filter(m => m.role === 'assistant')

  // 获取第一条用户消息
  const firstUserMessage = userMessages[0]?.content || ''

  // 获取最后一条助手消息
  const lastAssistantMessage = assistantMessages[assistantMessages.length - 1]?.content || ''

  // 提取关键词
  const keywords = extractKeywords(firstUserMessage + ' ' + lastAssistantMessage)

  // 生成名称
  const name = buildNameFromKeywords(keywords, finalConfig)

  logger.debug(`生成会话名称: ${name}`)
  return name
}

/**
 * 提取关键词
 */
function extractKeywords(text: string): string[] {
  // 停用词列表
  const stopWords = new Set([
    '的', '了', '是', '在', '有', '和', '与', '或', '也', '都',
    '这', '那', '我', '你', '他', '她', '它', '们',
    '请', '帮', '要', '能', '会', '可以', '需要',
    '什么', '怎么', '如何', '为什么', '哪个', '哪里',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'must', 'shall',
    'can', 'need', 'dare', 'ought', 'used',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after',
    'above', 'below', 'between', 'under', 'again', 'further',
    'then', 'once', 'here', 'there', 'when', 'where', 'why',
    'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some',
    'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
    'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
    'because', 'until', 'while', 'about', 'against', 'between',
  ])

  // 技术关键词优先
  const techKeywords = [
    'bug', 'fix', 'error', 'issue', 'feature', 'refactor', 'optimize',
    'test', 'deploy', 'build', 'compile', 'install', 'update', 'upgrade',
    'config', 'setting', 'file', 'code', 'function', 'class', 'module',
    'api', 'sdk', 'http', 'json', 'yaml', 'xml', 'sql', 'git',
    'bug修复', '功能', '重构', '优化', '测试', '部署', '编译', '安装',
    '配置', '文件', '代码', '函数', '类', '模块', '接口',
  ]

  // 分词（简单实现）
  const words = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w))

  // 优先技术关键词
  const techMatches = words.filter(w =>
    techKeywords.some(kw => w.includes(kw) || kw.includes(w))
  )

  if (techMatches.length > 0) {
    return [...new Set(techMatches)].slice(0, 5)
  }

  // 返回其他关键词
  return [...new Set(words)].slice(0, 5)
}

/**
 * 从关键词构建名称
 */
function buildNameFromKeywords(
  keywords: string[],
  config: SessionNamingConfig
): string {
  if (keywords.length === 0) {
    return `session-${Date.now()}`
  }

  const timestamp = new Date().toISOString().split('T')[0]

  switch (config.style) {
    case 'kebab-case':
      return keywords
        .map(k => k.replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '-').toLowerCase())
        .join('-')
        .slice(0, config.maxLength)

    case 'snake_case':
      return keywords
        .map(k => k.replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_').toLowerCase())
        .join('_')
        .slice(0, config.maxLength)

    case 'camelCase':
      return keywords
        .map((k, i) => i === 0 ? k : k.charAt(0).toUpperCase() + k.slice(1))
        .join('')
        .replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '')
        .slice(0, config.maxLength)

    case 'chinese':
      return keywords
        .join('')
        .slice(0, config.maxLength)

    default:
      return keywords.join('-').slice(0, config.maxLength)
  }
}

/**
 * 从文件路径生成名称
 */
export function generateNameFromPath(filePath: string): string {
  const basename = filePath.split('/').pop() || 'file'
  const name = basename.replace(/\.[^.]+$/, '').replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '-')
  return name.toLowerCase().slice(0, 30)
}

/**
 * 从 Git 分支生成名称
 */
export function generateNameFromBranch(branch: string): string {
  const safeName = branch
    .replace(/^(feature|fix|hotfix|release|bugfix|chore|docs|refactor|test)\//, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]/gi, '-')
    .toLowerCase()

  return safeName.slice(0, 30)
}

/**
 * 从错误信息生成名称
 */
export function generateNameFromError(error: string): string {
  const errorKeywords = error
    .toLowerCase()
    .replace(/error[:：]/gi, '')
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter(w => w.length > 2)
    .slice(0, 3)

  if (errorKeywords.length === 0) {
    return `error-${Date.now()}`
  }

  return `fix-${errorKeywords.join('-')}`.slice(0, 30)
}
