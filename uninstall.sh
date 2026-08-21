#!/usr/bin/env bash
# dsh-session-hub 卸载脚本（不删除已导入的 DSH 会话数据）
# 用法: ./uninstall.sh
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_NAME="dsh-session-hub"

log() { printf '\033[32m[uninstall]\033[0m %s\n' "$*"; }

# ── 1. 移除 config.yaml 挂载条目（先备份）──────────────────────
if grep -q "id: $PLUGIN_NAME" "$DSH_HOME/config.yaml" 2>/dev/null; then
  cp "$DSH_HOME/config.yaml" "$DSH_HOME/config.yaml.bak.$(date +%s)"
  python3 - "$DSH_HOME/config.yaml" "$PLUGIN_NAME" <<'PYEOF'
import sys, re
path, name = sys.argv[1], sys.argv[2]
src = open(path).read()
# 按空行分块，移除包含目标插件 id 的 insert 块
blocks = re.split(r'\n\s*\n', src)
kept = [b for b in blocks if not (('- id: ' + name) in b and '- insert:' in b)]
open(path, 'w').write('\n\n'.join(kept))
PYEOF
  log "config.yaml 条目已移除（原文件已备份）"
else
  log "config.yaml 无 $PLUGIN_NAME 条目"
fi

# ── 2. 移除包别名 ────────────────────────────────────────────────
rm -f "$HOME/node_modules/@dsh-local/$PLUGIN_NAME"
log "包别名已移除"

# ── 3. 移走插件目录（不直接删除，可恢复；state.json 导入缓存一并保留在内）──
if [ -d "$DSH_HOME/plugins/$PLUGIN_NAME" ]; then
  mv "$DSH_HOME/plugins/$PLUGIN_NAME" "$DSH_HOME/plugins/$PLUGIN_NAME.removed.$(date +%s)"
  log "插件目录已移走（重命名为 *.removed.*，可手动恢复或删除）"
fi

echo
log "卸载完成，请重启 dsh web。"
log "注意 1：已导入的 DSH 会话（sessions 目录中的 session-hub-* 会话）未被删除，仍可在侧边栏看到。"
log "注意 2：ui-workspace 补丁需手动还原："
log "  cd \$DSH_HOME/source/current && git checkout -- packages/client/ui-workspace"
log "  pnpm --filter @deepseek-ai/dsh-client-ui-workspace bundle"
