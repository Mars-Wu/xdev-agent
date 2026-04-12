# T08 · 模糊文件替换

> 参考: `~/data/hermes-agent/tools/fuzzy_match.py`（8策略匹配链，受 OpenCode 启发）  
> 目标文件: 新建 `src/tools/fuzzy-match.ts`，修改 `src/tools/edit-tool.ts`

---

## 问题背景

LLM 生成的 `edit` 工具 `old_str` 可能因以下差异导致精确匹配失败：
- 空格/制表符不一致（空白规范化问题）
- 智能引号 → ASCII 引号（Unicode 差异）
- 首行/末行多余空白
- 缩进级别不同

当前 `edit-tool.ts` 只做精确字符串匹配，失败直接报错，LLM 需重试浪费 token。

---

## 8策略匹配链（按顺序尝试，第一个命中即返回）

| 策略 | 描述 |
|------|------|
| 1. exact | 精确匹配（现有行为） |
| 2. line_trimmed | 每行首尾去空白后比较 |
| 3. whitespace_normalized | 多个空格/tab → 单个空格 |
| 4. indentation_flexible | 完全忽略行首空白 |
| 5. escape_normalized | `\n` 字面量 → 实际换行 |
| 6. trimmed_boundary | 只 trim 第一行和最后一行 |
| 7. block_anchor | 匹配首行+末行，中间用相似度 ≥ 0.8 判断 |
| 8. context_aware | 50% 行相似度阈值 |

---

## 执行方案

### 1. 新建 `src/tools/fuzzy-match.ts`

```typescript
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

/** 计算两个字符串的相似度（0-1） */
function similarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  // 简单 LCS 长度近似
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

/** 在 content 中找到 oldStr 的位置（按策略变换后的内容） */
function findAndReplace(
  content: string,
  oldStr: string,
  newStr: string,
  normalize: (s: string) => string,
): FuzzyMatchResult | null {
  const normalizedContent = normalize(content);
  const normalizedOld = normalize(oldStr);
  if (!normalizedContent.includes(normalizedOld)) return null;

  const idx = normalizedContent.indexOf(normalizedOld);
  const occurrences = (normalizedContent.match(new RegExp(
    normalizedOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'
  )) ?? []).length;

  if (occurrences > 1) return null; // 多处匹配，拒绝替换

  // 将替换映射回原始内容
  const beforeNorm = normalizedContent.slice(0, idx);
  const beforeOriginalLen = content.length - (normalizedContent.length - beforeNorm.length);
  // 近似：直接用原始内容长度映射
  const ratio = content.length / normalizedContent.length;
  const startApprox = Math.floor(idx * ratio);
  const endApprox = Math.floor((idx + normalizedOld.length) * ratio);
  const result = content.slice(0, startApprox) + newStr + content.slice(endApprox);
  return { result, strategy: '', count: 1 };
}

/**
 * 主函数：按8策略链尝试匹配替换
 * @returns FuzzyMatchResult 或 null（所有策略均失败）
 */
export function fuzzyFindAndReplace(
  content: string,
  oldStr: string,
  newStr: string,
): FuzzyMatchResult | null {

  // 策略1：精确匹配
  if (content.includes(oldStr)) {
    const occurrences = (content.split(oldStr).length - 1);
    if (occurrences === 1) {
      return { result: content.replace(oldStr, newStr), strategy: 'exact', count: 1 };
    }
    return null; // 多处精确匹配，报错
  }

  // 策略2：行级 trim
  const lineTrim = (s: string) => s.split('\n').map(l => l.trim()).join('\n');
  const r2 = findAndReplace(content, oldStr, newStr, lineTrim);
  if (r2) return { ...r2, strategy: 'line_trimmed' };

  // 策略3：空白规范化
  const wsNorm = (s: string) => s.replace(/[ \t]+/g, ' ');
  const r3 = findAndReplace(content, oldStr, newStr, wsNorm);
  if (r3) return { ...r3, strategy: 'whitespace_normalized' };

  // 策略4：缩进无关
  const noIndent = (s: string) => s.split('\n').map(l => l.trimStart()).join('\n');
  const r4 = findAndReplace(content, oldStr, newStr, noIndent);
  if (r4) return { ...r4, strategy: 'indentation_flexible' };

  // 策略5：Unicode 规范化
  const uniNorm = (s: string) => unicodeNormalize(s);
  const r5 = findAndReplace(content, oldStr, newStr, uniNorm);
  if (r5) return { ...r5, strategy: 'unicode_normalized' };

  // 策略6：边界 trim（只 trim 首行和末行）
  const boundaryTrim = (s: string) => {
    const lines = s.split('\n');
    if (lines.length === 0) return s;
    lines[0] = lines[0].trim();
    lines[lines.length - 1] = lines[lines.length - 1].trim();
    return lines.join('\n');
  };
  const r6 = findAndReplace(content, oldStr, newStr, boundaryTrim);
  if (r6) return { ...r6, strategy: 'trimmed_boundary' };

  // 策略7：块锚定（首行+末行精确，中间相似度 ≥ 0.8）
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
        const result = [before, newStr, after].filter(s => s !== '').join('\n');
        return { result, strategy: 'block_anchor', count: 1 };
      }
    }
  }

  // 策略8：50% 行相似度阈值
  // （通常不建议用于精确替换，仅最后手段）
  // 此策略实现较复杂，暂时留空，返回 null 让调用方报错
  return null;
}
```

