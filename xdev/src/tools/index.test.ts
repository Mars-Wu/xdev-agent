import { describe, expect, it } from 'vitest'
import { createDefaultToolRegistry } from './index'

describe('createDefaultToolRegistry', () => {
  it('registers lark-cli tools', () => {
    const registry = createDefaultToolRegistry()
    const toolNames = registry.getDefinitions().map((definition) => definition.name)

    expect(toolNames).toContain('map')
    expect(toolNames).toContain('workflow')
    expect(toolNames).toContain('lark_auth_status')
    expect(toolNames).toContain('lark_contact_search_user')
    expect(toolNames).toContain('lark_im_send')
    expect(toolNames).toContain('lark_im_search_messages')
    expect(toolNames).toContain('lark_docs_search')
    expect(toolNames).toContain('lark_docs_fetch')
    expect(toolNames).toContain('lark_docs_create')
    expect(toolNames).toContain('lark_docs_update')
    expect(toolNames).toContain('lark_calendar_agenda')
    expect(toolNames).toContain('lark_calendar_freebusy')
    expect(toolNames).toContain('lark_calendar_create')
  })
})
