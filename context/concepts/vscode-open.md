# Worktree「Open in VS Code」功能说明

**更新时间：2025-12-06（更新：新增 code-server 浏览器打开 & 连接模式配置；区分全局配置与用户级 SSH 配置）**

## 目标与需求

- 在 Worktree 卡片、Session 面板中提供 “Open in VS Code” 按钮。
- 单击即可把对应 Worktree 目录通过 VS Code 打开。
- 支持三种模式：Remote SSH、VS Code Tunnel、Local。
- 默认优先使用 Remote SSH（避免隧道中转延迟）；若配置缺失则自动按优先级回退。
- 如果未配置远程信息，则退回使用本地打开：默认通过 CLI 运行 `code <path>`；如 CLI 不可用，则退回使用 `vscode://file` Deep Link。
- 新增浏览器端 `code-server` 打开入口，可通过 URL 模板生成链接。

## 配置入口速查

- 全局配置（所有用户共享）：`~/.agor/config.yaml` 下的 `ide.vscode`、`ide.code_server`。
- 用户级 SSH 配置（每个用户单独的 host/user/port/target、公钥）：在前端 **User Settings → SSH / VS Code** 填写，存入用户资料而不是 config.yaml，并自动写入目标用户的 `authorized_keys`。
- 配置优先级：用户级 SSH > 全局 `ide.vscode.remote` > Tunnel > Local。

## 后端实现

1. **配置入口**（`~/.agor/config.yaml`）

```yaml
ide:
  vscode:
    enabled: true            # 默认 true，可在需要时关闭入口按钮
    preferred_mode: remote-ssh  # 默认优先 Remote SSH，可选 tunnel / remote-ssh / local
    # 当模式解析为 local 时的打开方式（默认 cli）：
    # - cli: 通过本机 CLI 执行 `code -n <path>`
    # - deeplink: 通过 `vscode://file/<path>` Deep Link 交给前端触发
    local_open_strategy: cli
    remote:
      host: my-server.com    # 远程 SSH Host（必填，否则走本地模式）
      port: 22               # 选填，默认 22
      user: dev              # SSH 用户（必填，否则走本地模式）
      target: agor-dev       # 选填，对应 ~/.ssh/config 的 Host 别名；未填则自动拼 user@host[:port]
    tunnel:                  # 可选，填了才会尝试 tunnel
      name: agor-prod-tunnel
      displayName: "Prod Tunnel"
  code_server:
    enabled: false           # 默认关闭，开启后显示 “Open in code-server (browser)” 按钮
    url_template: "https://codeserver.example.com/?folder={{encodeURIComponent worktree.path}}"
```

2. `apps/agor-daemon/src/services/worktrees.ts`

   - 新增 `getVSCodeTarget(worktreeId)`。内部根据配置返回 `VSCodeOpenResult`。
   - **优先顺序（可配置）：preferred_mode → 其他模式。**
     - `preferred_mode: remote-ssh`（默认）：优先生成 `vscode://vscode-remote/ssh-remote+<target>/<path>`。
     - 若配置了 Tunnel 且将 `preferred_mode` 设为 `tunnel`，会生成 `vscode://vscode-remote/tunnel+<name>/<path>`（符合 remote authority 规范，前端再追加 `windowId` 保证新窗口）。
     - 以上条件都缺失时，回退到本地模式：优先尝试 `code -n <path>`，若失败则返回 `vscode://file/<path>` 并在结果中附带 `reason`。
   - 新增 `getCodeServerTarget(worktreeId)`：按 `ide.code_server.url_template` 渲染出浏览器端 code-server 链接。

3. `apps/agor-daemon/src/index.ts`

   - 暴露 `/worktrees-open-vscode` 自定义服务，方法：`POST { worktreeId } → VSCodeOpenResult`。
   - 暴露 `/worktrees-open-codeserver` 自定义服务，方法：`POST { worktreeId } → CodeServerOpenResult`。
   - 采用统一路由（非 `:id`），确保 Socket 客户端/REST 都能调用。
   - 访问控制：`member` 及以上可以触发。

## 前端交互

