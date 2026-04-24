// src/prompt/sections/output-style.ts
// 输出样式模块

/**
 * 输出样式类型
 */
export type OutputStyle = 'default' | 'explanatory' | 'learning' | 'concise'

/**
 * 输出样式配置
 */
export interface OutputStyleConfig {
  style: OutputStyle
  enabled: boolean
}

/**
 * 输出样式 Prompt 片段
 */
export const OUTPUT_STYLE_PROMPTS: Record<OutputStyle, string | null> = {
  /**
   * 默认样式 - 简洁直接
   */
  default: null,

  /**
   * 解释型 - 提供教育性洞察
   */
  explanatory: `
## Insights
在关键操作后，提供教育性洞察：
\`\`\`★ Insight ─────────────────────────────────────\`\`\`
[2-3 个关键教育点，帮助用户理解背后的原理]
\`\`\`─────────────────────────────────────────────────\`\`\`

关注：
- 为什么这样做（原理）
- 有什么替代方案（权衡）
- 什么时候需要注意（边界情况）
`,

  /**
   * 学习型 - 让用户动手参与
   */
  learning: `
## Learn by Doing
对于复杂任务，分解为可学习的小步骤：

**Context:** [背景说明]
**Your Task:** [具体的小任务，2-10 行代码]
**Guidance:** [提示和方向，但不直接给出答案]
**Hint:** [可选：如果用户卡住，提供提示]

原则：
- 让用户贡献代码，而不是完全代劳
- 提供足够的上下文让用户理解
- 给出清晰的验证方法
`,

  /**
   * 极简型 - 最少输出
   */
  concise: `
## Concise Output
- 只输出必要信息
- 省略解释性文字
- 使用最少的文字完成任务
- 工具调用之间不超过 10 个字
`,
}

/**
 * 获取输出样式 Prompt
 */
export function getOutputStylePrompt(style: OutputStyle): string | null {
  return OUTPUT_STYLE_PROMPTS[style]
}

/**
 * 构建输出样式部分
 */
export function buildOutputStyleSection(style: OutputStyle): string {
  const prompt = getOutputStylePrompt(style)
  if (!prompt) {
    return ''
  }
  return prompt.trim()
}

/**
 * 输出样式管理器
 */
export class OutputStyleManager {
  private currentStyle: OutputStyle = 'default'

  /**
   * 设置输出样式
   */
  setStyle(style: OutputStyle): void {
    this.currentStyle = style
  }

  /**
   * 获取当前样式
   */
  getStyle(): OutputStyle {
    return this.currentStyle
  }

  /**
   * 获取当前样式的 Prompt
   */
  getCurrentPrompt(): string | null {
    return getOutputStylePrompt(this.currentStyle)
  }

  /**
   * 是否启用样式（非默认）
   */
  isStyleEnabled(): boolean {
    return this.currentStyle !== 'default'
  }
}

// 单例
let outputStyleManagerInstance: OutputStyleManager | null = null

export function getOutputStyleManager(): OutputStyleManager {
  if (!outputStyleManagerInstance) {
    outputStyleManagerInstance = new OutputStyleManager()
  }
  return outputStyleManagerInstance
}

export function resetOutputStyleManager(): void {
  outputStyleManagerInstance = null
}
