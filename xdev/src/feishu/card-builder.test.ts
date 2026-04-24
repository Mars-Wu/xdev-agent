import { describe, expect, it } from 'vitest';
import { CardBuilder } from './card-builder';

describe('CardBuilder', () => {
  it('builds interactive payload as bare card config', () => {
    const card = new CardBuilder({ title: 'Need confirm', color: 'yellow' })
      .addMarkdown('请选择一个选项')
      .addButton({ text: '表格', value: { clarify_reply: '表格' } })
      .build();

    expect(card).toEqual({
      header: {
        title: { tag: 'plain_text', content: 'Need confirm' },
        subtitle: undefined,
        template: 'yellow',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '请选择一个选项' },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '表格' },
              type: 'default',
              value: { clarify_reply: '表格' },
            },
          ],
        },
      ],
    });
  });
});
