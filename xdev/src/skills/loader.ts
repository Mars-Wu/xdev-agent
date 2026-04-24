// src/skills/loader.ts
// Skill 加载器

import * as fs from 'fs/promises'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import type { SkillDefinition, SkillFrontmatter, SkillParameter } from './types'

const logger = createLogger('skill-loader')

/**
 * 解析 frontmatter
 */
function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter
  body: string
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)

  if (!match) {
    return { frontmatter: { name: '' }, body: content }
  }

  const frontmatterText = match[1]
  const body = match[2]

  // 简单 YAML 解析
  const frontmatter: Record<string, unknown> = {}
  const lines = frontmatterText.split('\n')
  let currentKey = ''
  let currentArray: unknown[] | null = null
  let inParameters = false
  let currentParam: Partial<SkillParameter> | null = null
  const parameters: SkillParameter[] = []

  for (const line of lines) {
    // 参数列表项
    const arrayItemMatch = line.match(/^  - name:\s*(.+)$/)
    if (arrayItemMatch && inParameters) {
      if (currentParam && currentParam.name) {
        parameters.push(currentParam as SkillParameter)
      }
      currentParam = { name: arrayItemMatch[1].trim() }
      continue
    }

    // 参数属性
    const paramPropMatch = line.match(/^    (\w+):\s*(.*)$/)
    if (paramPropMatch && currentParam) {
      const key = paramPropMatch[1]
      let value: unknown = paramPropMatch[2].trim()

      if (value === 'true') value = true
      else if (value === 'false') value = false
      else if (value && !isNaN(Number(value))) value = Number(value)

      ;(currentParam as Record<string, unknown>)[key] = value
      continue
    }

    // 普通数组项
    const simpleArrayMatch = line.match(/^\s*-\s+(.+)$/)
    if (simpleArrayMatch && currentArray) {
      currentArray.push(simpleArrayMatch[1])
      continue
    }

    // 键值对
    const kvMatch = line.match(/^(\w+):\s*(.*)$/)
    if (kvMatch) {
      // 保存之前的参数
      if (currentParam && currentParam.name) {
        parameters.push(currentParam as SkillParameter)
        currentParam = null
      }

      currentKey = kvMatch[1]
      const value = kvMatch[2].trim()
      inParameters = currentKey === 'parameters'

      if (value === '') {
        currentArray = []
        frontmatter[currentKey] = currentArray
      } else if (value.startsWith('[') && value.endsWith(']')) {
        try {
          frontmatter[currentKey] = JSON.parse(value)
        } catch {
          frontmatter[currentKey] = value
        }
      } else if (value === 'true') {
        frontmatter[currentKey] = true
      } else if (value === 'false') {
        frontmatter[currentKey] = false
      } else if (value && !isNaN(Number(value))) {
        frontmatter[currentKey] = Number(value)
      } else {
        frontmatter[currentKey] = value
      }
    }
  }

  // 保存最后一个参数
  if (currentParam && currentParam.name) {
    parameters.push(currentParam as SkillParameter)
  }

  if (parameters.length > 0) {
    frontmatter.parameters = parameters
  }

  return {
    frontmatter: frontmatter as unknown as SkillFrontmatter,
    body: body.trim(),
  }
}

/**
 * 加载单个 Skill 文件
 */
export async function loadSkill(filepath: string): Promise<SkillDefinition> {
  const content = await fs.readFile(filepath, 'utf-8')
  const { frontmatter, body } = parseFrontmatter(content)

  if (!frontmatter.name) {
    frontmatter.name = path.basename(filepath, '.md')
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    version: frontmatter.version,
    author: frontmatter.author,
    parameters: frontmatter.parameters,
    systemPrompt: body,
    model: frontmatter.model,
    temperature: frontmatter.temperature,
    maxTokens: frontmatter.maxTokens,
  }
}

/**
 * 加载目录下所有 Skill
 */
export async function loadSkillsFromDirectory(
  dir: string
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  try {
    await fs.access(dir)
  } catch {
    return skills
  }

  try {
    const files = await fs.readdir(dir)

    for (const file of files) {
      if (file.endsWith('.md')) {
        try {
          const skill = await loadSkill(path.join(dir, file))
          skills.push(skill)
          logger.info(`加载技能: ${skill.name}`)
        } catch (error) {
          logger.warn(`加载技能失败: ${file}`, error)
        }
      }
    }
  } catch (error) {
    logger.warn(`读取技能目录失败: ${dir}`, error)
  }

  return skills
}

/**
 * 保存 Skill 到文件
 */
export async function saveSkill(
  dir: string,
  skill: SkillDefinition
): Promise<string> {
  await fs.mkdir(dir, { recursive: true })

  const filepath = path.join(dir, `${skill.name}.md`)
  const content = generateSkillFile(skill)

  await fs.writeFile(filepath, content, 'utf-8')
  logger.info(`保存技能: ${skill.name}`)

  return filepath
}

/**
 * 生成 Skill 文件内容
 */
function generateSkillFile(skill: SkillDefinition): string {
  const lines: string[] = ['---']

  lines.push(`name: ${skill.name}`)

  if (skill.description) {
    lines.push(`description: ${skill.description}`)
  }

  if (skill.version) {
    lines.push(`version: ${skill.version}`)
  }

  if (skill.author) {
    lines.push(`author: ${skill.author}`)
  }

  if (skill.parameters && skill.parameters.length > 0) {
    lines.push('parameters:')
    for (const param of skill.parameters) {
      lines.push(`  - name: ${param.name}`)
      if (param.description) {
        lines.push(`    description: ${param.description}`)
      }
      if (param.type) {
        lines.push(`    type: ${param.type}`)
      }
      if (param.required !== undefined) {
        lines.push(`    required: ${param.required}`)
      }
    }
  }

  if (skill.model) {
    lines.push(`model: ${skill.model}`)
  }

  if (skill.temperature !== undefined) {
    lines.push(`temperature: ${skill.temperature}`)
  }

  if (skill.maxTokens !== undefined) {
    lines.push(`maxTokens: ${skill.maxTokens}`)
  }

  lines.push('---')
  lines.push('')
  lines.push(skill.systemPrompt)

  return lines.join('\n')
}
