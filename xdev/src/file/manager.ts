// src/file/manager.ts
// 文件管理器 - 负责文件下载、存储和元数据管理

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { createLogger } from '../utils/logger';
import { DownloadedFile, FeishuMsgType } from '../feishu/types';

const logger = createLogger('file-manager');

// 文件存储配置
const FILES_DIR = path.join(process.env.HOME || '/tmp', '.xdev', 'files');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// 文件类型白名单
const ALLOWED_MIME_TYPES: Set<string> = new Set([
  // PDF
  'application/pdf',
  // Word
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  // Excel
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  // 图片
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

// MIME 类型到文件扩展名映射
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

// 扩展名到 MIME 类型映射（用于推断）
const EXT_TO_MIME: Record<string, string> = {
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'txt': 'text/plain',
  'csv': 'text/csv',
};

// 支持的文件扩展名白名单
const ALLOWED_EXTENSIONS: Set<string> = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'csv'
]);

// 文件信息接口
export interface FileInfo {
  id: string;
  originalName: string;
  localPath: string;
  mimeType: string;
  size: number;
  chatId: string;
  messageId: string;
  createdAt: Date;
}

/**
 * 文件管理器
 * 负责从飞书下载文件并保存到本地
 */
export class FileManager {
  private downloadFileFn: (fileKey: string, messageId: string, type: string) => Promise<Buffer>;

  constructor(
    downloadFileFn: (fileKey: string, messageId: string, type: string) => Promise<Buffer>,
    private saveFileMetadata: (file: FileInfo) => void
  ) {
    this.downloadFileFn = downloadFileFn;
    this.ensureFilesDir();
  }

  /**
   * 确保文件目录存在
   */
  private async ensureFilesDir(): Promise<void> {
    try {
      await fs.mkdir(FILES_DIR, { recursive: true });
      logger.debug(`文件目录已准备: ${FILES_DIR}`);
    } catch (error) {
      logger.error('创建文件目录失败:', error);
    }
  }

  /**
   * 下载并保存文件
   */
  async downloadAndSave(
    fileKey: string,
    msgType: FeishuMsgType,
    originalName: string,
    mimeType: string,
    expectedSize: number,
    chatId: string,
    messageId: string
  ): Promise<DownloadedFile> {
    // 检查文件大小（如果未知则跳过检查，下载后会有实际大小）
    if (expectedSize > 0 && expectedSize > MAX_FILE_SIZE) {
      throw new Error(`文件过大 (${this.formatBytes(expectedSize)})，最大支持 ${this.formatBytes(MAX_FILE_SIZE)}`);
    }

    // 获取文件扩展名
    const ext = this.extractExtension(originalName).replace('.', '').toLowerCase();

    // 如果 MIME 类型不在白名单中，尝试根据扩展名推断
    let finalMimeType = mimeType;
    if (!ALLOWED_MIME_TYPES.has(mimeType) && ext && EXT_TO_MIME[ext]) {
      finalMimeType = EXT_TO_MIME[ext];
      logger.info(`根据扩展名推断 MIME 类型: ${ext} -> ${finalMimeType}`);
    }

    // 检查文件类型（MIME 类型或扩展名）
    const isAllowedMimeType = ALLOWED_MIME_TYPES.has(finalMimeType);
    const isAllowedExtension = ALLOWED_EXTENSIONS.has(ext);
    if (!isAllowedMimeType && !isAllowedExtension) {
      throw new Error(`不支持的文件类型: ${mimeType} (扩展名: ${ext || '未知'})`);
    }

    // 下载文件（传入 messageId）
    logger.info(`开始下载文件: ${originalName} (${expectedSize > 0 ? this.formatBytes(expectedSize) : '大小未知'})`);
    const buffer = await this.downloadFileFn(fileKey, messageId, msgType === 'image' ? 'image' : 'file');

    // 生成文件 ID 和本地路径
    const fileId = this.generateFileId();
    const fileExt = MIME_TO_EXT[finalMimeType] || `.${ext}`;
    const safeName = this.sanitizeFileName(originalName);
    const localName = `${fileId}_${safeName}${fileExt}`;
    const localPath = path.join(FILES_DIR, localName);

    // 保存文件
    await fs.writeFile(localPath, buffer);
    logger.info(`文件已保存: ${localPath}`);

    // 构建文件信息
    const fileInfo: FileInfo = {
      id: fileId,
      originalName,
      localPath,
      mimeType: finalMimeType,
      size: buffer.length,
      chatId,
      messageId,
      createdAt: new Date(),
    };

    // 保存元数据
    this.saveFileMetadata(fileInfo);

    return {
      localPath,
      originalName,
      mimeType: finalMimeType,
      size: buffer.length,
      chatId,
      messageId,
      fileId,
    };
  }

  /**
   * 获取文件信息
   */
  async getFileInfo(fileId: string): Promise<FileInfo | null> {
    // 这个方法需要从数据库查询，由外部提供
    // 暂时返回 null，实际使用时由 Agent 调用 Storage
    return null;
  }

  /**
   * 删除文件
   */
  async deleteFile(localPath: string): Promise<boolean> {
    try {
      await fs.unlink(localPath);
      logger.info(`文件已删除: ${localPath}`);
      return true;
    } catch (error) {
      logger.error(`删除文件失败: ${localPath}`, error);
      return false;
    }
  }

  /**
   * 列出文件目录中的所有文件
   */
  async listFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(FILES_DIR);
      return files;
    } catch (error) {
      logger.error('列出文件失败:', error);
      return [];
    }
  }

  /**
   * 清理过期文件
   */
  async cleanupOldFiles(retentionDays: number): Promise<number> {
    const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    try {
      const files = await fs.readdir(FILES_DIR);

      for (const file of files) {
        const filePath = path.join(FILES_DIR, file);
        try {
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs < cutoffTime) {
            await fs.unlink(filePath);
            deletedCount++;
            logger.debug(`已清理过期文件: ${file}`);
          }
        } catch (error) {
          // 忽略单个文件删除失败
        }
      }

      if (deletedCount > 0) {
        logger.info(`已清理 ${deletedCount} 个过期文件`);
      }
    } catch (error) {
      logger.error('清理文件失败:', error);
    }

    return deletedCount;
  }

  /**
   * 生成唯一文件 ID
   */
  private generateFileId(): string {
    return `file_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * 清理文件名（移除特殊字符）
   */
  private sanitizeFileName(name: string): string {
    // 移除路径分隔符和特殊字符
    return name
      .replace(/[\/\\]/g, '_')
      .replace(/[<>:"|?*]/g, '')
      .slice(0, 100); // 限制长度
  }

  /**
   * 从文件名提取扩展名
   */
  private extractExtension(name: string): string {
    const ext = path.extname(name);
    return ext || '';
  }

  /**
   * 格式化文件大小
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  /**
   * 获取文件存储目录
   */
  static getFilesDir(): string {
    return FILES_DIR;
  }

  /**
   * 格式化文件大小（静态方法，供外部使用）
   */
  static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }
}

export { FILES_DIR };
