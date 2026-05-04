import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIN_MODEL,
  DEFAULT_VISION_MODEL,
  getDefaultPresetForProvider,
  getModelPreset,
  listTextCatalogModels,
  resolveCatalogModelId,
} from './model-catalog'

describe('model catalog', () => {
  it('should expose text models without native-only vision models', () => {
    const ids = listTextCatalogModels({ transport: 'anthropic-messages' }).map((entry) => entry.id)
    expect(ids).toContain('glm-5-turbo')
    expect(ids).toContain('glm-5.1')
    expect(ids).toContain('glm-4-flash')
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).toContain('deepseek-v4-pro')
    expect(ids).not.toContain('glm-5v-turbo')
  })

  it('should keep native vision models out of text resolution', () => {
    expect(resolveCatalogModelId('glm-5v-turbo', {
      kind: 'text',
      transport: 'anthropic-messages',
      fallback: DEFAULT_MAIN_MODEL,
    })).toBe(DEFAULT_MAIN_MODEL)
  })

  it('should resolve vision aliases inside the vision path', () => {
    expect(resolveCatalogModelId('4v-flash', {
      kind: 'vision',
      transport: 'native-chat-completions',
      fallback: DEFAULT_VISION_MODEL,
    })).toBe('glm-4v-flash')
  })

  it('should resolve DeepSeek compatibility aliases to the flash model', () => {
    expect(resolveCatalogModelId('deepseek-chat', {
      kind: 'text',
      transport: 'anthropic-messages',
      fallback: DEFAULT_MAIN_MODEL,
    })).toBe('deepseek-v4-flash')
  })

  it('should expose a DeepSeek hybrid preset for one-shot switching', () => {
    expect(getDefaultPresetForProvider('deepseek')).toBe('deepseek-hybrid')
    expect(getModelPreset('deepseek-hybrid')).toMatchObject({
      provider: 'deepseek',
      defaultModel: 'deepseek-v4-pro',
      routerModel: 'deepseek-v4-flash',
      selectorModel: 'deepseek-v4-flash',
    })
  })
})
