// src/browser/tool.ts
// 浏览器自动化工具
// 基于 Playwright，支持 headless 模式运行

import { chromium, Browser, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createLogger } from '../utils/logger';

const logger = createLogger('browser');

/**
 * 截图保存目录
 */
const SCREENSHOT_DIR = path.join(process.env.HOME || '/home/wxy', 'data/tmp');

/**
 * 浏览器操作结果
 */
export interface BrowserResult {
  success: boolean;
  data?: {
    title?: string;
    url?: string;
    text?: string;
    elements?: PageElements;
    forms?: FormInfo[];
    links?: LinkInfo[];
    screenshot?: string;
    performance?: PerformanceInfo;
    console?: string[];
    network?: NetworkInfo[];
  };
  error?: string;
}

/**
 * 页面元素信息
 */
export interface PageElements {
  headings: Array<{ tag: string; text: string }>;
  buttons: string[];
  inputs: Array<{ type: string; name: string; placeholder: string }>;
}

/**
 * 表单信息
 */
export interface FormInfo {
  action: string;
  method: string;
  inputs: Array<{ type: string; name: string; placeholder: string; value?: string }>;
}

/**
 * 链接信息
 */
export interface LinkInfo {
  text: string;
  href: string;
}

/**
 * 性能信息
 */
export interface PerformanceInfo {
  loadTime: number;
  domContentLoaded: number;
  responseTime: number;
}

/**
 * 网络信息
 */
export interface NetworkInfo {
  url: string;
  method: string;
  status: number;
  type: string;
}

/**
 * 浏览器工具配置
 */
export interface BrowserToolConfig {
  headless?: boolean;
  timeout?: number;
  viewport?: { width: number; height: number };
}

/**
 * 浏览器自动化工具
 */
export class BrowserTool {
  private browser: Browser | null = null;
  private config: Required<BrowserToolConfig>;

  constructor(config: BrowserToolConfig = {}) {
    this.config = {
      headless: config.headless ?? true,
      timeout: config.timeout ?? 30000,
      viewport: config.viewport ?? { width: 1280, height: 720 },
    };
  }

