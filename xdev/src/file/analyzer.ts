// src/file/analyzer.ts
// 文件分析器 - 解析不同格式文件并提取内容

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('file-analyzer');

// 文件分析结果接口
export interface FileAnalysis {
  type: 'pdf' | 'word' | 'excel' | 'image' | 'unknown';
  text?: string;           // 提取的文本内容
  structured?: unknown;    // 结构化数据 (Excel 表格)
  imageBase64?: string;    // 图片 base64 (用于视觉分析)
  metadata?: {             // 文件元数据
    pages?: number;        // PDF 页数
    sheets?: string[];     // Excel 工作表名
    wordCount?: number;    // 字数
    dimensions?: string;   // 图片尺寸
    rows?: number;         // Excel 行数
    columns?: number;      // Excel 列数
  };
  summary?: string;        // 简短摘要
  error?: string;          // 解析错误
}

// 支持的 MIME 类型
const PDF_MIME_TYPES = ['application/pdf'];
const WORD_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
];
const EXCEL_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];
const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
];

/**
 * 文件分析器
 * 负责解析不同格式的文件并提取内容
 */
export class FileAnalyzer {
  /**
   * 分析文件（自动检测类型）
   */
  async analyze(filePath: string, mimeType: string): Promise<FileAnalysis> {
    try {
      // 检查文件是否存在
      await fs.access(filePath);

      // 根据 MIME 类型选择解析方法
      if (PDF_MIME_TYPES.includes(mimeType)) {
        return await this.analyzePDF(filePath);
      } else if (WORD_MIME_TYPES.includes(mimeType)) {
        return await this.analyzeWord(filePath);
      } else if (EXCEL_MIME_TYPES.includes(mimeType)) {
        return await this.analyzeExcel(filePath);
      } else if (IMAGE_MIME_TYPES.includes(mimeType)) {
        return await this.analyzeImage(filePath, mimeType);
      } else {
        return {
          type: 'unknown',
          error: `不支持的文件类型: ${mimeType}`,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`文件分析失败: ${filePath}`, error);
      return {
        type: 'unknown',
        error: message,
      };
    }
  }

  /**
   * 解析 PDF 文件
   */
  private async analyzePDF(filePath: string): Promise<FileAnalysis> {
    try {
      const pdfParse = require('pdf-parse');
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdfParse(dataBuffer);

      // 限制文本长度
      const text = data.text?.slice(0, 50000) || '';
      const wordCount = text.length;

      logger.info(`PDF 解析完成: ${path.basename(filePath)}, ${data.numpages} 页, ${wordCount} 字`);

      return {
        type: 'pdf',
        text,
        metadata: {
          pages: data.numpages,
          wordCount,
        },
        summary: `PDF 文档，共 ${data.numpages} 页，约 ${wordCount} 字`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'PDF 解析失败';
      logger.error('PDF 解析错误:', error);
      return {
        type: 'pdf',
        error: message,
      };
    }
  }

  /**
   * 解析 Word 文档
   */
  private async analyzeWord(filePath: string): Promise<FileAnalysis> {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });

      // 限制文本长度
      const text = result.value?.slice(0, 50000) || '';
      const wordCount = text.length;

      // 获取警告信息
      const warnings = result.messages
        .filter((m: { type: string }) => m.type === 'warning')
        .map((m: { message: string }) => m.message);

      if (warnings.length > 0) {
        logger.debug('Word 解析警告:', warnings);
      }

      logger.info(`Word 解析完成: ${path.basename(filePath)}, ${wordCount} 字`);

      return {
        type: 'word',
        text,
        metadata: {
          wordCount,
        },
        summary: `Word 文档，约 ${wordCount} 字`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Word 解析失败';
      logger.error('Word 解析错误:', error);
      return {
        type: 'word',
        error: message,
      };
    }
  }

  /**
   * 解析 Excel 文件
   */
  private async analyzeExcel(filePath: string): Promise<FileAnalysis> {
    try {
      const XLSX = require('xlsx');
      const workbook = XLSX.readFile(filePath);

      const sheets: string[] = [];
      const structuredData: Record<string, unknown[][]> = {};
      let totalRows = 0;
      let totalColumns = 0;

      // 解析每个工作表
      for (const sheetName of workbook.SheetNames) {
        sheets.push(sheetName);
        const sheet = workbook.Sheets[sheetName];
        const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
        const rows = range.e.r - range.s.r + 1;
        const cols = range.e.c - range.s.c + 1;

        totalRows += rows;
        totalColumns = Math.max(totalColumns, cols);

        // 转换为 JSON 格式（限制行数）
        const jsonData = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          defval: '',
          raw: false,
        }) as unknown[][];

        // 只保留前 100 行
        structuredData[sheetName] = jsonData.slice(0, 100);
      }

