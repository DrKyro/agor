# Turbo TUI 模式配置完成

## 已完成的更改

### 1. 启用 Turbo TUI 模式
- **文件**: `turbo.json`
- **更改**: 添加 `"ui": "tui"` 配置
- **效果**: 启用类似终端多路复用的分屏显示界面

### 2. 优化 Dev 任务配置
- **文件**: `turbo.json`
- **更改**: 为 `dev`、`dev:ui`、`dev:daemon` 任务添加优化配置
- **配置**:
  - `cache: false` - 禁用缓存以支持实时重载
  - `persistent: true` - 标记为持久化任务
  - `env` - 传递必要的环境变量
  - `outputs: []` - 无输出缓存

### 3. 应用脚本配置
- **文件**: `apps/agor-ui/package.json`
  - 添加 `"dev:ui": "vite"` 脚本

- **文件**: `apps/agor-daemon/package.json`
  - 添加 `"dev:daemon": "concurrently..."` 脚本

### 4. 更新文档
- **文件**: `CLAUDE.md`
  - 更新 Quick Start 部分，推荐使用 Turbo TUI 模式
  - 保留手动终端工作流作为备选方案

- **文件**: `docs/TURBO-TUI.md` (新建)
  - 完整的使用指南
  - TUI 界面功能说明
  - 配置说明和常见问题

### 5. 清理旧脚本
- **文件**: `package.json` (根目录)
  - 移除了之前添加的 `dev:ui-daemon` 脚本
  - 保持简洁，只保留 `pnpm dev`

## 使用方法

### 启动所有应用 (推荐)

```bash
pnpm dev
```

这将：
1. 自动扫描所有包含 `dev` 脚本的包
2. 并行启动开发服务器
3. 在 TUI 界面中分屏显示：
   - `@agor/core` (cyan)
   - `@agor/daemon` (green)
   - `@agor/ui`
   - `@agor/docs` (如果有)

### 启动特定应用

```bash
# 仅 UI 应用
pnpm turbo run dev:ui

# 仅 Daemon 服务
pnpm turbo run dev:daemon
```

## 技术特性

### Turbo TUI 优势
- ✅ 自动分屏布局，无需手动管理多个终端
- ✅ 颜色编码面板，易于区分不同应用
- ✅ 实时日志流，所有输出集中在一个界面
- ✅ 智能构建系统，支持依赖关系和缓存
- ✅ 现代终端体验，替代传统的多窗口方案

### 与其他方案对比

| 方案 | 描述 | 优缺点 |
|------|------|--------|
| **Turbo TUI** ⭐ | 现代化分屏界面，智能并行执行 | ✅ 最优雅<br>❌ 需要 Turbo |
| `dev:ui-daemon` | 后台进程 + wait | ✅ 简单<br>❌ 无界面，难以区分日志 |
| 手动多终端 | 独立终端窗口 | ✅ 完全控制<br>❌ 管理复杂 |

## 验证配置

```bash
# 检查 Turbo 版本
npx turbo --version
# 输出: 2.6.0 ✅

# 验证 JSON 语法
python3 -m json.tool turbo.json > /dev/null
# 输出: ✅ turbo.json syntax is valid

# 检查脚本
grep -A 3 '"scripts"' package.json | grep '"dev"'
# 输出: "dev": "turbo run dev" ✅
```

## 文件变更列表

```
Modified:
- turbo.json (+ "ui": "tui", + dev tasks config)
- package.json (- dev:ui-daemon)
- apps/agor-ui/package.json (+ dev:ui script)
- apps/agor-daemon/package.json (+ dev:daemon script)
- CLAUDE.md (updated Quick Start)

Created:
- docs/TURBO-TUI.md (complete usage guide)

Unchanged:
- apps/agor-cli/package.json
- apps/agor-docs/package.json
- 其他核心文件
```

## 下一步

1. **测试运行**:
   ```bash
   pnpm dev
   ```

2. **验证 TUI 界面**:
   - 查看是否自动分屏显示所有应用
   - 检查颜色编码是否正确
   - 测试面板切换功能

3. **如有问题**:
   - 参考 `docs/TURBO-TUI.md` 故障排除部分
   - 检查终端是否支持 TUI（现代终端都支持）

---

**配置完成时间**: 2025-12-09
**支持的 Turbo 版本**: ≥ 2.0.0 (当前: 2.6.0)
