import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveModelName,
  resolveTextApiConfig,
  resolveVisionApiConfig,
} from './model-config'
import { ModelCapabilitiesManager } from './model-capabilities'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, ORIGINAL_ENV)
})

describe('model resolution', () => {
  it('should preserve explicit glm-5.1', () => {
    expect(resolveModelName('glm-5.1')).toBe('glm-5.1')
  })

  it('should keep glm-5 distinct from glm-5.1', () => {
    expect(resolveModelName('glm-5')).toBe('glm-5')
  })

  it('should resolve fuzzy glm-5.1 names', () => {
    expect(resolveModelName('GLM51')).toBe('glm-5.1')
  })

  it('should default unknown capability lookups to glm-5-turbo', () => {
    const manager = new ModelCapabilitiesManager()
    expect(manager.resolveModel('unknown-model').id).toBe('glm-5-turbo')
  })

  it('should resolve explicit glm-5.1 capabilities', () => {
    const manager = new ModelCapabilitiesManager()
    expect(manager.resolveModel('glm-5.1').id).toBe('glm-5.1')
  })

  it('should preserve explicit deepseek-v4-pro', () => {
    expect(resolveModelName('deepseek-v4-pro')).toBe('deepseek-v4-pro')
  })

  it('should resolve DeepSeek text API config from env', () => {
    process.env.XDEV_LLM_PROVIDER = 'deepseek'
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'

    expect(resolveTextApiConfig({ model: 'deepseek-v4-pro' })).toMatchObject({
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com/anthropic',
      apiKey: 'test-deepseek-key',
    })
  })

  it('should keep vision config independent from text provider', () => {
    process.env.XDEV_LLM_PROVIDER = 'deepseek'
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key'
    process.env.ZHIPU_API_KEY = 'test-glm-key'

    expect(resolveVisionApiConfig()).toMatchObject({
      provider: 'glm',
      apiKey: 'test-glm-key',
    })
  })
})
