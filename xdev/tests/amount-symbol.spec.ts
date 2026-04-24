import { test, expect } from '@playwright/test';

/**
 * 测试网页中金额是否有货币符号
 * 支持检测：¥、$、€、£、₩、₽ 等常见货币符号
 */

test.describe('金额符号检测', () => {
  // 配置要测试的网页URL
  const TEST_URL = process.env.TEST_URL || 'https://example.com';

  test.beforeEach(async ({ page }) => {
    await page.goto(TEST_URL);
  });

  test('检测页面中的金额是否包含货币符号', async ({ page }) => {
    // 等待页面加载完成
    await page.waitForLoadState('networkidle');

    // 常见货币符号列表
    const currencySymbols = ['¥', '$', '€', '£', '₩', '₽', '￥', '＄', '€'];

    // 获取页面所有文本内容
    const bodyText = await page.locator('body').textContent();

    // 查找可能是金额的数字（带小数点或整数）
    const amountPattern = /(\d{1,3}(,\d{3})*(\.\d{2})?|\d+(\.\d+)?)/g;
    const amounts = bodyText?.match(amountPattern) || [];

    console.log(`找到 ${amounts.length} 个可能的数字`);

    // 检查每个金额附近是否有货币符号
    const results: Array<{
      amount: string;
      hasSymbol: boolean;
      context: string;
    }> = [];

    for (const amount of amounts) {
      // 查找金额元素
      const elements = await page.locator(`:text-matches("${amount}")`).all();

      for (const element of elements) {
        const text = await element.textContent() || '';
        const hasSymbol = currencySymbols.some(symbol => text.includes(symbol));

        if (hasSymbol || parseFloat(amount) > 10) {
          results.push({
            amount,
            hasSymbol,
            context: text.substring(0, 50)
          });
        }
      }
    }

    // 输出结果
    console.log('\n=== 金额符号检测结果 ===');
    results.forEach(result => {
      if (result.hasSymbol) {
        console.log(`✅ ${result.amount} - 有符号 - ${result.context}`);
      } else {
        console.log(`❌ ${result.amount} - 无符号 - ${result.context}`);
      }
    });

    // 统计
    const withSymbol = results.filter(r => r.hasSymbol).length;
    const withoutSymbol = results.filter(r => !r.hasSymbol).length;

    console.log(`\n统计: ${withSymbol} 个金额有符号, ${withoutSymbol} 个金额无符号`);

    // 截图保存
    await page.screenshot({ path: 'test-results/amount-check.png', fullPage: true });
  });

  test('检测特定元素的金额格式', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    // 查找可能包含金额的元素（根据实际页面调整选择器）
    const priceSelectors = [
      '.price',
      '.amount',
      '.money',
      '[class*="price"]',
      '[class*="amount"]',
      '[class*="money"]',
      'td:has-text("¥")',
      'td:has-text("$")',
      'span:has-text("¥")',
      'span:has-text("$")'
    ];

    for (const selector of priceSelectors) {
      const elements = await page.locator(selector).all();

      if (elements.length > 0) {
        console.log(`\n选择器 "${selector}" 找到 ${elements.length} 个元素:`);

        for (const element of elements) {
          const text = await element.textContent();
          console.log(`  - ${text}`);
        }
      }
    }
  });

  test('验证金额格式规范性', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    // 获取页面HTML
    const html = await page.content();

    // 匹配各种金额格式
    const patterns = {
      '中文人民币': /￥\s*\d+(\.\d{2})?/g,
      '中文人民币（简写）': /¥\s*\d+(\.\d{2})?/g,
      '美元': /\$\s*\d+(\.\d{2})?/g,
      '欧元': /€\s*\d+(\.\d{2})?/g,
      '纯数字（可能有问题）': /(?<![¥$€£])\b\d{2,}(,\d{3})*(\.\d{2})?\b(?!.*[¥$€£])/g
    };

    console.log('\n=== 金额格式分析 ===');

    for (const [name, pattern] of Object.entries(patterns)) {
      const matches = html.match(pattern) || [];
      if (matches.length > 0) {
        console.log(`\n${name}: 找到 ${matches.length} 个`);
        matches.slice(0, 5).forEach(match => console.log(`  - ${match}`));
        if (matches.length > 5) {
          console.log(`  ... 还有 ${matches.length - 5} 个`);
        }
      }
    }
  });
});

/**
 * 使用方法：
 *
 * 1. 基本测试：
 *    npx playwright test amount-symbol.spec.ts
 *
 * 2. 测试指定网页：
 *    TEST_URL=https://your-website.com npx playwright test amount-symbol.spec.ts
 *
 * 3. 查看浏览器运行：
 *    npx playwright test amount-symbol.spec.ts --headed
 *
 * 4. 生成报告：
 *    npx playwright test amount-symbol.spec.ts --reporter=html
 *    npx playwright show-report
 */
