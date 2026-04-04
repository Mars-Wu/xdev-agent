// src/feishu/markdown-to-post.test.ts

import { describe, it, expect } from 'vitest';
import { markdownToPost } from './markdown-to-post';

describe('markdownToPost', () => {
  it('纯文本段落', () => {
    const result = markdownToPost('Hello world');
    const para = result.zh_cn.content[0];
    expect(para[0]).toMatchObject({ tag: 'text', text: 'Hello world' });
  });

  it('标题转为加粗文本', () => {
    const result = markdownToPost('# 大标题');
    expect(result.zh_cn.content[0][0]).toMatchObject({ tag: 'text', text: '大标题', bold: true });
  });

  it('加粗 **text**', () => {
    const result = markdownToPost('这是 **加粗** 内容');
    const para = result.zh_cn.content[0];
    expect(para.some(el => el.tag === 'text' && (el as any).bold === true && (el as any).text === '加粗')).toBe(true);
  });

  it('斜体 *text*', () => {
    const result = markdownToPost('这是 *斜体* 内容');
    const para = result.zh_cn.content[0];
    expect(para.some(el => el.tag === 'text' && (el as any).italic === true)).toBe(true);
  });

  it('行内代码 `code`', () => {
    const result = markdownToPost('执行 `npm install` 命令');
    const para = result.zh_cn.content[0];
    expect(para.some(el => el.tag === 'text' && (el as any).inline_code === true && (el as any).text === 'npm install')).toBe(true);
  });

  it('代码块 ```lang', () => {
    const result = markdownToPost('```bash\necho hello\n```');
    const para = result.zh_cn.content[0];
    expect(para[0]).toMatchObject({ tag: 'code_block', language: 'bash', text: 'echo hello' });
  });

  it('代码块无语言标注', () => {
    const result = markdownToPost('```\nsome code\n```');
    expect(result.zh_cn.content[0][0]).toMatchObject({ tag: 'code_block', language: 'text' });
  });

  it('链接 [text](url)', () => {
    const result = markdownToPost('[飞书](https://feishu.cn)');
    const para = result.zh_cn.content[0];
    expect(para[0]).toMatchObject({ tag: 'a', text: '飞书', href: 'https://feishu.cn' });
  });

  it('无序列表 - item', () => {
    const result = markdownToPost('- 苹果\n- 香蕉');
    expect(result.zh_cn.content).toHaveLength(2);
    expect((result.zh_cn.content[0][0] as any).text).toContain('•');
  });

  it('有序列表 1. item', () => {
    const result = markdownToPost('1. 第一步\n2. 第二步');
    expect((result.zh_cn.content[0][0] as any).text).toBe('1. ');
    expect((result.zh_cn.content[1][0] as any).text).toBe('2. ');
  });

  it('水平分隔线', () => {
    const result = markdownToPost('---');
    expect((result.zh_cn.content[0][0] as any).text).toContain('─');
  });

  it('空行不产生连续空段落', () => {
    const result = markdownToPost('第一段\n\n\n\n第二段');
    // 两段内容 + 最多一个空段落分隔
    const emptyCount = result.zh_cn.content.filter(p => p.length === 0).length;
    expect(emptyCount).toBeLessThanOrEqual(1);
  });

  it('title 参数正确设置', () => {
    const result = markdownToPost('内容', '我的标题');
    expect(result.zh_cn.title).toBe('我的标题');
  });

  it('空字符串兜底返回', () => {
    const result = markdownToPost('');
    // 不应抛异常，content 可以为空或有兜底段落
    expect(result.zh_cn).toBeDefined();
  });

  it('混合格式段落', () => {
    const md = '## 标题\n\n**加粗** 和 `代码` 以及 [链接](https://x.com)';
    const result = markdownToPost(md);
    // 至少有两个段落（标题 + 混合行）
    expect(result.zh_cn.content.length).toBeGreaterThanOrEqual(2);
  });
});