1. `App.tsx`

   - `handleOpenVSCode(worktreeId)` 调用上述 service：
     - 若返回 `launchedCli=true`，表示后端已通过本地 CLI 启动 VS Code，前端不再触发 deep link，仅提示成功；
     - 否则根据返回的 `uri` 创建隐藏 `<a>` 标签触发 deep link。
   - 根据 `mode` 展示 toast，如 `remote-ssh` 时提示 “VS Code Remote SSH 已触发”，`local` 时提示 “VS Code 正在本地打开工作树”。
   - 始终追加唯一 `windowId`，确保 VS Code 打开新窗口，不会覆盖当前工程。
   - 新增 `handleOpenCodeServer(worktreeId)` 调用 `/worktrees-open-codeserver` 并在浏览器中打开生成的 URL。

2. 按钮位置

   - Worktree card header（拖拽/终端按钮区域）新增 “VS Code” 与 “code-server” 两个按钮。
   - SessionPanel 右上角新增 VS Code / code-server 打开入口。
   - Settings > IDE / VS Code 标签页可配置 `preferred_mode`、SSH/Tunnel 信息以及 code-server URL 模板。

3. 回退提示

   - 如果返回结果是 `local` 且带 `reason`，会额外在 UI 内弹出 warning，告知当前因配置缺失而回退本地模式。

## 使用流程

1. 全局（所有用户共享）：在运行 daemon 的机器上配置 `~/.agor/config.yaml`  
   - VS Code Tunnel：
     ```yaml
     ide:
       vscode:
         tunnel:
           name: agor-prod-tunnel
           displayName: "Prod Tunnel"
     ```
   - Remote SSH（全局默认值，可被用户级覆盖）：
     ```yaml
     ide:
       vscode:
         remote:
           host: my-server.com
           port: 22
           user: dev
           target: agor-dev
     ```
   - 浏览器 code-server：
     ```yaml
     ide:
       code_server:
         enabled: true
         url_template: "https://codeserver.example.com/?folder={{encodeURIComponent worktree.path}}"
     ```
   - 其他：`preferred_mode`（tunnel/remote-ssh/local）、`enabled` 开关同样在 `ide.vscode` 下。
2. 用户级（每人独立 SSH）：前端 **User Settings → SSH / VS Code** 填写 host/port/user/target 和公钥（.pub）。保存后会：
   - 覆盖当前用户的 SSH 配置（高于全局）。
   - 自动写入目标账号的 `authorized_keys`（若无权限会在界面提示错误）。
3. 重启 daemon（或等待 watch 热更新生效）。
4. 在 UI 中点击 “Open in VS Code”，浏览器会调用 `vscode://...` 并追加唯一 `windowId`，VS Code 始终新窗口打开。
5. 如启用 code-server，点击 “Open in code-server (browser)” 新标签页打开模板渲染后的链接（模板上下文：`worktree`、`repo`，可用 `encodeURIComponent`）。

## 常见问题

| 现象 | 可能原因 | 处理方式 |
| --- | --- | --- |
| 提示 “VS Code 集成尚未配置” | `ide.vscode.enabled` 为 false 或 service 返回 `enabled=false` | 在 config.yaml 打开该开关 |
| 自动退回本地模式（显示 reason） | `tunnel.name` 缺失且 `remote.host/user` 也未配置 | 填写 Tunnel 名称或 Remote SSH 信息 |
| Deep Link 未唤起 VS Code | 浏览器阻止 `vscode://` 协议或本地未安装 VS Code | 确认浏览器弹窗/本地安装状态 |
| Tunnel 太慢 | 默认已改为优先 Remote SSH，可在 Settings>IDE 中把 preferred_mode 设为 remote-ssh/local |  |
| 需要浏览器打开 | 启用 `ide.code_server.enabled=true` 并填写 URL 模板 | Settings>IDE Tab |

## 相关代码

- `packages/core/src/config/types.ts`
- `apps/agor-daemon/src/services/worktrees.ts`
- `apps/agor-daemon/src/index.ts`
- `apps/agor-ui/src/App.tsx`
- `apps/agor-ui/src/components/WorktreeCard/WorktreeCard.tsx`
- `apps/agor-ui/src/components/SessionPanel/SessionPanel.tsx`