  /**
   * 初始化浏览器
   */
  private async initBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.config.headless,
      });
      logger.info('浏览器已启动 (headless mode)');
    }
    return this.browser;
  }

  /**
   * 创建新页面
   */
  private async createPage(): Promise<Page> {
    const browser = await this.initBrowser();
    const context = await browser.newContext({
      viewport: this.config.viewport,
    });
    return await context.newPage();
  }

  /**
   * 访问页面并获取结构化数据
   */
  async visit(url: string, options: {
    screenshot?: boolean;
    fullPage?: boolean;
    waitFor?: string;
  } = {}): Promise<BrowserResult> {
    const page = await this.createPage();
    const consoleLogs: string[] = [];
    const networkLogs: NetworkInfo[] = [];
    const startTime = Date.now();

    // 监听控制台
    page.on('console', msg => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    // 监听网络
    page.on('response', response => {
      networkLogs.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        type: response.request().resourceType(),
      });
    });

    try {
      logger.info(`访问页面: ${url}`);

      // 访问页面
      const response = await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: this.config.timeout,
      });

      if (!response) {
        await page.context().close();
        return { success: false, error: '无法访问页面' };
      }

      if (response.status() >= 400) {
        await page.context().close();
        return {
          success: false,
          error: `页面返回错误: ${response.status()}`,
          data: { url, network: networkLogs },
        };
      }

      // 等待特定元素
      if (options.waitFor) {
        await page.waitForSelector(options.waitFor, { timeout: 5000 }).catch(() => {});
      }

      // 获取页面数据 - 使用字符串模板避免类型问题
      const pageData = await this.extractPageData(page);

      // 性能数据
      const performance: PerformanceInfo = {
        loadTime: Date.now() - startTime,
        domContentLoaded: 0,
        responseTime: 0,
      };

      // 截图
      let screenshotPath: string | undefined;
      if (options.screenshot) {
        screenshotPath = await this.takeScreenshot(page, options.fullPage ?? false);
      }

      await page.context().close();

      return {
        success: true,
        data: {
          ...pageData,
          console: consoleLogs.length > 0 ? consoleLogs : undefined,
          network: networkLogs.slice(0, 50),
          screenshot: screenshotPath,
          performance,
        },
      };
    } catch (error) {
      await page.context().close();
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`访问页面失败: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * 执行页面操作
   */
  async action(url: string, actions: Array<{
    type: 'click' | 'fill' | 'select' | 'wait' | 'press';
    selector: string;
    value?: string;
  }>, options: { screenshot?: boolean } = {}): Promise<BrowserResult> {
    const page = await this.createPage();

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: this.config.timeout });

      for (const action of actions) {
        switch (action.type) {
          case 'click':
            await page.click(action.selector);
            break;
          case 'fill':
            await page.fill(action.selector, action.value || '');
            break;
          case 'select':
            await page.selectOption(action.selector, action.value || '');
            break;
          case 'wait':
            await page.waitForSelector(action.selector, { timeout: 5000 });
            break;
          case 'press':
            await page.press(action.selector, action.value || 'Enter');
            break;
        }
        await page.waitForTimeout(300);
      }

      const pageData = await this.extractPageData(page);

      let screenshotPath: string | undefined;
      if (options.screenshot) {
        screenshotPath = await this.takeScreenshot(page, false);
      }

      await page.context().close();

      return {
        success: true,
        data: { ...pageData, screenshot: screenshotPath },
      };
    } catch (error) {
      await page.context().close();
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 提取页面数据 - 返回简单 JSON，避免类型问题
   */
  private async extractPageData(page: Page): Promise<{
    title: string;
    url: string;
    text: string;
    elements: PageElements;
    forms: FormInfo[];
    links: LinkInfo[];
  }> {
    // 使用字符串形式的 evaluate 函数，避免 TypeScript 类型检查
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('page', `return page.evaluate(() => {
      const title = document.title;
      const url = window.location.href;
      const text = document.body?.innerText || '';

      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map(h => ({ tag: h.tagName, text: (h.textContent || '').trim().slice(0, 200) }))
        .filter(h => h.text);

      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'))
        .map(b => (b.textContent || b.value || '').trim())
        .filter(Boolean).slice(0, 20);

      const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
        .map(i => ({ type: i.type || i.tagName.toLowerCase(), name: i.name || '', placeholder: i.placeholder || '' }))
        .filter(i => i.name || i.placeholder).slice(0, 30);

      const forms = Array.from(document.querySelectorAll('form')).map(form => ({
        action: form.action || '',
        method: form.method || 'get',
        inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(i => ({
          type: i.type || i.tagName.toLowerCase(),
          name: i.name || '',
          placeholder: i.placeholder || '',
          value: i.value || ''
        }))
      }));

      const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => ({ text: (a.textContent || '').trim().slice(0, 100), href: a.href || '' }))
        .filter(l => l.text && !l.href.startsWith('javascript:')).slice(0, 50);

      return { title, url, text, elements: { headings, buttons, inputs }, forms, links };
    })`);

    return await fn(page);
  }

  /**
   * 截图
   */
  private async takeScreenshot(page: Page, fullPage: boolean): Promise<string> {
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `screenshot-${timestamp}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);

    await page.screenshot({
      path: filepath,
      fullPage,
    });

    logger.info(`截图已保存: ${filepath}`);
    return filepath;
  }

  /**
   * 检查元素是否存在
   */
  async checkElement(url: string, selector: string): Promise<{ exists: boolean; count: number; texts: string[] }> {
    const page = await this.createPage();

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: this.config.timeout });

      const elements = await page.$$(selector);
      const texts = await Promise.all(
        elements.map(el => el.textContent().then(t => (t || '').trim()))
      );

      await page.context().close();

      return {
        exists: elements.length > 0,
        count: elements.length,
        texts: texts.filter(Boolean),
      };
    } catch (error) {
      await page.context().close();
      return { exists: false, count: 0, texts: [] };
    }
  }

  /**
   * 关闭浏览器
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info('浏览器已关闭');
    }
  }
}

/**
 * 创建浏览器工具实例
 */
export function createBrowserTool(config?: BrowserToolConfig): BrowserTool {
  return new BrowserTool(config);
}
