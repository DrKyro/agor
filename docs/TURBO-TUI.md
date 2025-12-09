# Turbo TUI 模式使用指南

## 概述

Agor 项目现已启用 Turbo TUI（Text User Interface）模式，提供类似终端多路复用的优雅开发体验。

## 快速开始

### 启动所有应用（推荐）

```bash
pnpm dev
```

这将启动所有包含 `dev` 脚本的应用，并在 TUI 界面中分屏显示：
- `@agor/core` - 核心包开发服务器
- `@agor/daemon` - 后端服务 + 核心包（使用 concurrently）
- `@agor/ui` - React 前端应用
- `@agor/docs` - 文档站点（如有配置）

### 启动特定应用

```bash
# 仅启动 UI 应用
pnpm turbo run dev:ui

# 仅启动 Daemon 服务
pnpm turbo run dev:daemon
```

## TUI 界面功能

### 布局
- **自动分屏**：Turbo 自动为每个应用分配独立面板
- **颜色区分**：每个应用使用不同颜色标识（cyan, green 等）
- **实时日志**：所有应用的输出实时显示在对应面板中

### 交互操作
- **切换面板**：使用鼠标点击或键盘方向键
- **查看历史**：可以滚动查看历史日志
- **退出**：按 `Ctrl+C` 退出 TUI 模式

### 界面示例

```
┌─ @agor/core ───────────┐ ┌─ @agor/daemon ───────┐
│  Watching...          │ │  Server running      │
│  Build completed      │ │  PORT: 3030          │
│                       │ │                       │
└───────────────────────┘ └───────────────────────┘
┌─ @agor/ui ─────────────┐ ┌─ @agor/docs ─────────┐
│  Vite running         │ │  Storybook dev       │
│  http://localhost:5173│ │  http://localhost:6006│
│                       │ │                       │
└───────────────────────┘ └───────────────────────┘
```

## 配置说明

### Turbo 配置 (`turbo.json`)

```json
{
  "ui": "tui",
  "tasks": {
    "dev": {
      "cache": false,
      "persistent": true
    },
    "dev:ui": {
      "cache": false,
      "persistent": true,
      "env": ["NODE_ENV", "VITE_DAEMON_URL", "VITE_DAEMON_PORT"]
    },
    "dev:daemon": {
      "cache": false,
      "persistent": true,
      "env": ["NODE_ENV", "PORT"]
    }
  }
}
```

### 应用脚本

每个应用在 `package.json` 中定义了相应的 `dev` 脚本：

```json
{
  "scripts": {
    "dev": "vite",                              // agor-ui
    "dev": "concurrently ...",                  // agor-daemon
    "dev:ui": "vite",                           // agor-ui
    "dev:daemon": "concurrently ..."            // agor-daemon
  }
}
```

## 对比其他方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| **Turbo TUI** ⭐ | 现代化界面、自动分屏、智能构建系统支持 | 需要 Turbo 依赖 |
| `dev:ui-daemon` | 简单直接 | 无界面、难以区分日志 |
| 手动多终端 | 完全控制 | 需要手动管理多个窗口 |

## 常见问题

### Q: 如何只运行 UI 和 Daemon，跳过其他包？
A: 目前 Turbo 会运行所有有 `dev` 脚本的包。如需更精确控制，可以：
1. 临时注释不需要的包的 dev 脚本
2. 使用 `--filter` 筛选特定包：`pnpm turbo run dev --filter="@agor/ui && @agor/daemon"`

### Q: TUI 界面显示不下所有应用怎么办？
A: TUI 支持滚动，可以：
- 使用鼠标滚轮查看隐藏的面板
- 使用方向键切换面板焦点
- 按 `q` 退出（如果支持）

### Q: 如何自定义 TUI 颜色？
A: 颜色在 `concurrently` 命令中定义（如 `-c cyan,green`），位于：
- `apps/agor-daemon/package.json`

## 参考资料

- [Turbo 官方文档 - TUI Mode](https://turbo.build/repo/docs/crafting-your-repository/tui)
- [Turbo Pipelines](https://turbo.build/repo/docs/crafting-your-repository/configuration-pipeline)
- [Concurrent](https://github.com/open-cli-tools/concurrently) - 用于 Daemon 的多进程管理
