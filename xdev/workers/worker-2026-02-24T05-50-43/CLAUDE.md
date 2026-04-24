# 阿里企业邮箱集成任务

## 邮箱配置
SMTP服务器: smtp.qiye.aliyun.com
端口: 465 (SSL)
用户名: support@westway.cc
密码: supportfromwestway

## 任务
1. 在 Rust 后端 (backend/) 添加邮件发送模块
   - 添加 lettre 依赖到 Cargo.toml
   - 创建 src/email/mod.rs 邮件模块
   - 创建 src/email/templates.rs 邮件模板

2. 实现邮件功能
   - 订单确认邮件
   - 发货通知邮件
   - 密码重置邮件

3. 配置管理
   - 在 deploy/.env.prod 添加邮件环境变量
   - 更新 docker-compose.prod.yml

4. 测试
   - 发送测试邮件验证功能

## 注意
敏感信息用环境变量，不要硬编码到代码中。