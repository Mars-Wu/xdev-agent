# T07 · URL 安全 / SSRF 防护

> 参考: `~/data/hermes-agent/tools/url_safety.py`  
> 目标文件: 新建 `src/utils/url-safety.ts`，修改 `src/tools/bash-tool.ts`

---

## 问题背景

Agent 执行 `curl`、`wget` 命令或调用 browser 工具时，可能被恶意 prompt 诱导访问内网地址，如：
- 云服务元数据端点：`169.254.169.254`（AWS/GCP/Azure 实例元数据）
- `metadata.google.internal`
- `localhost`、`127.0.0.1` 上的内部服务

这类攻击称为 SSRF（Server-Side Request Forgery）。

---

## 防护算法

```
1. 解析 URL，提取 hostname
2. 检查硬编码黑名单 hostname
3. DNS 解析 hostname → IP
4. 检查 IP 是否为私有/回环/链路本地/保留/CGNAT 地址
5. fail-closed：DNS 解析失败 → 返回 false（拒绝请求）
```

**CGNAT 特别说明**：`100.64.0.0/10`（RFC 6598，运营商级 NAT），Node.js `net` 模块不自动识别为私有地址，需显式检查。

---

## 执行方案

### 1. 新建 `src/utils/url-safety.ts`

```typescript
import * as dns from 'dns/promises';
import { createLogger } from './logger';

const logger = createLogger('url-safety');

// 总是阻断的 hostname（无论 DNS 解析结果）
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',  // OpenStack metadata
]);

// 私有/保留 IP 范围（CIDR 表示）
const PRIVATE_RANGES = [
  // IPv4
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',        // 回环
  '169.254.0.0/16',     // 链路本地（AWS/GCP metadata）
  '100.64.0.0/10',      // CGNAT（RFC 6598，Tailscale 等 VPN）
  '0.0.0.0/8',
  '240.0.0.0/4',        // 保留
  '224.0.0.0/4',        // 组播
  // IPv6
  '::1/128',            // 回环
  'fe80::/10',          // 链路本地
  'fc00::/7',           // 唯一本地
  '::ffff:0:0/96',      // IPv4 映射
];

/**
 * 将 CIDR 字符串转换为范围检查函数
 * 注：使用简单的位运算，不依赖外部库
 */
function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isInCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split('/');
  if (!range || !bits) return false;
  // 只处理 IPv4（IPv6 简化处理）
  if (!ip.includes('.') || !range.includes('.')) return false;
  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(range);
  const mask = bits === '0' ? 0 : (~0 << (32 - parseInt(bits))) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function isPrivateIP(ip: string): boolean {
  // IPv6 简单检查
  if (ip.includes(':')) {
    return ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd');
  }
  return PRIVATE_RANGES.some((cidr) => isInCidr(ip, cidr));
}

/**
 * 检查 URL 是否安全（非私有/内网地址）
 * fail-closed：解析失败返回 false
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

    // 若 hostname 本身就是 IP，直接检查
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
      if (isPrivateIP(hostname)) {
        logger.warn(`URL 被阻断（私有 IP）: ${hostname}`);
        return false;
      }
      return true;
    }

    // DNS 解析
    const addresses = await dns.resolve(hostname).catch(() => null);
    if (!addresses || addresses.length === 0) {
      logger.warn(`URL 被阻断（DNS 解析失败）: ${hostname}`);
      return false; // fail-closed
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
 * 从 shell 命令中提取 URL（用于 bash-tool 的检查）
 */
export function extractUrlsFromCommand(command: string): string[] {
  const urlPattern = /https?:\/\/[^\s'"]+/g;
  return command.match(urlPattern) ?? [];
}
```

### 2. 修改 `src/tools/bash-tool.ts`

在 curl/wget 命令中检查 URL：

```typescript
import { isSafeUrl, extractUrlsFromCommand } from '../utils/url-safety';

// 在 execute() 中，命令安全检查之后：
const isCurlOrWget = /\b(?:curl|wget)\b/.test(command);
if (isCurlOrWget) {
  const urls = extractUrlsFromCommand(command);
  for (const url of urls) {
    const safe = await isSafeUrl(url);
    if (!safe) {
      return {
        output: `❌ URL 安全检查失败：${url} 指向私有/内网地址，请求被阻断`,
        exitCode: 1,
        error: 'SSRF protection: private/internal URL blocked',
      };
    }
  }
}
```

---

## 局限性说明

- **DNS 重绑攻击（TOCTOU）**：检查时 DNS 返回公网 IP，实际连接时 DNS TTL=0 切换到私有 IP。这需要连接层防护（出口代理），此模块无法完全防御
- `curl` 的 `--resolve` 选项可绕过 DNS，需在 T03 危险模式中添加 `--resolve` 的检查
- 不处理 `http://[::1]` 格式的 IPv6 地址——当前实现会 fail-safe（DNS 解析失败 → 阻断）

---

## 测试用例

```typescript
it('blocks AWS metadata endpoint', async () => {
  expect(await isSafeUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
});
it('blocks localhost', async () => {
  expect(await isSafeUrl('http://127.0.0.1:8080/admin')).toBe(false);
});
it('blocks metadata.google.internal', async () => {
  expect(await isSafeUrl('http://metadata.google.internal/')).toBe(false);
});
it('allows public URLs', async () => {
  expect(await isSafeUrl('https://api.github.com/repos')).toBe(true);
});
it('fails closed on DNS error', async () => {
  expect(await isSafeUrl('http://nonexistent.invalid/')).toBe(false);
});
```
