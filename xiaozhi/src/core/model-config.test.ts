import { describe, expect, it } from 'vitest'
import { resolveModelName } from './model-config'
import { ModelCapabilitiesManager } from './model-capabilities'

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
})
