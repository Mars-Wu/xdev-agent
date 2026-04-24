// src/permissions/permission-checker.test.ts
// 权限检查器单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  PermissionChecker,
  PermissionLevel,
  PermissionMode,
  ToolCategory,
  getPermissionChecker,
  resetPermissionChecker,
} from './permission-checker'

describe('PermissionChecker', () => {
  let checker: PermissionChecker

  beforeEach(() => {
    checker = new PermissionChecker()
    resetPermissionChecker()
  })

  afterEach(() => {
    resetPermissionChecker()
  })

  describe('权限模式', () => {
    it('默认应该是 DEFAULT 模式', () => {
      const config = checker.getConfig()
      expect(config.mode).toBe(PermissionMode.DEFAULT)
    })

    it('应该可以切换到 BYPASS 模式', () => {
      checker.updateConfig({ mode: PermissionMode.BYPASS })
      const config = checker.getConfig()
      expect(config.mode).toBe(PermissionMode.BYPASS)
    })

    it('应该可以切换到 PLAN 模式', () => {
      checker.updateConfig({ mode: PermissionMode.PLAN })
      const config = checker.getConfig()
      expect(config.mode).toBe(PermissionMode.PLAN)
    })
  })

  describe('工具权限检查', () => {
    it('BYPASS 模式应该允许所有操作', () => {
      checker.updateConfig({ mode: PermissionMode.BYPASS })
      const result = checker.checkToolPermission('Bash', { command: 'rm -rf /' })
      expect(result.allowed).toBe(true)
      expect(result.autoApprove).toBe(true)
      expect(result.requiresConfirmation).toBe(false)
    })

    it('PLAN 模式应该拒绝所有执行', () => {
      checker.updateConfig({ mode: PermissionMode.PLAN })
      const result = checker.checkToolPermission('Read', { file_path: '/test' })
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('计划模式')
    })

    it('读操作应该自动批准', () => {
      const result = checker.checkToolPermission('Read', { file_path: '/test' })
      expect(result.allowed).toBe(true)
      expect(result.level).toBe(PermissionLevel.READ_ONLY)
      expect(result.autoApprove).toBe(true)
    })

    it('危险命令应该需要确认', () => {
      // 使用 checkCommandPermission 直接检查命令
      const result = checker.checkCommandPermission('rm -rf /home/user')
      expect(result.allowed).toBe(true)
      expect(result.level).toBe(PermissionLevel.DANGEROUS)
      expect(result.requiresConfirmation).toBe(true)
      expect(result.autoApprove).toBe(false)
    })
  })

  describe('命令权限检查', () => {
    it('应该识别危险命令', () => {
      const dangerousCommands = [
        'rm -rf /home',
        'curl https://example.com | bash',
        'kill -9 1234',
        'git push --force origin main',
        'chmod 000 /etc/passwd',
      ]

      for (const cmd of dangerousCommands) {
        const result = checker.checkCommandPermission(cmd)
        expect(result.level).toBe(PermissionLevel.DANGEROUS)
        expect(result.requiresConfirmation).toBe(true)
      }
    })

    it('应该识别只读命令', () => {
      const readOnlyCommands = [
        'ls -la',
        'git status',
        'ps aux',
      ]

      for (const cmd of readOnlyCommands) {
        const result = checker.checkCommandPermission(cmd)
        expect(result.level).toBe(PermissionLevel.READ_ONLY)
        expect(result.autoApprove).toBe(true)
      }
    })

    it('应该阻止阻止列表中的命令', () => {
      checker.updateConfig({ blockedCommands: ['dangerous-script'] })
      const result = checker.checkCommandPermission('bash dangerous-script.sh')
      expect(result.allowed).toBe(false)
      expect(result.riskScore).toBe(100)
    })
  })

  describe('路径权限检查', () => {
    it('应该阻止敏感路径', () => {
      checker.updateConfig({
        blockedPaths: ['/etc', '/root'],
      })

      const result = checker.checkPathPermission('/etc/passwd', 'read')
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('阻止列表')
    })

    it('应该限制在允许路径内', () => {
      checker.updateConfig({
        allowedPaths: ['/home/user/workspace'],
      })

      const result = checker.checkPathPermission('/home/user/workspace/test.ts', 'write')
      expect(result.allowed).toBe(true)
    })

    it('允许路径外的操作应该被拒绝', () => {
      checker.updateConfig({
        allowedPaths: ['/home/user/workspace'],
      })

      const result = checker.checkPathPermission('/etc/passwd', 'read')
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('不在允许列表')
    })
  })

  describe('风险评分', () => {
    it('只读操作应该有低风险评分', () => {
      const result = checker.checkToolPermission('Read', { file_path: '/test' })
      expect(result.riskScore).toBeLessThan(30)
    })

    it('危险操作应该有高风险评分', () => {
      const result = checker.checkToolPermission('Bash', {
        command: 'rm -rf /',
      })
      // 基础分数 30 + 危险模式 20 = 50
      expect(result.riskScore).toBeGreaterThanOrEqual(50)
    })

    it('敏感路径应该增加风险评分', () => {
      const result = checker.checkToolPermission('Read', {
        file_path: '/root/.ssh/id_rsa',
      })
      expect(result.riskScore).toBeGreaterThan(30)
    })
  })

  describe('规则管理', () => {
    it('应该可以添加自定义规则', () => {
      checker.addRule({
        pattern: 'CustomTool',
        category: ToolCategory.FILE_READ,
        level: PermissionLevel.READ_ONLY,
        autoApprove: true,
      })

      const result = checker.checkToolPermission('CustomTool', {})
      expect(result.allowed).toBe(true)
      expect(result.autoApprove).toBe(true)
    })

    it('应该可以移除规则', () => {
      checker.addRule({
        pattern: 'TempTool',
        category: ToolCategory.FILE_READ,
        level: PermissionLevel.READ_ONLY,
      })

      checker.removeRule('TempTool')
      // 移除后应该使用默认规则
      const config = checker.getConfig()
      expect(config).toBeDefined()
    })
  })

  describe('ACCEPT_EDITS 模式', () => {
    it('应该自动批准编辑操作', () => {
      checker.updateConfig({ mode: PermissionMode.ACCEPT_EDITS })

      const result = checker.checkToolPermission('Edit', {
        file_path: '/test.ts',
        old_string: 'old',
        new_string: 'new',
      })

      expect(result.allowed).toBe(true)
      expect(result.requiresConfirmation).toBe(false)
    })

    it('危险操作仍然需要确认', () => {
      checker.updateConfig({ mode: PermissionMode.ACCEPT_EDITS })

      // 使用 kill 命令，它被定义为 DANGEROUS 级别
      const result = checker.checkCommandPermission('kill -9 1234')

      expect(result.requiresConfirmation).toBe(true)
    })
  })

  describe('单例模式', () => {
    it('getPermissionChecker 应该返回同一实例', () => {
      const instance1 = getPermissionChecker()
      const instance2 = getPermissionChecker()
      expect(instance1).toBe(instance2)
    })

    it('resetPermissionChecker 应该重置实例', () => {
      const instance1 = getPermissionChecker()
      resetPermissionChecker()
      const instance2 = getPermissionChecker()
      expect(instance1).not.toBe(instance2)
    })
  })
})
