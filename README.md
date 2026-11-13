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
- DSH `>=0.2.0`；逐版本兼容记录与取证方式见下面「验证状态」；Profile：`web`
- Node.js `>=22.15`（需要 `node:sqlite`、`node:zlib` 的 zstd API）
- 侧边栏混排（可选）：DSH 源码仓库（`$DSH_HOME/source/current`）+ `pnpm` + `git`

## 权限与边界

| 权限 | 用途 | 范围 |
|---|---|---|
| 文件 | 读 + 受控写入 | 浏览/搜索只读 `opencode.db`、`~/.claude/projects`、Antigravity 会话库和 `~/.dsh/sessions`；用户主动使用「导出」时才会写入目标工具目录（Claude Code `~/.claude/projects/*.jsonl` / `~/.claude/history.jsonl`，Antigravity `~/.gemini/antigravity/brain/<id>/`），并更新插件自己的 `state.json` |
| 网络 | 仅同源 | 浏览器端只访问 DSH 自身的 `/session-hub/api/*`，不连接外网 |
| 命令 | 无 | 不执行子进程或 Shell |
| 凭据 | 无 | 不读取 API Key、Cookie、Keychain 或凭据文件 |

浏览和搜索不会修改源工具数据；导出功能会写入上述目标目录，首次导出前请自行备份。插件不修改 DSH 核心或官方包。

### 访问准入

`/session-hub/api/*` 与官方 `/api` 网关走同一套准入：先过 DSH Connection 的 Host/Origin 围栏和浏览器会话认证，未认证返回 `401 unauthorized`、越界返回 `403 forbidden`；`POST` 还要求 `Content-Type: application/json`，否则 `415`。命令行走这些接口需要带上 DSH 浏览器会话的 cookie（或用 `dsh web` 启动时打印的 token 换一张），因此直接 `curl` 不带凭据会拿到 401。

## 安装

### 方式 A：`dsh plugin` 命令（适合 CLI 部署的 web profile）

```bash
git clone https://github.com/zyf2492313716-cloud/dsh-session-hub.git
cd dsh-session-hub
dsh plugin --profile web add ./plugin    # 换成你的 profile 名
```

`plugin/package.json` 已声明 `dsh.bundle`（cordis patch 层），安装后随 profile 自动挂载。重启 `dsh web` 生效。

> **桌面版（DeepSeek Harness.app）不适用方式 A**：`dsh plugin` 会拒绝 `desktop`
> profile（报 `profile "desktop" is managed exclusively by the Electron
> application`），因为它由应用独占管理。桌面版请用方式 B。

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
3. 在 `$DSH_HOME/cordis.patch.yml` 追加挂载条目（自动备份原文件）
4. 应用 ui-workspace 补丁并构建（侧边栏混排；失败不阻断，API 仍可用）

> **关于 `$DSH_HOME/config.yaml`**：0.1 版用它登记插件，0.2 起不再读取——现在没有
> 任何代码读这个文件（配置改成了 profile patch 层）。往里写条目不会报错，但
> **永远不生效**，表现为"装完了插件却不存在"。本脚本从写 `cordis.patch.yml` 起
> 已修正；如果你之前用旧脚本装过，重新执行一次 `./install.sh` 即可补上正确的条目。
>
> 脚本用**绝对路径**注册而不是 `@dsh-local/*` 包名：包名依赖 profile 自己的
> `node_modules` 能解析到它，而各 profile 的 `node_modules` 是独立的（桌面版就
> 解析不到 `@dsh-local/dsh-session-hub`）。绝对路径由 loader 直接 import，
> 不经过包解析，因此在任何 profile 下都能加载。

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
          opencodeWebCwd: /data/opencode/web           # Antigravity 会话归属的 opencode web 工作区
        knownWebSessionIds:                             # 无法从转录判定归属时，按会话 id 显式指定
          - 00000000-0000-0000-0000-000000000000
