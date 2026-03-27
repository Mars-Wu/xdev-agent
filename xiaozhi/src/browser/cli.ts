#!/usr/bin/env node
// src/browser/cli.ts
// 浏览器工具命令行接口
// 小智和专家可以通过执行此脚本使用浏览器功能

import { createBrowserTool, BrowserResult } from './tool';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  const browser = createBrowserTool();

  try {
    let result: BrowserResult;

    switch (command) {
      case 'visit': {
        const url = args[1];
        if (!url) {
          console.error('用法: node cli.js visit <url> [--screenshot] [--fullpage]');
          process.exit(1);
        }
        const screenshot = args.includes('--screenshot');
        const fullPage = args.includes('--fullpage');
        result = await browser.visit(url, { screenshot, fullPage });
        break;
      }

      case 'click': {
        const url = args[1];
        const selector = args[2];
        if (!url || !selector) {
          console.error('用法: node cli.js click <url> <selector> [--screenshot]');
          process.exit(1);
        }
        const screenshot = args.includes('--screenshot');
        result = await browser.action(url, [
          { type: 'click', selector },
        ], { screenshot });
        break;
      }

      case 'fill': {
        const url = args[1];
        const selector = args[2];
        const value = args[3];
        if (!url || !selector || !value) {
          console.error('用法: node cli.js fill <url> <selector> <value> [--screenshot]');
          process.exit(1);
        }
        const screenshot = args.includes('--screenshot');
        result = await browser.action(url, [
          { type: 'fill', selector, value },
        ], { screenshot });
        break;
      }

      case 'check': {
        const url = args[1];
        const selector = args[2];
        if (!url || !selector) {
          console.error('用法: node cli.js check <url> <selector>');
          process.exit(1);
        }
        const checkResult = await browser.checkElement(url, selector);
        console.log(JSON.stringify(checkResult, null, 2));
        await browser.close();
        return;
      }

      case 'help':
      default:
        console.log(`
浏览器工具 - 小智浏览器自动化

用法:
  node cli.js <command> [options]

命令:
  visit <url>              访问页面，获取结构化数据
    --screenshot           保存截图到 ~/data/tmp/
    --fullpage             全页截图

  click <url> <selector>   点击元素
    --screenshot           保存截图

  fill <url> <selector> <value>  填写表单
    --screenshot           保存截图

  check <url> <selector>   检查元素是否存在

示例:
  node cli.js visit https://example.com
  node cli.js visit https://example.com --screenshot
  node cli.js click https://example.com "button.submit"
  node cli.js fill https://example.com "#search" "hello world"
  node cli.js check https://example.com "h1.title"
`);
        await browser.close();
        return;
    }

    // 输出结果
    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    console.error('错误:', error);
  } finally {
    await browser.close();
  }
}

main();