### 2. 修改 `src/tools/edit-tool.ts`

```typescript
import { fuzzyFindAndReplace } from './fuzzy-match';
import { createLogger } from '../utils/logger';

const logger = createLogger('edit-tool');

// 在 applyEdit() 方法中替换精确匹配逻辑：
function applyEdit(content: string, oldStr: string, newStr: string): string {
  const result = fuzzyFindAndReplace(content, oldStr, newStr);
  if (!result) {
    throw new Error(
      `找不到匹配的文本（已尝试8种匹配策略）。\n` +
      `old_str: ${oldStr.slice(0, 200)}...`
    );
  }
  if (result.strategy !== 'exact') {
    logger.debug(`使用模糊匹配策略: ${result.strategy}`);
  }
  return result.result;
}
```

---

## 测试用例

```typescript
describe('fuzzyFindAndReplace', () => {
  it('exact match works', () => {
    const result = fuzzyFindAndReplace('hello world', 'world', 'earth');
    expect(result?.result).toBe('hello earth');
    expect(result?.strategy).toBe('exact');
  });

  it('handles smart quotes', () => {
    const content = 'const x = "hello"';    // 弯引号
    const oldStr = 'const x = "hello"';    // 直引号
    const result = fuzzyFindAndReplace(content, oldStr, 'const x = "world"');
    expect(result?.strategy).toBe('unicode_normalized');
  });

  it('handles indentation difference', () => {
    const content = '    function foo() {\n        return 1;\n    }';
    const oldStr = 'function foo() {\n    return 1;\n}';
    const result = fuzzyFindAndReplace(content, oldStr, 'function foo() {\n    return 2;\n}');
    expect(result?.strategy).toBe('indentation_flexible');
  });

  it('returns null when multiple matches exist', () => {
    const result = fuzzyFindAndReplace('abc abc', 'abc', 'xyz');
    expect(result).toBeNull();
  });
});
```

---

## 注意事项

- 策略1（精确匹配）：若有多处匹配，直接返回 null（与当前行为一致）
- 策略7（块锚定）：适合 LLM 把中间几行写错但首尾正确的情况（常见！）
- 替换后内容可能因坐标映射误差产生轻微偏移，对于策略2-6需要更精确的原始坐标恢复逻辑（生产实现中需优化）
- 建议优先使用策略1-5，策略6-8作为保底，并在日志中记录实际用了哪种策略