      logger.info(`Excel 解析完成: ${path.basename(filePath)}, ${sheets.length} 个工作表, ${totalRows} 行`);

      // 生成预览文本
      const previewText = this.generateExcelPreview(structuredData);

      return {
        type: 'excel',
        text: previewText,
        structured: structuredData,
        metadata: {
          sheets,
          rows: totalRows,
          columns: totalColumns,
        },
        summary: `Excel 表格，包含 ${sheets.length} 个工作表 (${sheets.slice(0, 3).join(', ')}${sheets.length > 3 ? '...' : ''})，共 ${totalRows} 行`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Excel 解析失败';
      logger.error('Excel 解析错误:', error);
      return {
        type: 'excel',
        error: message,
      };
    }
  }

  /**
   * 生成 Excel 预览文本
   */
  private generateExcelPreview(data: Record<string, unknown[][]>): string {
    const lines: string[] = [];

    for (const [sheetName, rows] of Object.entries(data)) {
      lines.push(`\n【工作表: ${sheetName}】`);

      // 显示前 20 行
      const displayRows = rows.slice(0, 20);
      for (const row of displayRows) {
        if (Array.isArray(row)) {
          const rowText = row
            .map(cell => (cell === null || cell === undefined ? '' : String(cell)))
            .join(' | ');
          if (rowText.trim()) {
            lines.push(rowText);
          }
        }
      }

      if (rows.length > 20) {
        lines.push(`... (共 ${rows.length} 行)`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 分析图片文件
   * 图片不进行文本提取，而是返回路径供多模态模型处理
   */
  private async analyzeImage(filePath: string, mimeType: string): Promise<FileAnalysis> {
    try {
      const buffer = await fs.readFile(filePath);

      // 获取图片尺寸（使用简单的文件头检测）
      const dimensions = await this.getImageDimensions(buffer, mimeType);

      // 转换为 base64
      const base64 = buffer.toString('base64');

      logger.info(`图片分析完成: ${path.basename(filePath)}, 尺寸: ${dimensions}`);

      return {
        type: 'image',
        imageBase64: base64,
        metadata: {
          dimensions,
        },
        summary: `图片文件，尺寸: ${dimensions}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片分析失败';
      logger.error('图片分析错误:', error);
      return {
        type: 'image',
        error: message,
      };
    }
  }

  /**
   * 获取图片尺寸
   */
  private async getImageDimensions(buffer: Buffer, mimeType: string): Promise<string> {
    try {
      // PNG
      if (mimeType === 'image/png') {
        if (buffer.length > 24) {
          const width = buffer.readUInt32BE(16);
          const height = buffer.readUInt32BE(20);
          return `${width}x${height}`;
        }
      }

      // JPEG
      if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
        // JPEG 尺寸解析比较复杂，简化处理
        return '未知';
      }

      // GIF
      if (mimeType === 'image/gif') {
        if (buffer.length > 10) {
          const width = buffer.readUInt16LE(6);
          const height = buffer.readUInt16LE(8);
          return `${width}x${height}`;
        }
      }

      return '未知';
    } catch {
      return '未知';
    }
  }

  /**
   * 检查是否为支持的文件类型
   */
  static isSupportedMimeType(mimeType: string): boolean {
    return (
      PDF_MIME_TYPES.includes(mimeType) ||
      WORD_MIME_TYPES.includes(mimeType) ||
      EXCEL_MIME_TYPES.includes(mimeType) ||
      IMAGE_MIME_TYPES.includes(mimeType)
    );
  }

  /**
   * 获取文件类型描述
   */
  static getTypeDescription(mimeType: string): string {
    if (PDF_MIME_TYPES.includes(mimeType)) return 'PDF 文档';
    if (WORD_MIME_TYPES.includes(mimeType)) return 'Word 文档';
    if (EXCEL_MIME_TYPES.includes(mimeType)) return 'Excel 表格';
    if (IMAGE_MIME_TYPES.includes(mimeType)) return '图片';
    return '未知类型';
  }
}
