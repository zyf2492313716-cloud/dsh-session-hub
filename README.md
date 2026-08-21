# dsh-session-hub

**跨工具会话互通插件** for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai)：把你在 **opencode**、**Claude Code**、**Antigravity** 等其他 AI agent 工具里的历史会话，直接显示在 DSH 侧边栏，**点击即导入为 DSH 原生会话**——完整消息、原生渲染、可继续对话。

> 设计遵循 Cordis 编程范式（可回退效应 + 反应式余效应）：插件作为 cordis 组件经声明式配置挂载，`apply(ctx)` 注册的所有资源（HTTP 路由、工作区）随纤程生命周期自动回收。

## 功能特性

| 特性 | 说明 |
|---|---|
| 🔍 只读浏览 | 跨源列出/搜索外部会话，**绝不写入**源工具的数据 |
| 📥 一键导入 | 点击外部会话行 → 自动导入为 DSH 原生会话并打开（含工具调用显示） |
| 🔁 幂等缓存 | 重复点击同一会话直接打开已导入版本，不重复创建（缓存于 `state.json`） |
| 🗂 自动归组 | 导入会话按原工作目录归入对应 DSH 工作区分组（官方 `attachSession` API） |
| 🧹 智能过滤 | 自动过滤空会话；外部会话以原生行样式混排，无内外分界 |

### 支持的数据源

| 源 | 存储位置 | 解析方式 | 保真度 |
|---|---|---|---|
| **opencode** | `~/.local/share/opencode/opencode.db` (SQLite) | SQL 结构化读取 | ★★★ 完整（消息+工具调用+标题） |
| **Claude Code** | `~/.claude/projects/*/*.jsonl` | JSONL 解析（兼容新旧格式） | ★★★ 完整（含 aiTitle 官方标题） |
| **Antigravity** | `~/.gemini/antigravity/conversations/*.db` | SQLite + protobuf 字节级有损提取 | ★★ 文本流（无角色/工具结构，已清理格式噪音） |
| **DSH** | `~/.dsh/sessions/**/*.jsonl.zstd` | zstd 多帧解压 | ★★★（仅用于跨源搜索展示） |

## 系统要求

- macOS / Linux
- DSH 已安装并可运行 `dsh web`（插件挂载于 DSH 的 HTTP 服务）
- Node.js ≥ 22（需要 `node:sqlite`、`node:zlib` 的 zstd API）
- 侧边栏混排（可选）：DSH 源码仓库（`$DSH_HOME/source/current`）+ `pnpm` + `git`

## 安装

### 方式 A：新版 DSH（支持 `dsh plugin` 命令，推荐）

```bash
git clone https://github.com/dsh-external/dsh-session-hub.git
cd dsh-session-hub
dsh plugin --profile web add .    # <profile> 换成实际 profile 名（GUI 部署一般是 web）
```

插件 package.json 已声明 `dsh.bundle`（cordis patch 层），安装后随 profile 自动挂载。重启 `dsh web` 生效。

> 侧边栏混排（外部会话以原生行显示在工作区分组内）依赖 ui-workspace 补丁，见下方「侧边栏补丁」。

### 方式 B：手动安装（旧版 DSH / 源码部署）

```bash
cd dsh-session-hub
./install.sh                  # 默认 DSH_HOME=~/.dsh
# 或指定: DSH_HOME=/path/to/dsh ./install.sh
```

安装脚本（幂等，可重复执行）会：
1. 复制插件到 `$DSH_HOME/plugins/dsh-session-hub/`（保留已有导入缓存）
2. 创建包别名 `~/node_modules/@dsh-local/dsh-session-hub`
3. 在 `$DSH_HOME/config.yaml` 追加 cordis 挂载条目（自动备份原文件）
4. 应用 ui-workspace 补丁并构建（侧边栏混排；失败不阻断，API 仍可用）

然后**重启 `dsh web`** 并刷新浏览器页面。

## 配置（通用化：适配不同部署路径）

数据源路径默认遵循各工具的标准位置与环境变量（`XDG_DATA_HOME` / `CLAUDE_CONFIG_DIR` / `DSH_HOME`），**无需任何配置即可工作**。若你的工具数据在非标准位置，可在挂载条目中覆盖：

```yaml
- insert:
    - id: dsh-session-hub
      name: '@dsh-local/dsh-session-hub'
      config:
        paths:
          opencodeDb: /data/opencode/opencode.db       # opencode SQLite
          claudeRoot: /data/claude/projects            # Claude Code 会话目录
          claudeHistory: /data/claude/history.jsonl    # Claude 提示词历史
          antigravityRoot: /data/gemini/antigravity/conversations
```

缺失的数据源会自动跳过（如未安装 Antigravity 则不显示该源），不影响其他源。

