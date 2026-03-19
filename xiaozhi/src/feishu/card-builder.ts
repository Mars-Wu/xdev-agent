// src/feishu/card-builder.ts
// 飞书富卡片构建器
// 提供简洁的 API 来构建飞书消息卡片

import {
  CardConfig,
  CardElement,
  CardTemplateColor,
  CardBuilderOptions,
  MessageCard,
  PlainText,
  LarkMarkdown,
  DividerElement,
  ActionElement,
  ButtonAction,
  FieldElement,
  NoteElement,
  ListItem,
  StatusCardOptions,
  TaskListCardOptions,
} from './card-types';
import { createLogger } from '../utils/logger';

const logger = createLogger('card-builder');

/**
 * 飞书富卡片构建器
 *
 * 使用示例:
 * ```typescript
 * const card = new CardBuilder({ title: '系统状态', color: 'blue' })
 *   .addMarkdown('CPU 使用率: 45%')
 *   .addDivider()
 *   .addButton({ text: '刷新', type: 'primary', value: { action: 'refresh' } })
 *   .build();
 * ```
 */
export class CardBuilder {
  private header?: CardConfig['header'];
  private elements: CardElement[] = [];

  constructor(options: CardBuilderOptions = {}) {
    if (options.title || options.subtitle) {
      this.header = {
        title: { tag: 'plain_text', content: options.title || '' },
        subtitle: options.subtitle ? { tag: 'plain_text', content: options.subtitle } : undefined,
        template: options.color || 'blue',
      };
    }
  }

  /**
   * 设置标题
   */
  setTitle(title: string, subtitle?: string): this {
    this.header = {
      title: { tag: 'plain_text', content: title },
      subtitle: subtitle ? { tag: 'plain_text', content: subtitle } : undefined,
      template: this.header?.template || 'blue',
    };
    return this;
  }

  /**
   * 设置标题颜色
   */
  setColor(color: CardTemplateColor): this {
    if (this.header) {
      this.header.template = color;
    } else {
      logger.warn('设置颜色前请先设置标题');
    }
    return this;
  }

  /**
   * 添加 Markdown 内容
   */
  addMarkdown(content: string): this {
    this.elements.push({
      tag: 'div',
      text: content,
    });
    return this;
  }

  /**
   * 添加 Lark Markdown 内容（支持更多格式）
   */
  addLarkMarkdown(content: string): this {
    this.elements.push({
      tag: 'markdown',
      text: content,
    });
    return this;
  }

  /**
   * 添加分割线
   */
  addDivider(): this {
    this.elements.push({ tag: 'hr' });
    return this;
  }

  /**
   * 添加字段（两列布局）
   */
  addField(text: string, isShort: boolean = true): this {
    this.elements.push({
      tag: 'field',
      text: { tag: 'plain_text', content: text },
      is_short: isShort,
    });
    return this;
  }

  /**
   * 添加多个字段（两列布局）
   */
  addFields(fields: Array<{ text: string; isShort?: boolean }>): this {
    for (const field of fields) {
      this.addField(field.text, field.isShort ?? true);
    }
    return this;
  }

  /**
   * 添加 Note 元素
   */
  addNote(text: string, isMarkdown: boolean = false): this {
    const element: NoteElement = {
      tag: 'note',
      elements: [
        isMarkdown
          ? { tag: 'lark_md', content: text }
          : { tag: 'plain_text', content: text },
      ],
    };
    this.elements.push(element as unknown as CardElement);
    return this;
  }

  /**
   * 添加按钮
   */
  addButton(options: {
    text: string;
    type?: 'primary' | 'default' | 'danger';
    value?: Record<string, unknown>;
    url?: string;
  }): this {
    const button: ButtonAction = {
      tag: 'button',
      text: { tag: 'plain_text', content: options.text },
      type: options.type || 'default',
    };

    if (options.value) {
      button.value = options.value;
    }
    if (options.url) {
      button.url = options.url;
    }

    // 查找是否已有 action 元素
    const lastElement = this.elements[this.elements.length - 1];
    if (lastElement && lastElement.tag === 'action') {
      (lastElement as ActionElement).actions.push(button);
    } else {
      const actionElement: ActionElement = {
        tag: 'action',
        actions: [button],
      };
      this.elements.push(actionElement as unknown as CardElement);
    }

    return this;
  }

  /**
   * 添加按钮组
   */
  addButtons(buttons: Array<{
    text: string;
    type?: 'primary' | 'default' | 'danger';
    value?: Record<string, unknown>;
    url?: string;
  }>): this {
    const actions: ButtonAction[] = buttons.map(btn => ({
      tag: 'button',
      text: { tag: 'plain_text', content: btn.text },
      type: btn.type || 'default',
      value: btn.value,
      url: btn.url,
    }));

    this.elements.push({
      tag: 'action',
      actions,
    } as unknown as CardElement);

    return this;
  }

