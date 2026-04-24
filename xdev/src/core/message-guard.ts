export function shouldRejectIncomingMessage(content: string, maxLength: number): boolean {
  return content.length > maxLength
}

export function buildOversizeMessageNotice(
  content: string,
  maxLength: number,
  previewLength: number,
): string {
  const preview = content.slice(0, previewLength)
  return `消息过长，已拒绝处理。\n长度: ${content.length} 字符\n限制: ${maxLength} 字符\n\n消息预览:\n${preview}...`
}
