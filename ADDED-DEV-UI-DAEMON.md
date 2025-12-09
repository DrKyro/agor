# 新增 dev:ui-daemon 入口

## 概述

已成功添加一个新的 pnpm 命令入口，专门用于只启动 UI 和 Daemon 应用，跳过其他包（如 core 和 docs）。

## 使用方法

### 启动命令

```bash
pnpm dev:ui-daemon
```

### 功能说明

- **只启动 UI 应用** (`apps/agor-ui`)
- **只启动 Daemon 服务** (`apps/agor-daemon`)
- **跳过 Core 包** (`packages/core`)
- **跳过 Docs 应用** (`apps/agor-docs`)

### 工作原理

使用 **Turbo TUI** 模式并行启动两个应用：

```bash
pnpm turbo run dev:ui dev:daemon
```

- **Turbo 自动检测**: 只有 `agor-ui` 定义了 `dev:ui`，只有 `@agor/daemon` 定义了 `dev:daemon`
- **TUI 界面**: 提供优雅的分屏显示，实时日志流
- **颜色区分**: UI (cyan) 和 Daemon (magenta) 使用不同颜色

## 配置详情

### 文件位置

**文件**: `package.json` (根目录)

**新增脚本**:
```json
{
  "scripts": {
    "dev:ui-daemon": "pnpm turbo run dev:ui dev:daemon"
  }
}
```

## 对比其他命令

| 命令 | 启动的应用 | 界面 | 使用场景 |
|------|-----------|------|----------|
| `pnpm dev` | 所有包 (core + ui + daemon + docs) | Turbo TUI | 完整开发环境 |
| `pnpm dev:ui-daemon` | 仅 UI + Daemon | **Turbo TUI** ⭐ | 专注核心功能开发 |

## 启动的应用详情

### UI 应用 (`agor-ui`)
- **端口**: 5173
- **框架**: React + Vite
- **热重载**: ✅ 支持

### Daemon 服务 (`@agor/daemon`)
- **端口**: 3030
- **框架**: FeathersJS + Express
- **特性**:
  - 同时启动 Core 包开发服务器
  - 使用 concurrently 管理多进程
  - 自动重启支持

## 注意事项

1. **依赖要求**
   - 需要在项目根目录运行
   - 确保已安装依赖: `pnpm install`

2. **进程管理**
   - 使用 `Ctrl+C` 退出所有进程
   - 所有子进程会一起终止

3. **日志输出**
   - **TUI 界面**: 使用分屏显示，每个应用独立面板
   - **颜色区分**: UI (cyan) 和 Daemon (magenta)
   - **端口**: UI (5173) 和 Daemon (3030) 独立端口

4. **与 Turbo TUI 的关系**
   - `pnpm dev` 使用 Turbo TUI，启动所有包
   - `pnpm dev:ui-daemon` **也使用 Turbo TUI**，只启动 UI + Daemon
   - 两者都提供优雅的分屏界面，根据需求选择

## 使用场景推荐

### 推荐使用 `pnpm dev:ui-daemon` 的场景:
- 专注于前端和后端开发
- 不想看到 core 和 docs 的日志
- 需要更简单的终端输出
- 资源有限，不想启动太多进程

### 推荐使用 `pnpm dev` (Turbo TUI) 的场景:
- 需要看到所有包的开发状态
- 喜欢现代化的 TUI 界面
- 需要颜色编码区分不同应用
- 完整的开发环境

## 验证安装

```bash
# 验证脚本存在
grep "dev:ui-daemon" package.json

# 验证依赖已安装
ls -la apps/agor-ui/node_modules
ls -la apps/agor-daemon/node_modules

# 验证端口可用 (可选)
lsof -i :5173  # UI 端口
lsof -i :3030  # Daemon 端口
```

## 示例输出

启动后会看到类似这样的 **TUI 界面**：

```
┌─ agor-ui ───────────┐ ┌─ @agor/daemon ──────┐
│  VITE v7.x.x        │ │  Server running      │
│  ready in xxx ms    │ │  PORT: 3030          │
│  ➜  :5173/         │ │  Core watching...    │
│  [cyan panel]       │ │  [magenta panel]     │
└─────────────────────┘ └──────────────────────┘
```

**TUI 特性**:
- ✨ 自动分屏布局
- 🎨 颜色编码 (UI: cyan, Daemon: magenta)
- 📊 实时日志流
- 🔄 独立面板，可分别查看

## 故障排除

### 问题 1: 端口被占用
```bash
# 杀死占用端口的进程
lsof -ti:5173 | xargs kill -9
lsof -ti:3030 | xargs kill -9
```

### 问题 2: 依赖未安装
```bash
# 重新安装依赖
pnpm install
```

### 问题 3: 进程无法退出
```bash
# 强制杀死所有相关进程
pkill -f "vite"
pkill -f "tsx"
```

---

**创建时间**: 2025-12-09
**适用版本**: Agor v0.1.0+
