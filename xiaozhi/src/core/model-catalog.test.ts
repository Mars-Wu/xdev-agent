import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIN_MODEL,
  DEFAULT_VISION_MODEL,
  listTextCatalogModels,
  resolveCatalogModelId,
} from './model-catalog'

describe('model catalog', () => {
  it('should expose text models without native-only vision models', () => {
    const ids = listTextCatalogModels({ transport: 'anthropic-messages' }).map((entry) => entry.id)
    expect(ids).toContain('glm-5-turbo')
    expect(ids).toContain('glm-5.1')
    expect(ids).toContain('glm-4-flash')
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
})
