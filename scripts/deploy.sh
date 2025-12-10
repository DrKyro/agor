#!/bin/bash

# Agor 部署脚本
# 用于在生产环境中部署 Agor 项目

set -e  # 遇到错误时退出

echo "🚀 开始部署 Agor 项目..."

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查是否以 root 用户运行
if [ "$EUID" -eq 0 ]; then
    print_warn "检测到以 root 用户运行"
    print_warn "建议创建专用用户以提高安全性"
fi

# 步骤 1: 安装项目依赖
print_info "步骤 1/5: 安装项目依赖..."
if [ -f "pnpm-lock.yaml" ]; then
    pnpm install
elif [ -f "package-lock.json" ]; then
    npm install
else
    print_error "未找到锁文件，请确保在项目根目录"
    exit 1
fi

# 步骤 2: 构建 executor 包
print_info "步骤 2/5: 构建 executor 包..."
if [ -d "packages/executor" ]; then
    cd packages/executor
    pnpm run build
    cd ../../
    print_info "✅ executor 包构建完成"
else
    print_warn "未找到 packages/executor 目录，跳过构建"
fi

# 步骤 3: 安装 Zellij
print_info "步骤 3/5: 安装 Zellij..."
if ! command -v zellij &> /dev/null; then
    print_info "正在下载并安装 Zellij..."

    # 检测操作系统
    if [ -f /etc/debian_version ]; then
        # Ubuntu/Debian
        curl -L https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz | \
            sudo tar -xz -C /usr/local/bin
        sudo chmod +x /usr/local/bin/zellij
        print_info "✅ Zellij 安装完成 (Debian/Ubuntu)"
    elif [ -f /etc/redhat-release ]; then
        # CentOS/RHEL/Fedora
        curl -L https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz | \
            sudo tar -xz -C /usr/local/bin
        sudo chmod +x /usr/local/bin/zellij
        print_info "✅ Zellij 安装完成 (CentOS/RHEL/Fedora)"
    elif command -v brew &> /dev/null; then
        # macOS
        brew install zellij
        print_info "✅ Zellij 安装完成 (macOS)"
    else
        print_error "无法自动检测操作系统，请手动安装 Zellij"
        print_info "访问: https://zellij.dev/installation/"
        exit 1
    fi
else
    print_info "✅ Zellij 已安装"
fi

# 步骤 4: 安装 code-server 和 pm2
print_info "步骤 4/5: 安装 code-server 和 pm2..."

# 安装 npm 包（如果尚未安装）
if ! command -v npm &> /dev/null; then
    print_error "npm 未安装，请先安装 Node.js 和 npm"
    exit 1
fi

# 安装 pm2
if ! command -v pm2 &> /dev/null; then
    print_info "正在安装 pm2..."
    sudo npm install -g pm2
    print_info "✅ pm2 安装完成"
else
    print_info "✅ pm2 已安装"
fi

# 安装 code-server
if ! command -v code-server &> /dev/null; then
    print_info "正在安装 code-server..."
    sudo npm install -g code-server
    print_info "✅ code-server 安装完成"
else
    print_info "✅ code-server 已安装"
fi

# 步骤 5: 启动 code-server
print_info "步骤 5/5: 启动 code-server..."

# 检查 code-server 是否已经在运行
if pm2 list | grep -q "code-server-dev"; then
    print_warn "code-server-dev 已在运行"

    # 询问是否重启
    read -p "是否要重启 code-server? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        pm2 restart code-server-dev
        print_info "✅ code-server 已重启"
    else
        print_info "跳过重启"
    fi
else
    # 启动 code-server
    print_info "正在启动 code-server..."

    # 获取当前用户目录
    USER_HOME=$(eval echo ~$SUDO_USER)
    if [ -z "$USER_HOME" ] || [ "$USER_HOME" = "~" ]; then
        USER_HOME=$HOME
    fi

    pm2 start /usr/bin/code-server \
        --interpreter bash \
        --name code-server-dev \
        -- \
        --host 0.0.0.0 \
        --port 8111 \
        $USER_HOME

    print_info "✅ code-server 启动成功"
fi

# 保存 pm2 进程列表，以便系统重启后自动恢复
print_info "保存 pm2 配置..."
pm2 save
pm2 startup | sudo bash - || print_warn "无法自动设置 pm2 开机启动，请手动运行: pm2 startup"

# 显示状态
print_info "部署完成!"
echo ""
echo "=================================="
echo "📋 部署摘要:"
echo "=================================="
echo "✅ 项目依赖已安装"
echo "✅ executor 包已构建"
echo "✅ Zellij 已安装"
echo "✅ code-server 和 pm2 已安装"
echo "✅ code-server 正在运行"
echo ""
echo "🔗 访问地址:"
echo "  code-server: http://localhost:8111"
echo ""
echo "📊 进程状态:"
pm2 list
echo ""
echo "💡 提示:"
echo "  - 使用 'pm2 status' 查看进程状态"
echo "  - 使用 'pm2 logs code-server-dev' 查看日志"
echo "  - 使用 'pm2 restart code-server-dev' 重启服务"
echo "  - 使用 'pm2 stop code-server-dev' 停止服务"
echo "=================================="