## 验证与测试

```bash
./test-plugin.sh              # 默认测试 127.0.0.1:3210
./test-plugin.sh 3210         # 指定端口
```

测试覆盖：服务可达性、overview/workspaces/sessions/search 四个只读 API、**导入往返**（首次导入 → 幂等重入 → 内容读取 → 自动清理测试数据）。全部通过输出 `🎉 全部通过`。

手动快速验证：

```bash
curl http://127.0.0.1:3210/session-hub/api/overview
# {"ok":true,"sources":[{"source":"opencode","sessions":387,...},...]}
```

## 使用

1. 打开 DSH Web（默认 `http://127.0.0.1:3210`）
2. 侧边栏展开任一工作区 → 组内直接列出该目录的**全部会话**（原生 + 外部，无分界）
3. 点击外部会话行：
   - 首次：显示"打开中…"→ 自动导入 → 跳转原生会话视图（标题、消息、工具调用完整）
   - 再次：直接打开已导入版本
4. 导入后的会话与原生会话无任何差异：可继续对话、重命名、归档

## 卸载

```bash
./uninstall.sh
```

移除配置条目、别名与插件目录（自动备份；已导入的 DSH 会话数据保留）。ui-workspace 补丁按脚本提示手动还原。

## HTTP API

所有端点挂载于 DSH Web 服务的 `/session-hub/api/` 前缀，**全部只读**（除 `/continue` 创建导入会话）：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/overview` | GET | 各源会话统计 |
| `/workspaces?source=` | GET | 按工作区分组的会话列表（含 `imported` 标记） |
| `/sessions?cwd=&source=` | GET | 指定目录的会话列表 |
| `/session?source=&id=` | GET | 单个会话完整内容 |
| `/search?q=&source=` | GET | 跨源搜索 |
| `/continue` | POST | 导入为 DSH 原生会话（幂等）`{"source":"opencode","id":"ses_..."}` |

## 架构

```
┌─ node half (lib/index.js) ──── cordis 组件: apply(ctx) ─┐
│  ctx.inject(['httpServer','workspace','sessions'])      │
│  ├─ HTTP 路由: /session-hub/api/*（只读源适配器）        │
│  ├─ buildImportSeed: 外部消息 → DSH SessionEvent        │
│  │   (turn/start → user/assistant message + tool-call   │
│  │    → tool/result → session/title → turn/end)         │
│  ├─ 导入幂等缓存 state.json                              │
│  └─ 启动迁移: 归组补挂接 + 虚拟工作区注册                 │
└─────────────────────────────────────────────────────────┘
┌─ ui-workspace 补丁 (patches/) ─────────────────────────┐
│  ExternalSessions.tsx: 外部会话以原生 sessionRow 样式     │
│  混排进工作区分组；点击 → /continue → 轮询等待入列 → 打开 │
└─────────────────────────────────────────────────────────┘
```

**Cordis 对应关系**（见 cordis 论文 §4）：`apply` = 效应函数（注册路由/定时器等可回退效应）；`ctx.inject` = 余效应依赖声明（httpServer/workspace/sessions 满足时激活）；config.yaml 的 `- insert:` 条目 = 声明式配置层（id/url/config/disabled 字段，增量协调）；卸载时纤程 dispose 自动恢复上下文。

## 常见问题

**Q: 侧边栏看不到外部会话？**
A: 确认 ui-workspace 补丁应用成功（install 输出）；或直接用 API 验证 `curl .../session-hub/api/overview`。

**Q: DSH 升级后侧边栏外部会话消失？**
A: 侧边栏混排是对 ui-workspace 包的源码补丁（DSH 未开放侧边栏三方注入点）。升级后在**源码部署**上重新应用：
```bash
cd <dsh 源码目录>
git apply <本仓库>/patches/ui-workspace-external-sessions.diff || true   # 上游有偏移时手动适配
cp <本仓库>/patches/ExternalSessions.tsx packages/client/ui-workspace/src/client/
pnpm --filter @deepseek-ai/dsh-client-ui-workspace bundle
```
补丁已在 test-zyf2492313716-cloud 最新版源码上验证可应用（上游仅新增 completed 状态字段，不冲突）。

**Q: Antigravity 会话内容为什么是纯文本流？**
A: Antigravity 用 protobuf 私有格式存储且无官方 schema，插件做字节级文本提取（过滤二进制媒体/格式噪音/重复内容），无法还原角色与工具结构。

**Q: 想重新导入某个会话？**
A: 删除插件目录 `state.json` 中对应条目 + `$DSH_HOME/sessions/` 下对应 `session-hub-*` 会话目录，再点击即重新导入。

## 许可

内部工具，按需使用。源工具数据全程只读，无任何写入风险。
