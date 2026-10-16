#!/usr/bin/env bash
# dsh-session-hub 卸载脚本（不删除已导入的 DSH 会话数据）
# 用法: ./uninstall.sh
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_NAME="dsh-session-hub"

log() { printf '\033[32m[uninstall]\033[0m %s\n' "$*"; }

# ── 1. 移除挂载条目（先备份）───────────────────────────────────
# 条目写在 $DSH_HOME/cordis.patch.yml（home 级 patch 层）。旧版本会写
# config.yaml，那个文件在 0.2.x 里没有任何读取方，所以两边都要清理：
# 老用户可能确实留了条目在 config.yaml 里。
remove_entry() {
  local file="$1" label="$2"
  [ -f "$file" ] || return 0
  grep -q "id: $PLUGIN_NAME" "$file" 2>/dev/null || return 0
  cp "$file" "$file.bak.$(date +%s)"
  python3 - "$file" "$PLUGIN_NAME" <<'PYEOF'
import sys
path, name = sys.argv[1], sys.argv[2]
text = open(path).read()
lines = text.split('\n')
kept, i = [], 0
while i < len(lines):
    line = lines[i]
    # Drop a whole `- insert:` block whose list contains our id.
    if line.startswith('- insert:'):
        j = i + 1
        while j < len(lines) and (not lines[j].strip() or lines[j].startswith(('    ', '\t'))):
            j += 1
        block = '\n'.join(lines[i:j])
        if f'- id: {name}\n' in block + '\n':
            i = j
            continue
        kept.extend(lines[i:j])
        i = j
        continue
    kept.append(line)
    i += 1
text = '\n'.join(kept)
# A comments-only (or empty) patch file fails boot: dsh requires a top-level
# YAML array. Collapse to `[]` when no entries remain.
if not any(ln.lstrip().startswith('- ') for ln in text.split('\n')):
    head = [ln for ln in text.split('\n') if ln.lstrip().startswith('#')]
    text = ('\n'.join(head).rstrip('\n') + '\n' if head else '') + '[]\n'
open(path, 'w').write(text)
PYEOF
  log "$label 条目已移除（原文件已备份）"
}

remove_entry "$DSH_HOME/cordis.patch.yml" "cordis.patch.yml"
remove_entry "$DSH_HOME/config.yaml" "config.yaml（旧版本遗留）"

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