  /**
   * 添加列表
   */
  addList(items: ListItem[], ordered: boolean = false): this {
    const prefix = ordered ? '1. ' : '- ';
    const content = items.map(item => {
      let line = `${prefix}${item.title}`;
      if (item.content) {
        line += `: ${item.content}`;
      }
      if (item.extra) {
        line += ` ${item.extra}`;
      }
      return line;
    }).join('\n');

    return this.addMarkdown(content);
  }

  /**
   * 添加键值对列表
   */
  addKeyValueList(items: Array<{ label: string; value: string }>): this {
    const content = items.map(item => `**${item.label}**: ${item.value}`).join('\n');
    return this.addMarkdown(content);
  }

  /**
   * 构建消息卡片
   */
  build(): MessageCard {
    return {
      type: 'interactive',
      card: {
        header: this.header,
        elements: this.elements,
      },
    };
  }

  /**
   * 构建 JSON 字符串
   */
  buildJson(): string {
    return JSON.stringify(this.build());
  }

  // ==================== 静态工厂方法 ====================

  /**
   * 创建状态卡片
   */
  static statusCard(options: StatusCardOptions): MessageCard {
    const colorMap: Record<string, CardTemplateColor> = {
      success: 'green',
      error: 'red',
      warning: 'orange',
      info: 'blue',
      loading: 'grey',
    };

    const builder = new CardBuilder({
      title: options.title,
      color: colorMap[options.status],
    });

    if (options.content) {
      builder.addMarkdown(options.content);
    }

    if (options.items && options.items.length > 0) {
      builder.addDivider().addKeyValueList(options.items);
    }

    return builder.build();
  }

  /**
   * 创建任务列表卡片
   */
  static taskListCard(options: TaskListCardOptions): MessageCard {
    const builder = new CardBuilder({
      title: options.title,
      color: 'blue',
    });

    if (options.tasks.length === 0) {
      builder.addMarkdown(options.emptyMessage || '暂无任务');
    } else {
      const content = options.tasks.map(task => {
        const statusEmoji: Record<string, string> = {
          running: '🔄',
          completed: '✅',
          failed: '❌',
          pending: '⏳',
        };
        const emoji = statusEmoji[task.status] || '📋';
        let line = `${emoji} **${task.name}** (${task.status})`;
        if (task.description) {
          line += `\n   ${task.description}`;
        }
        return line;
      }).join('\n\n');

      builder.addMarkdown(content);
    }

    return builder.build();
  }

  /**
   * 创建简单的消息卡片
   */
  static simpleCard(title: string, content: string, color: CardTemplateColor = 'blue'): MessageCard {
    return new CardBuilder({ title, color })
      .addMarkdown(content)
      .build();
  }

  /**
   * 创建错误卡片
   */
  static errorCard(title: string, error: string, details?: string): MessageCard {
    const builder = new CardBuilder({ title, color: 'red' });
    builder.addMarkdown(`❌ **错误**: ${error}`);
    if (details) {
      builder.addDivider().addNote(details);
    }
    return builder.build();
  }

  /**
   * 创建成功卡片
   */
  static successCard(title: string, message: string, details?: string): MessageCard {
    const builder = new CardBuilder({ title, color: 'green' });
    builder.addMarkdown(`✅ ${message}`);
    if (details) {
      builder.addDivider().addMarkdown(details);
    }
    return builder.build();
  }

  /**
   * 创建 Cron 任务卡片
   */
  static cronTaskCard(task: {
    id: string;
    description: string;
    cronExpr: string;
    enabled: boolean;
    lastRun?: string;
    runCount: number;
  }): MessageCard {
    const builder = new CardBuilder({
      title: '⏰ 定时任务',
      color: task.enabled ? 'blue' : 'grey',
    });

    builder
      .addKeyValueList([
        { label: '描述', value: task.description },
        { label: 'Cron 表达式', value: `\`${task.cronExpr}\`` },
        { label: '状态', value: task.enabled ? '✅ 已启用' : '⏸ 已禁用' },
        { label: '执行次数', value: String(task.runCount) },
      ]);

    if (task.lastRun) {
      builder.addMarkdown(`**上次执行**: ${task.lastRun}`);
    }

    builder.addDivider().addButtons([
      { text: task.enabled ? '禁用' : '启用', type: task.enabled ? 'default' : 'primary', value: { action: 'toggle', taskId: task.id } },
      { text: '删除', type: 'danger', value: { action: 'delete', taskId: task.id } },
    ]);

    return builder.build();
  }
}
