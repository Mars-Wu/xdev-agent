// src/tools/fuzzy-match.ts
// 8策略模糊匹配链，提升 LLM 生成 old_str 的成功率
// 参考: hermes-agent/tools/fuzzy_match.py（受 OpenCode 启发）

// Unicode 同义字符映射（LLM 常用的"智能"字符）
const UNICODE_MAP: Record<string, string> = {
  '\u201c': '"', '\u201d': '"',   // 弯引号 → 直引号
  '\u2018': "'", '\u2019': "'",   // 弯单引号 → 直单引号
  '\u2014': '--', '\u2013': '-',  // 破折号 → ASCII 破折号
  '\u2026': '...', '\u00a0': ' ', // 省略号、不换行空格
};

function unicodeNormalize(text: string): string {
  let result = text;
  for (const [char, repl] of Object.entries(UNICODE_MAP)) {
    result = result.split(char).join(repl);
  }
  return result;
}

/** 计算两个字符串的相似度（0-1），基于最长公共子序列近似 */
function similarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  let matches = 0;
  let si = 0;
  for (let i = 0; i < longer.length && si < shorter.length; i++) {
    if (longer[i] === shorter[si]) { matches++; si++; }
  }
  return (2.0 * matches) / (longer.length + shorter.length);
}

export interface FuzzyMatchResult {
  result: string;
  strategy: string;
  count: number;
}

/**
 * 将规范化后的匹配位置映射回原始内容并执行替换
 * 通过逐行对比原始和规范化内容，找到精确的替换范围
 */
function normalizedFindAndReplace(
  content: string,
  oldStr: string,
  newStr: string,
  normalize: (s: string) => string,
): FuzzyMatchResult | null {
  const normalizedContent = normalize(content);
  const normalizedOld = normalize(oldStr);

  if (!normalizedContent.includes(normalizedOld)) return null;

  // 确保唯一匹配
  const escapedNorm = normalizedOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const occurrences = (normalizedContent.match(new RegExp(escapedNorm, 'g')) ?? []).length;
  if (occurrences > 1) return null;

  // 通过行级对齐将规范化位置映射回原始内容
  const originalLines = content.split('\n');
  const normalizedLines = normalizedContent.split('\n');
  const oldNormLines = normalizedOld.split('\n');

  // 在规范化内容的行中寻找 oldStr 的起始行
  let startLineIdx = -1;
  outer: for (let i = 0; i <= normalizedLines.length - oldNormLines.length; i++) {
    for (let j = 0; j < oldNormLines.length; j++) {
      if (normalizedLines[i + j] !== oldNormLines[j]) continue outer;
    }
    startLineIdx = i;
    break;
  }

  if (startLineIdx === -1) {
    // 行对齐失败，降级到字符偏移近似映射
    const idx = normalizedContent.indexOf(normalizedOld);
    const ratio = content.length / (normalizedContent.length || 1);
    const start = Math.floor(idx * ratio);
    const end = Math.floor((idx + normalizedOld.length) * ratio);
    const result = content.slice(0, start) + newStr + content.slice(end);
    return { result, strategy: '', count: 1 };
  }

  const endLineIdx = startLineIdx + oldNormLines.length;
  const beforeLines = originalLines.slice(0, startLineIdx);
  const afterLines = originalLines.slice(endLineIdx);

  const before = beforeLines.length > 0 ? beforeLines.join('\n') + '\n' : '';
  const after = afterLines.length > 0 ? '\n' + afterLines.join('\n') : '';
  const result = before + newStr + after;
  return { result, strategy: '', count: 1 };
}

/**
 * 主函数：按8策略链尝试匹配替换
 * 策略按精确度递减排列，第一个命中即返回
 * @returns FuzzyMatchResult 或 null（所有策略均失败）
 */
export function fuzzyFindAndReplace(
  content: string,
  oldStr: string,
  newStr: string,
): FuzzyMatchResult | null {

  // 策略1：精确匹配（现有行为）
  if (content.includes(oldStr)) {
    const count = content.split(oldStr).length - 1;
    if (count > 1) return null; // 多处匹配，拒绝替换
    return { result: content.replace(oldStr, newStr), strategy: 'exact', count: 1 };
  }

  // 策略2：行级 trim（每行首尾去空白）
  const lineTrim = (s: string) => s.split('\n').map(l => l.trim()).join('\n');
  const r2 = normalizedFindAndReplace(content, oldStr, newStr, lineTrim);
  if (r2) return { ...r2, strategy: 'line_trimmed' };

  // 策略3：空白规范化（多个空格/tab → 单个空格）
  const wsNorm = (s: string) => s.replace(/[ \t]+/g, ' ');
  const r3 = normalizedFindAndReplace(content, oldStr, newStr, wsNorm);
  if (r3) return { ...r3, strategy: 'whitespace_normalized' };

  // 策略4：缩进无关（完全忽略行首空白）
  const noIndent = (s: string) => s.split('\n').map(l => l.trimStart()).join('\n');
  const r4 = normalizedFindAndReplace(content, oldStr, newStr, noIndent);
  if (r4) return { ...r4, strategy: 'indentation_flexible' };

  // 策略5：Unicode 规范化（智能引号 → ASCII 引号等）
  const r5 = normalizedFindAndReplace(content, oldStr, newStr, unicodeNormalize);
  if (r5) return { ...r5, strategy: 'unicode_normalized' };

  // 策略6：边界 trim（只 trim 第一行和最后一行）
  const boundaryTrim = (s: string) => {
    const lines = s.split('\n');
    if (lines.length === 0) return s;
    lines[0] = lines[0].trim();
    lines[lines.length - 1] = lines[lines.length - 1].trim();
    return lines.join('\n');
  };
  const r6 = normalizedFindAndReplace(content, oldStr, newStr, boundaryTrim);
  if (r6) return { ...r6, strategy: 'trimmed_boundary' };

  // 策略7：块锚定（首行+末行精确匹配，中间行相似度 ≥ 0.8）
  const oldLines = oldStr.split('\n');
  const contentLines = content.split('\n');
  if (oldLines.length >= 3) {
    const firstLine = oldLines[0].trim();
    const lastLine = oldLines[oldLines.length - 1].trim();
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      if (contentLines[i].trim() !== firstLine) continue;
      if (contentLines[i + oldLines.length - 1].trim() !== lastLine) continue;
      const middle = contentLines.slice(i + 1, i + oldLines.length - 1).join('\n');
      const oldMiddle = oldLines.slice(1, -1).join('\n');
      if (similarity(middle, oldMiddle) >= 0.8) {
        const before = contentLines.slice(0, i).join('\n');
        const after = contentLines.slice(i + oldLines.length).join('\n');
        const parts = [before, newStr, after].filter(s => s !== '');
        return { result: parts.join('\n'), strategy: 'block_anchor', count: 1 };
      }
    }
  }

  // 策略8：组合规范化（行级 trim + Unicode 规范化）
  const combined = (s: string) => unicodeNormalize(s).split('\n').map(l => l.trim()).join('\n');
  const r8 = normalizedFindAndReplace(content, oldStr, newStr, combined);
  if (r8) return { ...r8, strategy: 'combined_normalized' };

  return null;
}
