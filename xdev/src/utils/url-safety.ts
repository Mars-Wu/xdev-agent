// src/utils/url-safety.ts
// SSRF 防护：阻止 Agent 访问私有/内网地址
// 参考: hermes-agent/tools/url_safety.py

import * as dns from 'dns/promises';
import { createLogger } from './logger';

const logger = createLogger('url-safety');

// 总是阻断的 hostname（无论 DNS 解析结果）
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data', // OpenStack metadata
  'computemetadata',
]);

// 私有/保留 IPv4 CIDR 范围
const PRIVATE_IPV4_CIDRS: Array<[number, number]> = [
  [ip4ToNum('10.0.0.0'), 8],
  [ip4ToNum('172.16.0.0'), 12],
  [ip4ToNum('192.168.0.0'), 16],
  [ip4ToNum('127.0.0.0'), 8],       // 回环
  [ip4ToNum('169.254.0.0'), 16],    // 链路本地（AWS/GCP metadata endpoint）
  [ip4ToNum('100.64.0.0'), 10],     // CGNAT（RFC 6598，Tailscale 等）
  [ip4ToNum('0.0.0.0'), 8],
  [ip4ToNum('240.0.0.0'), 4],       // 保留
  [ip4ToNum('224.0.0.0'), 4],       // 组播
];

function ip4ToNum(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const num = ip4ToNum(ip);
  for (const [base, bits] of PRIVATE_IPV4_CIDRS) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((num & mask) === (base & mask)) return true;
  }
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fe80:') || // 链路本地
    lower.startsWith('fc') ||    // 唯一本地地址 fc00::/7
    lower.startsWith('fd') ||
    lower.startsWith('::ffff:') // IPv4-mapped
  );
}

function isPrivateIP(ip: string): boolean {
  if (ip.includes(':')) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

/**
 * 检查 URL 是否安全（非私有/内网地址）
 * fail-closed：DNS 解析失败时返回 false（拒绝请求）
 *
 * ⚠️ TOCTOU 已知限制：此函数检查时 DNS 返回公网 IP，但 curl/wget 执行时
 *    攻击者可在 TTL=0 后将 DNS 切换到私有 IP（DNS 重绑攻击）。
 *    完整防御需要出口代理（如 Squid + CONNECT 拦截），此模块提供第一层防护。
 */
export async function isSafeUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    if (!hostname) return false;

    // 检查黑名单 hostname
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      logger.warn(`URL 被阻断（黑名单 hostname）: ${hostname}`);
      return false;
    }

    // hostname 本身就是 IP，直接检查
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
      if (isPrivateIP(hostname)) {
        logger.warn(`URL 被阻断（私有 IP）: ${hostname}`);
        return false;
      }
      return true;
    }

    // DNS 解析，fail-closed
    const addresses = await dns.resolve(hostname).catch(() => null);
    if (!addresses || addresses.length === 0) {
      logger.warn(`URL 被阻断（DNS 解析失败）: ${hostname}`);
      return false;
    }

    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        logger.warn(`URL 被阻断（DNS 解析到私有 IP ${addr}）: ${hostname}`);
        return false;
      }
    }

    return true;
  } catch (error: any) {
    logger.warn(`URL 安全检查异常（fail-closed）: ${error.message}`);
    return false;
  }
}

/**
 * 从 shell 命令中提取 HTTP/HTTPS URL
 */
export function extractUrlsFromCommand(command: string): string[] {
  const urlPattern = /https?:\/\/[^\s'"]+/g;
  return command.match(urlPattern) ?? [];
}
