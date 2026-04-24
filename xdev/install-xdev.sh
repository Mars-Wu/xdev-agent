#!/bin/bash
# install-xdev.sh - systemd 系统服务安装脚本
# 使用方法: sudo ./install-xdev.sh

set -euo pipefail

XDEV_HOME="/var/lib/xdev"
XDEV_LOG="/var/log/xdev"
XDEV_OPT="/opt/xdev"
XDEV_USER="xdev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== 安装AI管家艾克斯 ==="
echo ""

# 检查是否以root运行
if [ "$EUID" -ne 0 ]; then
  echo "请使用 sudo 运行此脚本"
  exit 1
fi

# 1. 创建用户
if ! id "$XDEV_USER" &>/dev/null; then
    useradd -r -s /bin/bash -d "$XDEV_HOME" "$XDEV_USER"
    echo "✓ 创建用户 $XDEV_USER"
else
    echo "✓ 用户 $XDEV_USER 已存在"
fi

# 2. 创建目录
mkdir -p "$XDEV_HOME"/{data,workers,sessions,scripts,config}
mkdir -p "$XDEV_LOG"
mkdir -p "$XDEV_OPT"
mkdir -p /etc/xdev
echo "✓ 创建目录结构"

# 3. 复制脚本
if [ -d "$SCRIPT_DIR/scripts" ]; then
    cp "$SCRIPT_DIR"/scripts/*.sh "$XDEV_HOME/scripts/"
    chmod +x "$XDEV_HOME/scripts/"*.sh
    echo "✓ 复制Hook脚本"
fi

# 4. 复制配置文件
if [ -f "$SCRIPT_DIR/config/config.yaml" ]; then
    cp "$SCRIPT_DIR/config/config.yaml" "$XDEV_HOME/config/"
    echo "✓ 复制配置文件"
fi

# 5. 创建环境变量文件
if [ ! -f /etc/xdev/environment ]; then
    cat > /etc/xdev/environment << 'EOF'
# GLM API（必需）
ZHIPU_API_KEY=your-key-here
ZHIPU_API_BASE_URL=https://open.bigmodel.cn/api/anthropic

# 飞书配置（必需）
FEISHU_APP_ID=your-app-id
FEISHU_APP_SECRET=your-secret
FEISHU_USE_WEBSOCKET=true

# 艾克斯配置
XDEV_HOME=/var/lib/xdev
XDEV_DB=/var/lib/xdev/data/xdev.db
XDEV_GATEWAY_HOST=127.0.0.1
XDEV_GATEWAY_PORT=18789
XDEV_HOOKS_PORT=8081
XDEV_MODEL=glm-5-turbo
XDEV_ROUTER_MODEL=glm-4.7-flash
XDEV_SELECTOR_MODEL=glm-4.7-flash
XDEV_BACKGROUND_MODEL=glm-4.7-flash
XDEV_TIMEOUT=120000
XDEV_MAX_RETRIES=3
XDEV_RETRY_DELAY=1000
XDEV_LOG_LEVEL=info
XDEV_API_TOKEN=change-me-for-test-endpoints

# 说明
# 1. 飞书应用需启用机器人能力与长连接
# 2. 订阅事件: im.message.receive_v1
# 3. 如需访问 /test/message 等测试接口，请把 XDEV_API_TOKEN 改为强随机值

# 兼容别名（可选）
# ANTHROPIC_AUTH_TOKEN=your-key-here
# ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
EOF
    chmod 600 /etc/xdev/environment
    echo "✓ 创建环境变量文件（请编辑 /etc/xdev/environment）"
else
    echo "✓ 环境变量文件已存在"
fi

# 6. 编译并安装应用
if [ -f "$SCRIPT_DIR/package.json" ]; then
    echo "正在编译应用..."
    cd "$SCRIPT_DIR"

    # 安装依赖
    if [ -f "package-lock.json" ]; then
        npm ci
    else
        npm install
    fi

    # 编译TypeScript
    npm run build

    # 复制到 /opt，先清理旧构建产物，避免残留孤儿文件
    rm -rf "$XDEV_OPT"
    mkdir -p "$XDEV_OPT"
    cp -r dist package.json package-lock.json node_modules "$XDEV_OPT/"

    echo "✓ 编译并安装应用"
fi

# 7. 设置权限
chown -R "$XDEV_USER:$XDEV_USER" "$XDEV_HOME" "$XDEV_LOG" "$XDEV_OPT"
echo "✓ 设置权限"

# 8. 安装命令行入口
cat > /usr/local/bin/xdev <<'EOF'
#!/bin/sh
exec node /opt/xdev/dist/cli.js "$@"
EOF
chmod +x /usr/local/bin/xdev
echo "✓ 安装 CLI 命令 /usr/local/bin/xdev"

# 9. 安装Systemd服务
if [ -f "$SCRIPT_DIR/xdev.service" ]; then
    cp "$SCRIPT_DIR/xdev.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable xdev.service
    echo "✓ 安装Systemd服务"
fi

echo ""
echo "运行安装后自检..."
if /usr/local/bin/xdev doctor --env-file /etc/xdev/environment; then
    echo "✓ doctor 检查通过"
else
    echo "! doctor 检查发现缺项，请先编辑 /etc/xdev/environment 后重新运行:"
    echo "  sudo xdev doctor --env-file /etc/xdev/environment"
fi

echo ""
echo "=== 安装完成 ==="
echo ""
echo "下一步操作:"
echo "1. 编辑 /etc/xdev/environment 填写飞书配置"
echo "   - ZHIPU_API_KEY: 智谱 API Key"
echo "   - FEISHU_APP_ID: 飞书应用ID"
echo "   - FEISHU_APP_SECRET: 飞书应用密钥"
echo "   - 参考 xdev/docs/GUIDE.md 完成飞书机器人与长连接配置"
echo ""
echo "2. 启动服务"
echo "   sudo systemctl start xdev"
echo ""
echo "3. 查看状态和日志"
echo "   sudo systemctl status xdev"
echo "   sudo journalctl -u xdev -f"
echo ""
echo "4. 运行自检和冒烟检查"
echo "   sudo xdev doctor --env-file /etc/xdev/environment"
echo "   sudo xdev smoke-check --env-file /etc/xdev/environment"
echo ""
echo "5. 导出运行状态"
echo "   sudo xdev export-status"
echo ""
echo "6. 测试连接"
echo "   curl http://localhost:8081/health"
