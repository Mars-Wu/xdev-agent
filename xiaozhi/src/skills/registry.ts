// src/skills/registry.ts
// Skill 注册表

import * as path from 'path'
import * as fs from 'fs/promises'
import { createLogger } from '../utils/logger'
import type { SkillDefinition } from './types'
import { loadSkillsFromDirectory, loadSkill } from './loader'

const logger = createLogger('skill-registry')

/**
 * Skill 注册表
 */
export class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map()
  private skillsDir: string
  private builtinsDir: string

  constructor(skillsDir: string, builtinsDir?: string) {
    this.skillsDir = skillsDir
    this.builtinsDir = builtinsDir || path.join(__dirname, 'builtins')
  }

  /**
   * 初始化 - 加载所有技能
   */
  async initialize(): Promise<void> {
    // 确保目录存在
    await fs.mkdir(this.skillsDir, { recursive: true })

    // 加载内置技能
    try {
      const builtins = await loadSkillsFromDirectory(this.builtinsDir)
      for (const skill of builtins) {
        this.skills.set(skill.name, skill)
      }
      logger.info(`加载 ${builtins.length} 个内置技能`)
    } catch (error) {
      logger.warn('加载内置技能失败', error)
    }

    // 加载用户技能
    const userSkills = await loadSkillsFromDirectory(this.skillsDir)
    for (const skill of userSkills) {
      this.skills.set(skill.name, skill)
    }

    logger.info(`已加载 ${this.skills.size} 个技能`)
  }

  /**
   * 获取技能
   */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  /**
   * 检查技能是否存在
   */
  has(name: string): boolean {
    return this.skills.has(name)
  }

  /**
   * 列出所有技能
   */
  list(): SkillDefinition[] {
    return Array.from(this.skills.values())
  }

  /**
   * 列出所有技能名称
   */
  listNames(): string[] {
    return Array.from(this.skills.keys())
  }

  /**
   * 注册技能
   */
  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill)
    logger.info(`注册技能: ${skill.name}`)
  }

  /**
   * 注销技能
   */
  unregister(name: string): boolean {
    const result = this.skills.delete(name)
    if (result) {
      logger.info(`注销技能: ${name}`)
    }
    return result
  }

  /**
   * 重新加载技能
   */
  async reload(name: string): Promise<boolean> {
    // 尝试从用户目录加载
    const filepath = path.join(this.skillsDir, `${name}.md`)
    try {
      const skill = await loadSkill(filepath)
      this.skills.set(name, skill)
      logger.info(`重新加载技能: ${name}`)
      return true
    } catch {
      // 尝试从内置目录加载
      const builtinPath = path.join(this.builtinsDir, `${name}.md`)
      try {
        const skill = await loadSkill(builtinPath)
        this.skills.set(name, skill)
        logger.info(`重新加载内置技能: ${name}`)
        return true
      } catch {
        logger.warn(`重新加载技能失败: ${name}`)
        return false
      }
    }
  }

  /**
   * 重新加载所有技能
   */
  async reloadAll(): Promise<void> {
    this.skills.clear()
    await this.initialize()
  }

  /**
   * 获取技能数量
   */
  size(): number {
    return this.skills.size
  }
}

// 单例
let registry: SkillRegistry | null = null

/**
 * 获取 Skill 注册表
 */
export function getSkillRegistry(): SkillRegistry {
  if (!registry) {
    const skillsDir = path.join(process.env.HOME || '', '.xiaozhi', 'skills')
    registry = new SkillRegistry(skillsDir)
  }
  return registry
}

/**
 * 初始化 Skill 注册表
 */
export async function initializeSkillRegistry(): Promise<SkillRegistry> {
  const reg = getSkillRegistry()
  await reg.initialize()
  return reg
}

/**
 * 重置 Skill 注册表
 */
export function resetSkillRegistry(): void {
  registry = null
}
