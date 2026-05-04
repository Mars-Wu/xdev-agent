// src/core/vision.ts
// 图片视觉分析：使用智谱原生 OpenAI 兼容 API（glm-5v-turbo）
// 注意：文本 provider 可切换，但视觉仍单独走 GLM 原生端点

import { createLogger } from '../utils/logger';
import { getDefaultVisionModelId } from './model-catalog';
import { resolveVisionApiConfig } from './model-config';

const logger = createLogger('vision');

function getVisionModel(): string {
  return getDefaultVisionModelId(process.env.XDEV_VISION_MODEL);
}

/**
 * 用智谱视觉模型分析图片，返回文字描述
 * @param imageBuffer 图片二进制数据
 * @param mediaType MIME 类型（如 image/jpeg）
 * @param userQuestion 用户附带的文字问题（可选）
 */
export async function analyzeImage(
  imageBuffer: Buffer,
  mediaType: string,
  userQuestion?: string,
): Promise<string> {
  const visionConfig = resolveVisionApiConfig();
  if (!visionConfig.apiKey) {
    throw new Error('未配置 API Key，无法进行图片分析');
  }
  return analyzeImageWithConfig(
    visionConfig.endpoint,
    visionConfig.apiKey,
    imageBuffer,
    mediaType,
    userQuestion,
  );
}

export async function analyzeImageWithConfig(
  endpoint: string,
  apiKey: string,
  imageBuffer: Buffer,
  mediaType: string,
  userQuestion?: string,
): Promise<string> {
  const b64 = imageBuffer.toString('base64');
  const dataUrl = `data:${mediaType};base64,${b64}`;

  const prompt = userQuestion
    ? `请仔细分析这张图片，然后回答用户的问题：${userQuestion}\n\n请先描述图片内容，再回答问题。`
    : '请详细描述这张图片的内容，包括文字、数据、图表等所有可见信息。';

  const payload = {
    model: getVisionModel(),
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: dataUrl },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`视觉 API 请求失败 (${response.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('视觉 API 返回空内容');
  }

  logger.info(`图片分析完成: ${text.slice(0, 80)}...`);
  return text;
}

/**
 * 检测图片 MIME 类型（根据文件头字节）
 */
export function detectMimeType(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/jpeg'; // 飞书压缩图通常是 jpeg
}