```

`knownWebSessionIds` 默认为空：哪些 Antigravity 会话其实属于 opencode web 是各机器的历史事实，插件不内置任何人的会话 id。判定优先走转录嗅探（读工具调用参数里的 `Cwd` 等字段），只有嗅探不到的老会话才需要列进这里。

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

所有端点挂载于 DSH Web 服务的 `/session-hub/api/` 前缀，走 DSH 自身的访问准入（未认证 401 / 越界 403，POST 需 `application/json`）。**除 `/continue` 与 `/export` 创建或写入外全部只读**：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/overview` | GET | 各源会话统计 |
| `/workspaces?source=` | GET | 按工作区分组的会话列表（含 `inDsh` 标记） |
| `/sessions?cwd=&source=` | GET | 指定目录的会话列表 |
| `/session?source=&id=` | GET | 单个会话完整内容 |
| `/search?q=&source=` | GET | 跨源搜索 |
| `/workspaces/sync` | POST | 把外部工作区目录登记为 DSH 工作区（用户显式点击「⇄ 同步工作区到 DSH 侧边栏」时触发） |
| `/continue` | POST | 导入为 DSH 原生会话（幂等）`{"source":"opencode","id":"ses_..."}` |
| `/export` | POST | 导出到目标工具目录 `{"sessionId":"...","target":"claude"}` |

## 架构

```
┌─ node half (lib/index.js) ──── cordis 组件: apply(ctx) ─┐
│  ctx.inject(['webServer','workspaceRegistry','sessions', │
│              'connection'])                             │
│  ├─ HTTP 路由: /session-hub/api/*（只读源适配器）        │
│  │    入口先过 connection.requestRejection(req)          │
│  ├─ buildImportSeed: 外部消息 → DSH SessionEvent        │
│  │   (turn/start → user/assistant message + tool-call   │
│  │    → tool/result → session/title → turn/end)         │
│  ├─ 导入幂等缓存 state.json                              │
│  └─ 启动迁移: 归组补挂接（不注册新工作区）               │
└─────────────────────────────────────────────────────────┘
┌─ ui-workspace 补丁 (patches/) ─────────────────────────┐
│  ExternalSessions.tsx: 外部会话以原生 sessionRow 样式     │
│  混排进工作区分组；点击 → /continue → 轮询等待入列 → 打开 │
└─────────────────────────────────────────────────────────┘
```

**Cordis 对应关系**（见 cordis 论文 §4）：`apply` = 效应函数（注册路由/定时器等可回退效应）；`ctx.inject` = 余效应依赖声明（httpServer/workspace/sessions 满足时激活）；patch 文件里的 `- insert:` 条目 = 声明式配置层（id/url/config/disabled 字段，增量协调）；卸载时纤程 dispose 自动恢复上下文。

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
补丁已在上游最新版源码上验证可应用（上游仅新增 completed 状态字段，不冲突）。

**Q: Antigravity 会话内容为什么是纯文本流？**
A: Antigravity 用 protobuf 私有格式存储且无官方 schema，插件做字节级文本提取（过滤二进制媒体/格式噪音/重复内容），无法还原角色与工具结构。

**Q: 想重新导入某个会话？**
A: 删除插件目录 `state.json` 中对应条目 + `$DSH_HOME/sessions/` 下对应 `session-hub-*` 会话目录，再点击即重新导入。

## 验证状态

- **已验证**：manifest/Bundle Patch 解析、DSH Store 固定源码预检（`status: passed`，run 41980040464 @ `1469f20`）、DSH `0.2.1-rc.5` 一次性 Profile 安装、`/session-hub/api/overview` 与 workspaces/search API 可读。
- **未验证**：真实 Desktop UI 侧边栏混排、卸载/回滚。

### 导入 seed 的宿主契约守卫

宿主对导入用的 seed 有硬校验，不合契约整份 seed 被拒（`seed ... has invalid settlement fields`、`message must have role "tool"`）。这些规则只存在于宿主包内，插件侧看不到，于是「宿主升级 → 导入静默失败」要等用户碰到才发现。

仓库里因此放了两层守卫：

- `test/host-seed-contract.mjs` —— 照抄 `@deepseek-ai/dsh-session` 的校验逻辑（`assertSessionEventEnvelope` / `assertCurrentLlmShape` / `assertAssistantSettlementShape` / `assertMessageEventShape` / `validateSessionEventData`）。这三个函数在本插件声明的四个宿主版本里逐字节相同（按函数体哈希核对过），所以这份校验器对整个兼容窗口成立。
- `test/seed-contract.test.mjs` —— **调用插件真实的 `buildImportSeed` 生成 seed，再喂给上面那份宿主校验器**；src 与 lib 各跑一遍，另逐事件类型断言字段挂在正确的事件上。

