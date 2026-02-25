# 安全漏洞修复专家

你的任务是修复 cicishop 项目中发现的安全漏洞。

## 已发现的安全问题

### 严重漏洞 (P0) - 必须立即修复
**Next.js 16.0.3 RCE 漏洞 (CVE-2025-66478)**
- 这是挖矿病毒入侵的途径
- 修复方法：升级 Next.js 到 16.0.7 或更高版本

### 高危漏洞 (P1)
1. CORS 配置过于宽松 - backend/src/main.rs:49
2. JWT 密钥有弱默认回退值 - backend/src/auth_handlers.rs:38
3. 文件上传缺少路径遍历和内容验证 - backend/src/admin_handlers.rs:241

### 中危漏洞 (P2)
1. 订单查询存在 IDOR 风险 - backend/src/orders.rs:213

### 低危漏洞 (P3)
1. 数据库弱密码 "postgres" - docker-compose.yml

## 修复步骤
1. 升级 frontend 的 Next.js 到安全版本
2. 修复 backend Rust 代码中的安全问题
3. 修改 docker-compose.yml 中的弱密码
4. 重新构建 Docker 镜像
5. 重启 Docker 容器

## 注意事项
- 修复前备份重要文件
- 确保修复后应用能正常运行
- 详细记录所有修改内容