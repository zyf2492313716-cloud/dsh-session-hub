#!/usr/bin/env bash
# dsh-session-hub 安装脚本
# 用法: ./install.sh            （默认 DSH_HOME=~/.dsh）
#       DSH_HOME=/path/to/dsh ./install.sh
# 幂等：重复执行安全（更新代码、保留导入缓存 state.json）
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_NAME="dsh-session-hub"
PORT="${DSH_PORT:-3210}"

log()  { printf '\033[32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[error]\033[0m %s\n' "$*"; exit 1; }

# ── 1. 检查 DSH 安装 ─────────────────────────────────────────────
[ -d "$DSH_HOME" ] || fail "未找到 DSH 目录: ${DSH_HOME}（可用环境变量 DSH_HOME 指定）"
log "DSH 目录: $DSH_HOME"

# ── 2. 安装插件（保留已有 state.json 导入缓存）──────────────────
TARGET="$DSH_HOME/plugins/$PLUGIN_NAME"
mkdir -p "$DSH_HOME/plugins"
STATE_BAK=""
if [ -f "$TARGET/state.json" ]; then
  STATE_BAK="$(mktemp)"
  cp "$TARGET/state.json" "$STATE_BAK"
  log "检测到已安装版本，保留导入缓存 state.json"
  rm -rf "$TARGET"
fi
cp -R "$PKG_DIR/plugin" "$TARGET"
[ -n "$STATE_BAK" ] && mv "$STATE_BAK" "$TARGET/state.json"
log "插件已安装: $TARGET"

# ── 3. 包别名（Node 解析 @dsh-local/*）──────────────────────────
mkdir -p "$HOME/node_modules/@dsh-local"
ln -sfn "$TARGET" "$HOME/node_modules/@dsh-local/$PLUGIN_NAME"
log "包别名: ~/node_modules/@dsh-local/$PLUGIN_NAME -> $TARGET"

# ── 4. 注册挂载条目 ─────────────────────────────────────────────
# 写进 $DSH_HOME/cordis.patch.yml（home 级 patch 层，对所有 profile 生效）。
#
# 不要写 $DSH_HOME/config.yaml：0.2.x 里没有任何代码读它，写进去的条目永不生效，
# 而启动也不报错——表现为"装完了但插件不存在"。旧版 DSH（0.1）才用 config.yaml。
#
# 用绝对路径注册而不是 @dsh-local/* 包名：包名需要 profile 的 node_modules 能解析到
# 它，而不同 profile 的 node_modules 是独立的，desktop 就解析不到。绝对路径由
# loader 直接 import，不经过包解析。
#
# home 级 patch 排在 profile 层之后，因此对所有 profile（web / desktop / tui）都生效。
PATCH_FILE="$DSH_HOME/cordis.patch.yml"
ENTRY_NAME="$TARGET/lib/index.js"

# 结构性插入，不要用 `cat >>` 追加。
#
# 原因：DSH 自己生成的 patch 模板长这样——注释头 + 一行 `[]`：
#     # Your patch layer for this dsh profile, ...
#     []
# 在 `[]` 后面直接追加 `- insert:` 会得到两个 YAML 文档，整个文件解析失败，
# 而 patch 解析失败会让 DSH 直接启动不起来。所以必须先把 `[]` 收掉，
# 再把新条目并进同一个数组。
#
# 缺 python3 时退回纯文本处理（同样先剥掉独立的 `[]` 行）。
python3 - "$PATCH_FILE" "$PLUGIN_NAME" "$ENTRY_NAME" <<'PYEOF'
import sys, os, re, shutil, time

path, plugin_id, entry_name = sys.argv[1], sys.argv[2], sys.argv[3]

text = ''
if os.path.exists(path):
    # Keep a copy before the first write.
    shutil.copy2(path, f"{path}.bak.{int(time.time())}")
    text = open(path).read()

if re.search(rf'^\s*-\s*id:\s*{re.escape(plugin_id)}\s*$', text, re.M):
    print(f'[skip] {path} 已含 {plugin_id} 条目')
    sys.exit(0)

# Drop the document-start array marker and any comments that only describe an
# empty layer; a lone `[]` cannot coexist with a block sequence.
lines = [ln for ln in text.split('\n') if ln.strip() != '[]']
body = '\n'.join(lines).rstrip('\n')

block = (
    f"\n- insert:\n"
    f"    - id: {plugin_id}\n"
    f"      name: '{entry_name}'\n"
    f"      inject: [webServer, workspaceRegistry, sessions]\n"
)

# If the file was empty or only comments, start a fresh array.
if not re.search(r'^\s*-\s', body, re.M):
    body = '\n'.join(ln for ln in lines if ln.strip().startswith('#'))
    body = body.rstrip('\n') + '\n' if body.strip() else ''

open(path, 'w').write(body + block)
print(f'[ok] {path} 已添加挂载条目')
PYEOF
log "挂载条目已写入 ${PATCH_FILE}"

# ── 5. ui-workspace 补丁（侧边栏混排外部会话；需 DSH 源码 + pnpm + git）──
SRC="$DSH_HOME/source/current"
if [ -d "$SRC/packages/client/ui-workspace" ] && grep -q "ExternalSessions" "$SRC/packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx" 2>/dev/null; then
  log "ui-workspace 补丁已应用，跳过"
elif [ -d "$SRC/packages/client/ui-workspace" ]; then
  if command -v pnpm >/dev/null 2>&1 && (cd "$SRC" && git rev-parse --git-dir >/dev/null 2>&1); then
    log "应用 ui-workspace 补丁并构建..."
    if (cd "$SRC" \
        && git apply "$PKG_DIR/patches/ui-workspace-external-sessions.diff" \
        && cp "$PKG_DIR/patches/ExternalSessions.tsx" packages/client/ui-workspace/src/client/ \
        && pnpm --filter @deepseek-ai/dsh-client-ui-workspace bundle >/dev/null 2>&1); then
      log "ui-workspace 补丁应用成功（侧边栏将显示外部会话）"
    else
      warn "ui-workspace 补丁应用失败（DSH 版本不匹配或构建失败）。插件 API 仍可用，侧边栏混排不可用。"
      warn "可手动处理: cd $SRC && git apply $PKG_DIR/patches/ui-workspace-external-sessions.diff"
    fi
  else
    warn "缺少 pnpm 或 $SRC 不是 git 仓库，跳过 ui-workspace 补丁（插件 API 不受影响）"
  fi
else
  warn "未找到 ui-workspace 源码包，跳过侧边栏补丁（插件 API 不受影响）"
fi

# ── 完成 ─────────────────────────────────────────────────────────
echo
log "安装完成！请重启 dsh web，然后刷新浏览器页面。"
log "功能测试: ./test-plugin.sh   |   验证概览: curl http://127.0.0.1:$PORT/session-hub/api/overview"
