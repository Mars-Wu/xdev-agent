// src/feishu/markdown-to-post.ts
// 将 Markdown 文本转换为飞书 post 富文本格式
//
// 飞书 post 格式结构：
// { zh_cn: { title: "", content: [ [element, ...], ... ] } }
// 每个内层数组是一个"段落"，每个 element 是段落内的行内元素。

// ---- 飞书 post 元素类型 ----

export type PostTextElement = {
  tag: 'text';
  text: string;
  bold?: true;
  italic?: true;
  inline_code?: true;
};

export type PostLinkElement = {
  tag: 'a';
  text: string;
  href: string;
};

export type PostCodeBlockElement = {
  tag: 'code_block';
  language: string;
  text: string;
};

export type PostElement = PostTextElement | PostLinkElement | PostCodeBlockElement;

export type PostParagraph = PostElement[];

export interface FeishuPostContent {
  zh_cn: {
    title: string;
    content: PostParagraph[];
  };
}

// ---- 行内 Markdown 解析 ----

/**
 * 解析行内 Markdown（加粗、斜体、行内代码、链接），返回 PostElement[]
 * 不处理跨行语法，只处理单行内容。
 */
function parseInline(text: string): PostElement[] {
  const elements: PostElement[] = [];
  // 匹配顺序：链接 > 行内代码 > 加粗 > 斜体
  const re = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
  let lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // 匹配前的普通文本
    if (m.index > lastIndex) {
      const plain = text.slice(lastIndex, m.index);
      if (plain) elements.push({ tag: 'text', text: plain });
    }

    if (m[1] !== undefined) {
      // 链接 [text](url)
      elements.push({ tag: 'a', text: m[1], href: m[2] });
    } else if (m[3] !== undefined) {
      // 行内代码 `code`
      elements.push({ tag: 'text', text: m[3], inline_code: true });
    } else if (m[4] !== undefined) {
      // 加粗 **text**
      elements.push({ tag: 'text', text: m[4], bold: true });
    } else if (m[5] !== undefined || m[6] !== undefined) {
      // 斜体 *text* 或 _text_
      elements.push({ tag: 'text', text: (m[5] ?? m[6])!, italic: true });
    }
    lastIndex = m.index + m[0].length;
  }

  // 尾部剩余文本
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex);
    if (tail) elements.push({ tag: 'text', text: tail });
  }

  // 全文无任何 Markdown 语法时直接返回纯文本
  if (elements.length === 0 && text) {
    elements.push({ tag: 'text', text });
  }

  return elements;
}

// ---- 整体 Markdown → post 转换 ----

/**
 * 将 Markdown 字符串转换为飞书 post 富文本内容对象。
 * 支持：标题、加粗、斜体、行内代码、代码块、有序/无序列表、链接、水平分隔线。
 */
export function markdownToPost(markdown: string, title = ''): FeishuPostContent {
  const lines = markdown.split('\n');
  const paragraphs: PostParagraph[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 代码块 ```lang
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim() || 'text';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 跳过结束的 ```
      paragraphs.push([{
        tag: 'code_block',
        language: lang,
        text: codeLines.join('\n'),
      }]);
      continue;
    }

    // 标题 # ## ###
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const el: PostTextElement = { tag: 'text', text: headingText, bold: true };
      // 一级标题若 title 为空时提升为文档标题
      if (level === 1 && !title) {
        // 已作为 title 处理，不加入 content（外层逻辑处理）
        // 这里仍加入 content 作为醒目段落
      }
      paragraphs.push([el]);
      i++;
      continue;
    }

    // 水平分隔线 --- 或 ***
    if (/^[-*]{3,}$/.test(line.trim())) {
      paragraphs.push([{ tag: 'text', text: '─'.repeat(20) }]);
      i++;
      continue;
    }

    // 无序列表 - item 或 * item
    const ulMatch = line.match(/^(\s*)[*\-+]\s+(.+)/);
    if (ulMatch) {
      const indent = ulMatch[1].length;
      const bullet = indent > 0 ? '  •' : '•';
      const inlineEls = parseInline(ulMatch[2]);
      paragraphs.push([{ tag: 'text', text: `${bullet} ` }, ...inlineEls]);
      i++;
      continue;
    }

    // 有序列表 1. item
    const olMatch = line.match(/^\s*(\d+)\.\s+(.+)/);
    if (olMatch) {
      const inlineEls = parseInline(olMatch[2]);
      paragraphs.push([{ tag: 'text', text: `${olMatch[1]}. ` }, ...inlineEls]);
      i++;
      continue;
    }

    // 空行 → 空段落（换行间距）
    if (line.trim() === '') {
      // 避免连续多个空段落
      if (paragraphs.length > 0 && paragraphs[paragraphs.length - 1].length !== 0) {
        paragraphs.push([]);
      }
      i++;
      continue;
    }

    // 普通段落（含行内 Markdown）
    const inlineEls = parseInline(line);
    if (inlineEls.length > 0) {
      paragraphs.push(inlineEls);
    }
    i++;
  }

  // 移除尾部多余空段落
  while (paragraphs.length > 0 && paragraphs[paragraphs.length - 1].length === 0) {
    paragraphs.pop();
  }

  // 如果段落为空，兜底返回纯文本段落
  if (paragraphs.length === 0) {
    paragraphs.push([{ tag: 'text', text: markdown }]);
  }

  return {
    zh_cn: {
      title,
      content: paragraphs,
    },
  };
}
