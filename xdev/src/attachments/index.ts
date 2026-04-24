// src/attachments/index.ts
// 附件处理模块
import * as fs from 'fs/promises'
import * as path from 'path'
import { createLogger } from '../utils/logger'
const logger = createLogger('attachments')
/**
 * 支持的图片类型
 */
export const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const
/**
 * 图片大小限制
 */
export const IMAGE_SIZE_LIMITS = {
  maxSize: 20 * 1024 * 1024, // 20MB
  targetSize: 2 * 1024 * 1024, // 峰值后压缩到 2MB
}
/**
 * PDF 最大页数
 */
export const PDF_MAX_PAGES = 100
/**
 * PDF 大小限制
 */
export const PDF_SIZE_LIMITS = {
  maxPdfSize: 15 * 1024 * 1024, // 15MB
}
const SUPPORT_PDF_TYPES = [
  'application/pdf',
] as const
/**
 * 图片附件
 */
export interface ImageAttachment {
  type: 'image'
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string // base64
}
/**
 * PDF 页面附件
 */
export interface PDFPageAttachment {
  type: 'pdf'
  page: number
  text: string
}
/**
 * PDF 附件
 */
export interface PDFAttachment {
  type: 'pdf'
  pages: PDFPageAttachment[]
}
/**
 * 附件类型
 */
export type Attachment = ImageAttachment | PDFAttachment
/**
 * 图片处理选项
 */
export interface ImageProcessOptions {
  maxSize?: number
  targetSize?: number
  compress?: boolean
}
const DEFAULT_IMAGE_OPTIONS: ImageProcessOptions = {
  maxSize: IMAGE_SIZE_LIMITS.maxSize,
  targetSize: IMAGE_SIZE_LIMITS.targetSize,
  compress: true,
}
/**
 * PDF 处理选项
 */
export interface PDFProcessOptions {
  maxSize?: number
  maxPages?: number
}
const DEFAULT_PDF_OPTIONS: PDFProcessOptions = {
  maxSize: PDF_SIZE_LIMITS.maxPdfSize,
  maxPages: PDF_MAX_PAGES,
}
/**
 * 检测 MIME类型
 */
export function detectMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.pdf':
      return 'application/pdf'
    default:
      return undefined
  }
}
/**
 * 处理图片
 */
export async function processImage(
  filePath: string,
  options: Partial<ImageProcessOptions> = {}
): Promise<ImageAttachment> {
  const finalOptions = { ...DEFAULT_IMAGE_OPTIONS, ...options }
  const buffer = await fs.readFile(filePath)
  const stats = await fs.stat(filePath)
  logger.debug(`读取图片: ${filePath}, 大小: ${stats.size} bytes`)
  // 检查大小限制
  const maxSize = finalOptions.maxSize ?? IMAGE_SIZE_LIMITS.maxSize
  if (stats.size > maxSize) {
    throw new Error(`图片大小超出限制: ${stats.size} > ${maxSize} bytes`)
  }
  // 检测 MIME类型
  const mimeType = detectMimeType(filePath)
  if (!mimeType || !SUPPORTED_IMAGE_TYPES.includes(mimeType as any)) {
    throw new Error(`不支持的图片类型: ${mimeType}`)
  }
  // 检查是否需要压缩
  const needsResize = finalOptions.compress && stats.size > IMAGE_SIZE_LIMITS.targetSize
  if (needsResize) {
    // 这里简单实现压缩逻辑
    // 实际实现需要使用 sharp 等图片处理库
    logger.info(`图片 ${filePath} 大小 ${stats.size} 超过限制，需要压缩`)
    // TODO: 使用 sharp 库进行压缩
    // 这里返回原数据作为示例
  }
  return {
    type: 'image',
    media_type: mimeType as ImageAttachment['media_type'],
    data: buffer.toString('base64'),
  }
}
/**
 * 处理 PDF
 */
export async function processPDF(
  filePath: string,
  pages?: number | string, // 指定页面范围，如 "1-5", "3-10"
  options: Partial<PDFProcessOptions> = {}
): Promise<PDFAttachment> {
  const finalOptions = { ...DEFAULT_PDF_OPTIONS, ...options }
  const buffer = await fs.readFile(filePath)
  const stats = await fs.stat(filePath)
  logger.debug(`读取 PDF: ${filePath}, 大小: ${stats.size} bytes`)
  // 检查大小限制
  const maxSize = finalOptions.maxSize ?? PDF_SIZE_LIMITS.maxPdfSize
  if (stats.size > maxSize) {
    throw new Error(`PDF 大小超出限制: ${stats.size} > ${maxSize} bytes`)
  }
  // 检查 MIME类型
  const mimeType = detectMimeType(filePath)
  if (mimeType !== 'application/pdf') {
    throw new Error(`不是 PDF 文件: ${mimeType}`)
  }
  // 确定要读取的页面
  const targetPages: number[] = []
  if (pages !== undefined) {
    // 解析页面范围
    if (typeof pages === 'string') {
      const rangeMatch = pages.match(/^(\d+)(?:-(\d+))?$/)
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1])
        const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : start
        for (let i = start; i <= end; i++) {
          targetPages.push(i)
        }
      }
    } else if (typeof pages === 'number') {
      targetPages.push(pages)
    }
  } else {
    // 默认读取前几页
    targetPages.push(1, 2, 3, 4, 5)
  }
  // 限制页数
  const maxPages = finalOptions.maxPages ?? PDF_MAX_PAGES
  if (targetPages.length > maxPages) {
    throw new Error(`PDF 页数超出限制: ${targetPages.length} > ${maxPages}`)
  }
  // TODO: 使用 pdf-parse 等库读取 PDF 内容
  // 这里返回模拟数据
  const pdfPages: PDFPageAttachment[] = targetPages.map((page) => ({
    type: 'pdf' as const,
    page,
    text: `[PDF 第 ${page} 页内容 - 实际需要使用 pdf-parse 库提取]`,
  }))
  logger.debug(`PDF 处理完成: ${filePath}, ${pdfPages.length} 页`)
  return {
    type: 'pdf',
    pages: pdfPages,
  }
}