另有 `test/src-lib-parity.test.mjs`：本插件的 `lib/` 是提交进仓库的构建产物，但 tsdown 不是本包依赖，历史上一直手工同步 src 与 lib——2026-11 出过一次分叉（src 里补的 seed 适配没同步进 lib，发布出去直接导入失败）。这条守卫比对两边的公共 API 与实际行为，任何一边改了另一边没跟上就会红。

### `dsh.compatibility.dshReleases` 各行的证据

| 版本 | 证据级别 | 依据 |
| --- | --- | --- |
| `0.2.1-rc.5` | 运行验收 | 一次性 Profile 安装通过；本机宿主即 `0.2.1-rc.5`，`GET /session-hub/api/overview` 返回 200 且带五个源的统计 |
| `0.2.2-alpha.2` | 契约核对 | 见下 |
| `0.2.2-alpha.3` | 契约核对 | 见下 |
| `0.2.2-rc.1` | 契约核对 | 见下 |

契约核对的做法：取 `@deepseek-ai/dsh@<版本>` 在 npm 上的固定发布物闭包，逐个解包检查本插件用到的宿主接口是否仍存在——注入服务 `webServer`（`@deepseek-ai/dsh-web-app`、`dsh-tool-cordis`、`dsh-agent-preset`）、`workspaceRegistry`（`dsh-agent-preset`、`dsh-tool-cordis`）、客户端扩展点 `settings.general.item`（`@deepseek-ai/dsh-cordis-client-runner`）与 `window.__ModuleLoader__`。四个版本结果一致：上述 token 全部存在、没有消失或改名，新增的只是额外引用方（`dsh-experimental-liveshare`、`dsh-schedule`、`dsh-session-projection`）。

这一级证据**不**等价于在新版本上做过的安装/启动/卸载验收。之所以没做：`npm i @deepseek-ai/dsh@0.2.2-rc.1` 在匿名 npm 下无法解析——依赖闭包里 `@deepseek-ai/dsh-desktop-host@0.2.1-rc.5`、`@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-*`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-official-bundles`、`@deepseek-ai/dsh-personalized-recommendations` 等发布物对公网返回 404。有内部源权限的人可以补这一级证据。

写入面（审核请按 `user-reviewed` 路径核对）：`POST /session-hub/api/continue` 与 `POST /session-hub/api/export` 会写，落点是 `~/.claude/projects/**.jsonl`、`~/.claude/history.jsonl`、`~/.gemini/antigravity/brain/<id>/.system_generated/logs/**` 和插件目录内的 `state.json`；浏览、搜索、概览全程只读，SQLite 以 `query_only` 打开；不执行命令，不读取凭据（`capability-credentials` 命中的是 `process.env.XDG_DATA_HOME` 一类的数据目录覆盖，见 `plugin/lib/index.js` 的 `PATHS`）。

工作区列表的改动同样只在用户显式操作时发生：启动只做「归组补挂接」（把已导入会话挂回**已有**工作区，不新建工作区）；把外部工作区目录登记进 DSH 由 `POST /session-hub/api/workspaces/sync` 触发，也就是客户端里「⇄ 同步工作区到 DSH 侧边栏」按钮。导入（`/continue`）会把该会话的工作目录登记为 DSH 工作区并归组——这发生在用户点了「接续」之后。

所有 `/session-hub/api/*` 端点都在 handler 入口先调 `connection.requestRejection(req)`，与官方 `/api` 网关同一套准入：Host/Origin 围栏 + 浏览器会话认证，未认证 401、越界 403；`POST` 另要求 `Content-Type: application/json`（否则 415），body 不是合法 JSON 对象则 400。

关于仓库里的 `patches/`：`patches/ui-workspace-external-sessions.diff` 与 `patches/ExternalSessions.tsx` 是给想要 Desktop 侧边栏混排的人**手动**应用到 DSH 源码仓库的可选材料，不在 `package.json` 的 `files` 里、不参与安装、运行时代码不引用它。插件本体只通过官方 Bundle 入口和 `/session-hub/api/*` 路由挂载，不修改 DSH 核心、官方包或官方清单。

## 许可

内部工具，按需使用。浏览/搜索只读源工具数据；导出会在目标工具目录新增对应会话文件，使用前请备份。
