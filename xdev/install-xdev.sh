#!/bin/bash
# install-xdev.sh - install Xdev as a systemd service
# Usage: sudo ./install-xdev.sh

set -euo pipefail

XDEV_HOME="/var/lib/xdev"
XDEV_LOG="/var/log/xdev"
XDEV_OPT="/opt/xdev"
XDEV_USER="xdev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Installing Xdev ==="
echo ""

# Ensure the script is running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script with sudo"
  exit 1
fi

# 1. Create the service user
if ! id "$XDEV_USER" &>/dev/null; then
    useradd -r -s /bin/bash -d "$XDEV_HOME" "$XDEV_USER"
    echo "✓ Created user $XDEV_USER"
else
    echo "✓ User $XDEV_USER already exists"
fi

# 2. Create directories
mkdir -p "$XDEV_HOME"/{data,workers,sessions,scripts,config}
mkdir -p "$XDEV_LOG"
mkdir -p "$XDEV_OPT"
mkdir -p /etc/xdev
echo "✓ Created directory structure"

# 3. Copy helper scripts
if [ -d "$SCRIPT_DIR/scripts" ]; then
    cp "$SCRIPT_DIR"/scripts/*.sh "$XDEV_HOME/scripts/"
    chmod +x "$XDEV_HOME/scripts/"*.sh
    echo "✓ Copied helper scripts"
fi

# 4. Copy configuration
if [ -f "$SCRIPT_DIR/config/config.yaml" ]; then
    cp "$SCRIPT_DIR/config/config.yaml" "$XDEV_HOME/config/"
    echo "✓ Copied configuration"
fi

# 5. Create the environment file
if [ ! -f /etc/xdev/environment ]; then
    cat > /etc/xdev/environment << 'EOF'
# Text LLM provider
XDEV_LLM_PROVIDER=glm
XDEV_MODEL_PRESET=glm-default

# GLM text API (fill this block if you use GLM for text)
ZHIPU_API_KEY=your-zhipu-api-key-here
ZHIPU_API_BASE_URL=https://open.bigmodel.cn/api/anthropic

# DeepSeek text API (fill this block if you use DeepSeek for text)
# XDEV_LLM_PROVIDER=deepseek
# XDEV_MODEL_PRESET=deepseek-hybrid
# DEEPSEEK_API_KEY=your-deepseek-api-key-here
# DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic

# Feishu settings (required)
FEISHU_APP_ID=your-app-id
FEISHU_APP_SECRET=your-secret
FEISHU_USE_WEBSOCKET=true

# Xdev runtime settings
XDEV_HOME=/var/lib/xdev
XDEV_DB=/var/lib/xdev/data/xdev.db
XDEV_GATEWAY_HOST=127.0.0.1
XDEV_GATEWAY_PORT=18789
XDEV_HOOKS_PORT=8081
# Role mapping normally comes from XDEV_MODEL_PRESET.
# Uncomment only if you intentionally want to override the preset:
# XDEV_MODEL=glm-5-turbo
# XDEV_ROUTER_MODEL=glm-4.7-flash
# XDEV_SELECTOR_MODEL=glm-4.7-flash
# XDEV_BACKGROUND_MODEL=glm-4.7-flash
# XDEV_CODER_MODEL=glm-5
XDEV_TIMEOUT=120000
XDEV_MAX_RETRIES=3
XDEV_RETRY_DELAY=1000
XDEV_LOG_LEVEL=info
XDEV_API_TOKEN=change-me-for-test-endpoints

# Vision stays on GLM by default even when text uses DeepSeek
# XDEV_VISION_API_KEY=your-zhipu-api-key-here
# XDEV_VISION_BASE_URL=https://open.bigmodel.cn/api/paas/v4/chat/completions
# XDEV_VISION_MODEL=glm-5v-turbo

# Notes
# 1. Enable bot capability and long connections in the Feishu app
# 2. Subscribe to im.message.receive_v1
# 3. Install lark-cli if you want fast Feishu-side setup and live testing:
#      npm install -g @larksuite/cli
#      lark-cli config init --new
#      lark-cli auth login
# 4. If you expose /test/message or similar endpoints, replace XDEV_API_TOKEN with a strong random value

# Compatibility aliases (optional)
# ANTHROPIC_AUTH_TOKEN=your-key-here
# ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
EOF
    chmod 600 /etc/xdev/environment
    echo "✓ Created /etc/xdev/environment (edit it before first production use)"
else
    echo "✓ Environment file already exists"
fi

# 6. Build and install the application
if [ -f "$SCRIPT_DIR/package.json" ]; then
    echo "Building application..."
    cd "$SCRIPT_DIR"

    # Install dependencies
    if [ -f "package-lock.json" ]; then
        npm ci
    else
        npm install
    fi

    # Build TypeScript
    npm run build

    # Copy to /opt after removing old build outputs
    rm -rf "$XDEV_OPT"
    mkdir -p "$XDEV_OPT"
    cp -r dist package.json package-lock.json node_modules "$XDEV_OPT/"

    echo "✓ Built and installed the application"
fi

# 7. Set ownership
chown -R "$XDEV_USER:$XDEV_USER" "$XDEV_HOME" "$XDEV_LOG" "$XDEV_OPT"
echo "✓ Updated ownership"

# 8. Install the CLI entrypoint
cat > /usr/local/bin/xdev <<'EOF'
#!/bin/sh
exec node /opt/xdev/dist/cli.js "$@"
EOF
chmod +x /usr/local/bin/xdev
echo "✓ Installed CLI command at /usr/local/bin/xdev"

# 9. Install the systemd unit
if [ -f "$SCRIPT_DIR/xdev.service" ]; then
    cp "$SCRIPT_DIR/xdev.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable xdev.service
    echo "✓ Installed systemd service"
fi

echo ""
echo "Running post-install checks..."
if /usr/local/bin/xdev doctor --env-file /etc/xdev/environment; then
    echo "✓ doctor completed successfully"
else
    echo "! doctor found missing configuration. Edit /etc/xdev/environment and run again:"
    echo "  sudo xdev doctor --env-file /etc/xdev/environment"
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "1. Edit /etc/xdev/environment with your Feishu and text-model settings"
echo "   - Choose GLM or DeepSeek for text"
echo "   - ZHIPU_API_KEY or DEEPSEEK_API_KEY"
echo "   - FEISHU_APP_ID: Feishu app ID"
echo "   - FEISHU_APP_SECRET: Feishu app secret"
echo "   - See xdev/docs/GUIDE.md for Feishu bot, lark-cli, and provider setup"
echo ""
echo "2. Optional but recommended: install and configure lark-cli"
echo "   npm install -g @larksuite/cli"
echo "   lark-cli config init --new"
echo "   lark-cli auth login"
echo ""
echo "3. Start the service"
echo "   sudo systemctl start xdev"
echo ""
echo "4. Check service status and logs"
echo "   sudo systemctl status xdev"
echo "   sudo journalctl -u xdev -f"
echo ""
echo "5. Run diagnostics and smoke checks"
echo "   sudo xdev doctor --env-file /etc/xdev/environment"
echo "   sudo xdev smoke-check --env-file /etc/xdev/environment"
echo ""
echo "6. Export runtime status"
echo "   sudo xdev export-status"
echo ""
echo "7. Check the health endpoint"
echo "   curl http://localhost:8081/health"
