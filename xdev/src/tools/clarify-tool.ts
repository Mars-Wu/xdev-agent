// src/tools/clarify-tool.ts
// 结构化多选题交互工具：让 LLM 向用户提问以澄清任务歧义
// 参考: hermes-agent/tools/clarify_tool.py

import { createLogger } from '../utils/logger';

const logger = createLogger('clarify-tool');

export const CLARIFY_TOOL_DEFINITION = {
  name: 'clarify',
  description:
    '向用户提问以澄清任务歧义。支持多选题或开放式问题。' +
    '在继续工作前需要用户确认重要决策时使用。' +
    '不要在每轮都调用，只在真正有歧义或需要用户确认时使用。',
  input_schema: {
    type: 'object' as const,
    properties: {
      question: {
        type: 'string',
        description: '向用户提出的问题',
      },
      choices: {
        type: 'array',
        items: { type: 'string' },
        description: '最多4个预设选项（可选）。会自动追加"其他"选项。',
        maxItems: 4,
      },
    },
    required: ['question'],
  },
};

export interface ClarifyInput {
  question: string;
  choices?: string[];
}

export interface ClarifyResult {
  question: string;
  choices_offered: string[] | null;
  user_response: string;
}

/**
 * 平台交互回调类型
 * 由平台层注入（飞书消息 / CLI）
 * 返回用户的回复文本（超时应 reject）
 */
export type ClarifyCallback = (question: string, choices: string[] | null) => Promise<string>;

let _callback: ClarifyCallback | null = null;

/** 注入平台回调（在 src/index.ts 启动时调用） */
export function setClarifyCallback(cb: ClarifyCallback): void {
  _callback = cb;
}

/** Clarify 工具执行函数 */
export async function executeClarify(input: ClarifyInput): Promise<string> {
  const { question, choices } = input;

  if (!question?.trim()) {
    return JSON.stringify({ error: 'question 不能为空' });
  }

  if (!_callback) {
    return JSON.stringify({ error: 'Clarify 工具在当前上下文不可用（未注入平台回调）' });
  }

  const trimmedChoices =
    choices
      ?.slice(0, 4)
      .map((c) => c.trim())
      .filter(Boolean) ?? null;

  try {
    const userResponse = await _callback(question.trim(), trimmedChoices && trimmedChoices.length > 0 ? trimmedChoices : null);
    const result: ClarifyResult = {
      question: question.trim(),
      choices_offered: trimmedChoices && trimmedChoices.length > 0 ? trimmedChoices : null,
      user_response: userResponse.trim(),
    };
    return JSON.stringify(result, null, 2);
  } catch (error: any) {
    logger.warn(`Clarify 工具交互失败: ${error.message}`);
    return JSON.stringify({ error: `获取用户输入失败: ${error.message}` });
  }
}
