#!/usr/bin/env bash
# dsh-session-hub 安装脚本
# 用法: ./install.sh            （默认 DSH_HOME=~/.dsh）
#       DSH_HOME=/path/to/dsh ./install.sh
# 幂等：重复执行安全（更新代码、保留导入缓存 state.json）
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_NAME="dsh-session-hub"
PKG_NAME="@dsh-local/dsh-session-hub"
PORT="${DSH_PORT:-3210}"

log()  { printf '\033[32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[error]\033[0m %s\n' "$*"; exit 1; }

# ── 1. 检查 DSH 安装 ─────────────────────────────────────────────
[ -d "$DSH_HOME" ] || fail "未找到 DSH 目录: $DSH_HOME（可用环境变量 DSH_HOME 指定）"
[ -f "$DSH_HOME/config.yaml" ] || fail "未找到 $DSH_HOME/config.yaml，请先启动一次 DSH 生成配置"
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

# ── 4. config.yaml 挂载条目（cordis 声明式配置，幂等）───────────
if grep -q "id: $PLUGIN_NAME" "$DSH_HOME/config.yaml"; then
  log "config.yaml 已含 $PLUGIN_NAME 条目，跳过"
else
  cp "$DSH_HOME/config.yaml" "$DSH_HOME/config.yaml.bak.$(date +%s)"
  printf '\n- insert:\n    - id: %s\n      name: '"'"'%s'"'"'\n' "$PLUGIN_NAME" "$PKG_NAME" >> "$DSH_HOME/config.yaml"
  log "config.yaml 已添加挂载条目（原文件已备份）"
fi

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
