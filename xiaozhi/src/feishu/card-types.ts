// src/feishu/card-types.ts
// 飞书富卡片类型定义
// 参考: https://open.feishu.cn/document/ukTMukTMuMjM4QjM4Qj

/**
 * 卡片标题颜色模板
 */
export type CardTemplateColor =
  | 'blue'
  | 'wathet'
  | 'turquoise'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'carmine'
  | 'violet'
  | 'purple'
  | 'indigo'
  | 'grey'
  | 'grey';

/**
 * 纯文本内容
 */
export interface PlainText {
  tag: 'plain_text';
  content: string;
  lines?: number;
}

/**
 * Lark MD 内容
 */
export interface LarkMarkdown {
  tag: 'lark_md';
  content: string;
}

/**
 * 分割线元素
 */
export interface DividerElement {
  tag: 'hr';
}

/**
 * Markdown 元素
 */
export interface MarkdownElement {
  tag: 'div' | 'markdown';
  text: string;
}

/**
 * 字段元素
 */
export interface FieldElement {
  tag: 'field';
  text: PlainText;
  is_short?: boolean;
}

/**
 * Note 元素
 */
export interface NoteElement {
  tag: 'note';
  elements: Array<PlainText | LarkMarkdown>;
}

/**
 * 按钮样式
 */
export type ButtonStyle = 'primary' | 'default' | 'danger' | 'text';

/**
 * 按钮行为类型
 */
export type ButtonActionType = 'primary' | 'secondary' | 'danger';

/**
 * 按钮动作
 */
export interface ButtonAction {
  tag: 'button';
  text: PlainText;
  type?: ButtonStyle;
  value?: Record<string, unknown>;
  url?: string;
}

/**
 * 选择器选项
 */
export interface SelectOption {
  text: PlainText;
  value: string;
  selected?: boolean;
  url?: string;
}

/**
 * 选择静态选项
 */
export interface SelectStaticOption {
  text: PlainText;
  value: string;
  selected?: boolean;
}

/**
 * 选择器元素
 */
export interface SelectStaticElement {
  tag: 'select_static';
  placeholder: PlainText;
  options: SelectStaticOption[];
  value?: SelectStaticOption;
  confirm?: PlainText;
}

/**
 * 操作区域元素
 */
export interface ActionElement {
  tag: 'action';
  actions: Array<ButtonAction | SelectStaticElement>;
  layout?: 'bisected' | 'trisection' | 'flow';
}

/**
 * 卡片容器元素
 */
export interface ContainerElement {
  tag: 'container';
  margin?: string;
  elements: CardElement[];
}

/**
 * 卡片元素联合类型
 */
export type CardElement =
  | DividerElement
  | MarkdownElement
  | FieldElement
  | NoteElement
  | ActionElement
  | ContainerElement
  | { tag: string; [key: string]: unknown };

/**
 * 卡片标题
 */
export interface CardHeader {
  title: PlainText;
  subtitle?: PlainText;
  template?: CardTemplateColor;
  icon?: {
    tag: 'standard_icon';
    token: string;
    color?: string;
  };
}

/**
 * 卡片配置
 */
export interface CardConfig {
  /**
   * 卡片标题
   */
  header?: CardHeader;

  /**
   * 卡片内容元素
   */
  elements: CardElement[];

  /**
   * 是否启用卡片整体阴影效果
   */
  card_link?: {
    url: string;
    android_url?: string;
    ios_url?: string;
    pc_url?: string;
  };
}

/**
 * 消息卡片（用于发送）
 */
export interface MessageCard {
  /**
   * 消息类型，固定为 interactive
   */
  type: 'interactive';

  /**
   * 卡片内容
   */
  card: CardConfig;
}

/**
 * 卡片构建器选项
 */
export interface CardBuilderOptions {
  title?: string;
  subtitle?: string;
  color?: CardTemplateColor;
  icon?: string;
}

/**
 * 列表项
 */
export interface ListItem {
  title: string;
  content?: string;
  extra?: string;
}

/**
 * 状态卡片选项
 */
export interface StatusCardOptions {
  title: string;
  status: 'success' | 'error' | 'warning' | 'info' | 'loading';
  content?: string;
  items?: Array<{ label: string; value: string }>;
}

/**
 * 任务列表卡片选项
 */
export interface TaskListCardOptions {
  title: string;
  tasks: Array<{
    id: string;
    name: string;
    status: string;
    description?: string;
  }>;
  emptyMessage?: string;
}
