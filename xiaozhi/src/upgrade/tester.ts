// src/upgrade/tester.ts
// 小智自我升级系统 - 测试消息模拟
// 向影子实例发送测试消息，验证新版小智是否正常工作

import { createLogger } from '../utils/logger';
import { TestResult, TestMessage, UpgradeConfig, DEFAULT_UPGRADE_CONFIG } from './types';
import { ShadowInstanceManager } from './shadow';

const logger = createLogger('upgrade-tester');

// 默认测试消息
const DEFAULT_TEST_MESSAGES: TestMessage[] = [
  {
    content: '你好，请回复确认你收到了这条消息',
    expectedKeywords: ['收到', '确认', '你好'],
  },
  {
    content: '请列出当前可用的专家',
    expectedKeywords: ['coder', 'analyst', 'operator', 'researcher'],
  },
  {
    content: '/health',
    expectedKeywords: ['ok', '健康'],
  },
];

export class UpgradeTester {
  private config: UpgradeConfig;
  private shadowManager: ShadowInstanceManager;

  constructor(shadowManager: ShadowInstanceManager, config?: Partial<UpgradeConfig>) {
    this.config = { ...DEFAULT_UPGRADE_CONFIG, ...config };
    this.shadowManager = shadowManager;
  }

  /**
   * 运行所有测试
   */
  async runAllTests(port: number, customTests?: TestMessage[]): Promise<{ passed: boolean; results: TestResult[] }> {
    const tests = customTests || DEFAULT_TEST_MESSAGES;
    const results: TestResult[] = [];
    let allPassed = true;

    logger.info(`开始测试影子实例 (端口 ${port})，共 ${tests.length} 个测试`);

    for (let i = 0; i < tests.length; i++) {
      const test = tests[i];
      logger.info(`执行测试 ${i + 1}/${tests.length}: ${test.content.slice(0, 30)}...`);

      const result = await this.runSingleTest(port, test, i + 1);
      results.push(result);

      if (!result.passed) {
        allPassed = false;
        logger.warn(`测试 ${i + 1} 失败: ${result.error}`);
      } else {
        logger.info(`测试 ${i + 1} 通过 (${result.duration}ms)`);
      }

      // 测试间隔，避免过载
      await this.sleep(500);
    }

    logger.info(`测试完成: ${allPassed ? '全部通过' : '部分失败'}`);
    return { passed: allPassed, results };
  }

  /**
   * 运行单个测试
   */
  async runSingleTest(port: number, test: TestMessage, testIndex: number): Promise<TestResult> {
    const startTime = Date.now();
    const result: TestResult = {
      timestamp: new Date(),
      passed: false,
      testName: `test_${testIndex}`,
      duration: 0,
    };

    try {
      const response = await this.shadowManager.sendTestMessage(port, test.content);
      result.duration = Date.now() - startTime;
      result.response = response.response;

      if (!response.success) {
        result.error = response.error || '请求失败';
        return result;
      }

      // 检查响应中是否包含期望的关键词
      if (test.expectedKeywords && test.expectedKeywords.length > 0) {
        const responseText = (response.response || '').toLowerCase();
        const foundKeywords = test.expectedKeywords.filter(keyword =>
          responseText.includes(keyword.toLowerCase())
        );

        if (foundKeywords.length === 0) {
          result.error = `响应中未找到期望关键词: ${test.expectedKeywords.join(', ')}`;
          result.passed = false;
        } else {
          result.passed = true;
        }
      } else {
        // 没有期望关键词，只要响应成功就算通过
        result.passed = true;
      }
    } catch (error) {
      result.duration = Date.now() - startTime;
      result.error = error instanceof Error ? error.message : String(error);
      result.passed = false;
    }

    return result;
  }

  /**
   * 快速健康检查测试
   */
  async quickHealthTest(port: number): Promise<TestResult> {
    const startTime = Date.now();

    const result: TestResult = {
      timestamp: new Date(),
      passed: false,
      testName: 'quick_health',
      duration: 0,
    };

    try {
      const healthy = await this.shadowManager.checkHealth(port);
      result.duration = Date.now() - startTime;
      result.passed = healthy;
      result.response = healthy ? '健康检查通过' : '健康检查失败';
    } catch (error) {
      result.duration = Date.now() - startTime;
      result.error = error instanceof Error ? error.message : String(error);
    }

    return result;
  }

  /**
   * 获取默认测试消息列表
   */
  getDefaultTests(): TestMessage[] {
    return [...DEFAULT_TEST_MESSAGES];
  }

  /**
   * 休眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
