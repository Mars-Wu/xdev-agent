// src/tools/tool-registry.test.ts
// 工具注册表单元测试

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ToolRegistry, getToolRegistry, resetToolRegistry } from './tool-registry'
import { Tool, FullTool, ToolCategory } from './tool-interface'

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  // 模拟工具
  const mockTool: Tool = {
    definition: {
      name: 'TestTool',
      description: 'A test tool',
      parameters: {
        input: { type: 'string', description: 'Test input' },
      },
      required: ['input'],
      readOnly: true,
    },
    execute: vi.fn().mockResolvedValue({ success: true, output: 'test result' }),
  }

  const mockFullTool: FullTool = {
    definition: {
      name: 'FullTestTool',
      description: 'A full test tool',
      parameters: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
      dangerous: true,
      readOnly: false,
    },
    metadata: {
      category: 'file' as ToolCategory,
      version: '1.0.0',
      author: 'test',
    },
    execute: vi.fn().mockResolvedValue({ success: true }),
    validateParams: vi.fn().mockReturnValue({ valid: true }),
    cleanup: vi.fn().mockResolvedValue(undefined),
  }

  beforeEach(() => {
    registry = new ToolRegistry()
    resetToolRegistry()
    vi.clearAllMocks()
  })

  afterEach(() => {
    registry.cleanup()
  })

  describe('工具注册', () => {
    it('应该成功注册工具', () => {
      registry.register(mockTool)
      expect(registry.has('TestTool')).toBe(true)
    })

    it('应该成功批量注册工具', () => {
      registry.registerAll([mockTool, mockFullTool])
      expect(registry.has('TestTool')).toBe(true)
      expect(registry.has('FullTestTool')).toBe(true)
    })

    it('注册已存在的工具应该发出警告', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      registry.register(mockTool)
      registry.register(mockTool) // 重复注册
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('应该成功注销工具', () => {
      registry.register(mockTool)
      const result = registry.unregister('TestTool')
      expect(result).toBe(true)
      expect(registry.has('TestTool')).toBe(false)
    })

    it('注销不存在的工具应该返回 false', () => {
      const result = registry.unregister('NonExistentTool')
      expect(result).toBe(false)
    })
  })

  describe('工具查询', () => {
    beforeEach(() => {
      registry.register(mockTool)
      registry.register(mockFullTool)
    })

    it('应该正确获取工具', () => {
      const tool = registry.get('TestTool')
      expect(tool).toBeDefined()
      expect(tool?.definition.name).toBe('TestTool')
    })

    it('获取不存在的工具应该返回 undefined', () => {
      const tool = registry.get('NonExistentTool')
      expect(tool).toBeUndefined()
    })

    it('应该正确列出所有工具', () => {
      const tools = registry.list()
      expect(tools).toHaveLength(2)
    })

    it('应该按类别列出工具', () => {
      const tools = registry.listByCategory('file' as ToolCategory)
      expect(tools).toHaveLength(1)
      expect(tools[0].definition.name).toBe('FullTestTool')
    })

    it('应该正确获取工具定义', () => {
      const definitions = registry.getDefinitions()
      expect(definitions).toHaveLength(2)
      expect(definitions[0]).toHaveProperty('name')
      expect(definitions[0]).toHaveProperty('description')
      expect(definitions[0]).toHaveProperty('input_schema')
    })
  })

  describe('工具执行', () => {
    beforeEach(() => {
      registry.register(mockTool)
      registry.register(mockFullTool)
    })

    it('应该成功执行工具', async () => {
      const result = await registry.execute('TestTool', { input: 'test' })
      expect(result.success).toBe(true)
      expect(result.output).toBe('test result')
    })

    it('执行不存在的工具应该返回错误', async () => {
      const result = await registry.execute('NonExistentTool', {})
      expect(result.success).toBe(false)
      expect(result.error).toContain('工具不存在')
    })

    it('危险工具需要确认', async () => {
      const result = await registry.execute('FullTestTool', { path: '/test' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('需要确认')
    })

    it('危险工具在允许危险操作时可以执行', async () => {
      const result = await registry.execute(
        'FullTestTool',
        { path: '/test' },
        { allowDangerous: true }
      )
      expect(result.success).toBe(true)
    })

    it('参数验证失败应该返回错误', async () => {
      vi.mocked(mockFullTool.validateParams!).mockReturnValueOnce({
        valid: false,
        errors: ['path is required'],
      })

      const result = await registry.execute(
        'FullTestTool',
        {},
        { allowDangerous: true }
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('参数验证失败')
    })

    it('工具执行应该记录耗时', async () => {
      const result = await registry.execute('TestTool', { input: 'test' })
      expect(result.duration).toBeDefined()
      expect(result.duration).toBeGreaterThanOrEqual(0)
    })
  })

  describe('上下文管理', () => {
    it('应该正确设置默认上下文', () => {
      registry.setContext({ workDir: '/test' })
      expect(registry).toBeDefined()
    })
  })

  describe('统计功能', () => {
    beforeEach(() => {
      registry.register(mockTool)
      registry.register(mockFullTool)
    })

    it('应该正确获取统计信息', () => {
      const stats = registry.getStats()
      expect(stats.total).toBe(2)
      expect(stats.dangerous).toContain('FullTestTool')
      expect(stats.readOnly).toContain('TestTool')
    })
  })

  describe('清理功能', () => {
    it('应该成功清理所有工具', async () => {
      registry.register(mockFullTool)
      await registry.cleanup()
      expect(registry.list()).toHaveLength(0)
    })
  })

  describe('单例模式', () => {
    it('getToolRegistry 应该返回同一实例', () => {
      const instance1 = getToolRegistry()
      const instance2 = getToolRegistry()
      expect(instance1).toBe(instance2)
    })

    it('resetToolRegistry 应该重置实例', () => {
      const instance1 = getToolRegistry()
      resetToolRegistry()
      const instance2 = getToolRegistry()
      expect(instance1).not.toBe(instance2)
    })
  })
})
