#!/bin/bash
# install-xiaozhi.sh - 一键安装脚本
# 使用方法: sudo ./install-xiaozhi.sh

set -e

XIAOZHI_HOME="/var/lib/xiaozhi"
XIAOZHI_LOG="/var/log/xiaozhi"
XIAOZHI_OPT="/opt/xiaozhi"
XIAOZHI_USER="xiaozhi"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== 安装AI管家小智 ==="
echo ""

# 检查是否以root运行
if [ "$EUID" -ne 0 ]; then
  echo "请使用 sudo 运行此脚本"
  exit 1
fi

# 1. 创建用户
if ! id "$XIAOZHI_USER" &>/dev/null; then
    useradd -r -s /bin/bash -d "$XIAOZHI_HOME" "$XIAOZHI_USER"
    echo "✓ 创建用户 $XIAOZHI_USER"
else
    echo "✓ 用户 $XIAOZHI_USER 已存在"
fi

# 2. 创建目录
mkdir -p "$XIAOZHI_HOME"/{data,workers,sessions,scripts,config}
mkdir -p "$XIAOZHI_LOG"
mkdir -p "$XIAOZHI_OPT"
mkdir -p /etc/xiaozhi
echo "✓ 创建目录结构"

# 3. 复制脚本
if [ -d "$SCRIPT_DIR/scripts" ]; then
    cp "$SCRIPT_DIR"/scripts/*.sh "$XIAOZHI_HOME/scripts/"
    chmod +x "$XIAOZHI_HOME/scripts/"*.sh
    echo "✓ 复制Hook脚本"
fi

# 4. 复制配置文件
if [ -f "$SCRIPT_DIR/config/config.yaml" ]; then
    cp "$SCRIPT_DIR/config/config.yaml" "$XIAOZHI_HOME/config/"
    echo "✓ 复制配置文件"
fi

# 5. 创建环境变量文件
if [ ! -f /etc/xiaozhi/environment ]; then
    cat > /etc/xiaozhi/environment << 'EOF'
# Claude API
ANTHROPIC_API_KEY=your-key-here

# 飞书配置
FEISHU_APP_ID=your-app-id
FEISHU_APP_SECRET=your-secret
FEISHU_USE_WEBSOCKET=true

# 小智配置
XIAOZHI_HOME=/var/lib/xiaozhi
XIAOZHI_MODEL=claude-sonnet-4-5-20250929
XIAOZHI_DB=/var/lib/xiaozhi/data/xiaozhi.db
XIAOZHI_HOOKS_PORT=8081

# 日志
LOG_LEVEL=info
EOF
    chmod 600 /etc/xiaozhi/environment
    echo "✓ 创建环境变量文件（请编辑 /etc/xiaozhi/environment）"
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

    # 复制到/opt
    cp -r dist package.json package-lock.json node_modules "$XIAOZHI_OPT/"

    echo "✓ 编译并安装应用"
fi

# 7. 设置权限
chown -R "$XIAOZHI_USER:$XIAOZHI_USER" "$XIAOZHI_HOME" "$XIAOZHI_LOG" "$XIAOZHI_OPT"
echo "✓ 设置权限"

# 8. 安装Systemd服务
if [ -f "$SCRIPT_DIR/xiaozhi.service" ]; then
    cp "$SCRIPT_DIR/xiaozhi.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable xiaozhi
    echo "✓ 安装Systemd服务"
fi

echo ""
echo "=== 安装完成 ==="
echo ""
echo "下一步操作:"
echo "1. 编辑 /etc/xiaozhi/environment 填写飞书配置"
echo "   - FEISHU_APP_ID: 飞书应用ID"
echo "   - FEISHU_APP_SECRET: 飞书应用密钥"
echo ""
echo "2. 启动服务"
echo "   sudo systemctl start xiaozhi"
echo ""
echo "3. 查看状态和日志"
echo "   sudo systemctl status xiaozhi"
echo "   sudo journalctl -u xiaozhi -f"
echo ""
echo "4. 测试连接"
echo "   curl http://localhost:8081/health"
