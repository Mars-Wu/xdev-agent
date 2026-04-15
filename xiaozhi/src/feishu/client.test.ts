import { describe, expect, it } from 'vitest'
import { parseFeishuMessageContent } from './client'

describe('parseFeishuMessageContent', () => {
  it('returns plain text messages', () => {
    expect(parseFeishuMessageContent(JSON.stringify({ text: 'hello' }))).toBe('hello')
  })

  it('extracts readable text from post messages', () => {
    const content = {
      zh_cn: {
        title: '日报',
        content: [
          [
            { tag: 'text', text: '今天完成 ' },
            { tag: 'text', text: '代码评审', bold: true },
          ],
          [
            { tag: 'text', text: '详情见 ' },
            { tag: 'a', text: '文档', href: 'https://example.com/doc' },
          ],
          [{ tag: 'code_block', language: 'text', text: 'npm test' }],
        ],
      },
    }

    expect(parseFeishuMessageContent(JSON.stringify(content))).toBe(
      ['日报', '今天完成 代码评审', '详情见 文档', 'npm test'].join('\n'),
    )
  })

  it('falls back to the raw string when content is not JSON', () => {
    expect(parseFeishuMessageContent('plain string')).toBe('plain string')
  })
})
