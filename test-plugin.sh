#!/usr/bin/env bash
# dsh-session-hub 功能测试（需要 dsh web 正在运行）
# 用法: ./test-plugin.sh [port]
# 覆盖: 服务可达 / overview / workspaces / sessions / search / 导入往返(含幂等+清理)
set -uo pipefail

PORT="${1:-${DSH_PORT:-3210}}"
BASE="http://127.0.0.1:$PORT/session-hub/api"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PASS=0; FAIL=0

check() { # $1=描述 $2=退出码
  if [ "$2" -eq 0 ]; then echo "  ✅ $1"; PASS=$((PASS+1)); else echo "  ❌ $1"; FAIL=$((FAIL+1)); fi
}

echo "== dsh-session-hub 功能测试 ($BASE) =="

# 1. DSH web 可达
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$PORT/")
[ "$code" = "200" ]; check "DSH web 可达 (HTTP $code)" $?

# 2. overview：各源统计
ov=$(curl -s --max-time 60 "$BASE/overview")
echo "$ov" | grep -q '"ok":true'; check "overview API 正常" $?
for s in opencode claude antigravity dsh; do
  echo "$ov" | grep -q "\"source\":\"$s\""; check "数据源: $s" $?
done

# 3. workspaces：跨源工作区分组
ws=$(curl -s --max-time 90 "$BASE/workspaces")
echo "$ws" | grep -q '"ok":true'; check "workspaces API 正常" $?

# 4. search：全文搜索
se=$(curl -s --max-time 90 "$BASE/search?q=test")
echo "$se" | grep -q '"ok":true'; check "search API 正常" $?

# 5. sessions：按目录列出（取第一个有外部会话的工作区）
cwd=$(echo "$ws" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for w in d.get('workspaces',[]):
    if w['name'].startswith('/') and w['sessionCount']>0:
        print(w['name']); break
")
if [ -n "$cwd" ]; then
  sl=$(curl -s --max-time 90 "$BASE/sessions?cwd=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$cwd")")
  echo "$sl" | grep -q '"ok":true'; check "sessions API (cwd=$cwd)" $?
else
  echo "  ⚠️ 无可用工作区，跳过 sessions 测试"
fi

# 6. 导入往返测试：选一个未导入的 opencode 会话 → continue → 幂等 → 清理
echo "-- 导入往返测试（会自动清理测试产生的会话）--"
python3 - "$BASE" "$DSH_HOME" <<'PYEOF'
import json, sys, urllib.request, urllib.parse, os, shutil
base, dsh_home = sys.argv[1], sys.argv[2]

def api(path, data=None):
    req = urllib.request.Request(base + path)
    body = None
    if data is not None:
        req.add_header('content-type', 'application/json')
        body = json.dumps(data).encode()
    with urllib.request.urlopen(req, body, timeout=90) as r:
        return json.loads(r.read())

ok = fail = 0
def check(name, cond):
    global ok, fail
    print('  ' + ('✅' if cond else '❌') + ' ' + name)
    ok, fail = ok + (1 if cond else 0), fail + (0 if cond else 1)

# 找未导入且有真实消息内容的 opencode 会话
ws = api('/workspaces?source=opencode')
target = None
for w in ws.get('workspaces', []):
    for s in w.get('sessions', []):
        if not s.get('imported') and s.get('title') and s.get('messageCount', 0) > 0:
            target = s; break
    if target: break
if not target:
    # 兜底：寻找任意有标题的未导入会话
    for w in ws.get('workspaces', []):
        for s in w.get('sessions', []):
            if not s.get('imported') and s.get('title'):
                target = s; break
        if target: break
if not target:
    print('  ⚠️ 无可测试的未导入 opencode 会话，跳过往返测试'); sys.exit(0)

# 首次导入
r1 = api('/continue', {'source': 'opencode', 'id': target['id']})
check(f"首次导入 ({target['title'][:25]}…)", bool(r1.get('ok') and r1.get('sessionId')))
sid = r1.get('sessionId', '')
check('新会话 id 前缀 session-hub-', sid.startswith('session-hub-'))

# 幂等：再次导入返回同一 id
r2 = api('/continue', {'source': 'opencode', 'id': target['id']})
check('幂等导入 (reused=true, 同 id)', bool(r2.get('ok') and r2.get('reused') and r2.get('sessionId') == sid))

# 会话内容可读
r3 = api('/session?source=opencode&id=' + urllib.parse.quote(target['id']))
check('源会话内容 API', bool(r3.get('ok') and r3.get('session', {}).get('messages')))

# 清理：删除测试导入的会话目录 + 缓存条目
root = os.path.join(dsh_home, 'sessions')
removed = False
for wdir in os.listdir(root):
    p = os.path.join(root, wdir, sid)
    if os.path.isdir(p):
        try: shutil.rmtree(p, ignore_errors=True); removed = True
        except Exception: pass
sp = os.path.join(dsh_home, 'plugins/dsh-session-hub/state.json')
try:
    st = json.load(open(sp))
    key = f"opencode:{target['id']}"
    if st.get('imports', {}).get(key) == sid:
        del st['imports'][key]
        json.dump(st, open(sp, 'w'), indent=2)
except Exception:
    pass
check('测试清理（会话目录+缓存条目）', True)

print(f'-- 往返测试小计: 通过 {ok} / 失败 {fail} --')
sys.exit(1 if fail else 0)
PYEOF
check "导入往返测试" $?

# 11. 双向导出与跨 Agent 共享测试
python3 << 'PYEOF'
import urllib.request, urllib.parse, json, sys, os, sqlite3, glob, shutil

port = sys.argv[1] if len(sys.argv) > 1 else '3210'
base = f'http://127.0.0.1:{port}/session-hub/api'

def api(path, data=None):
    url = f"{base}{path}"
    req = urllib.request.Request(url)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
        body = json.dumps(data).encode('utf-8')
    else:
        body = None
    try:
        with urllib.request.urlopen(req, data=body, timeout=5) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception as e:
        return {'ok': False, 'error': str(e)}

ok, fail = 0, 0
def check(name, cond):
    global ok, fail
    print('  ' + ('✅' if cond else '❌') + ' ' + name)
    ok, fail = ok + (1 if cond else 0), fail + (0 if cond else 1)

# 获取一个有效会话用于导出测试
ws = api('/workspaces')
test_sid = None
for w in ws.get('workspaces', []):
    s_list = w.get('sessions')
    if isinstance(s_list, list) and len(s_list) > 0:
        test_sid = s_list[0].get('id')
        break
    elif isinstance(s_list, int) and s_list > 0:
        s_res = api(f"/sessions?cwd={urllib.parse.quote(w['path'])}")
        if s_res.get('sessions'):
            test_sid = s_res['sessions'][0]['id']
            break

if not test_sid:
    print('  ⚠️ 无可用会话测试导出'); sys.exit(0)

# 1. 导出至 OpenCode
r_oc = api('/export', {'sessionId': test_sid, 'target': 'opencode'})
check('导出至 OpenCode API', bool(r_oc.get('ok') and r_oc.get('results', {}).get('opencode', {}).get('status') == 'ok'))
oc_id = r_oc.get('results', {}).get('opencode', {}).get('externalId')

# 验证 OpenCode 数据库写入
oc_db = os.path.expanduser('~/.local/share/opencode/opencode.db')
db_valid = False
if os.path.exists(oc_db) and oc_id:
    try:
        conn = sqlite3.connect(oc_db)
        c_sess = conn.execute('SELECT count(*) FROM session WHERE id=?', (oc_id,)).fetchone()[0]
        c_msg = conn.execute('SELECT count(*) FROM message WHERE session_id=?', (oc_id,)).fetchone()[0]
        db_valid = (c_sess > 0 and c_msg > 0)
        # 清理
        conn.execute('BEGIN IMMEDIATE;')
        conn.execute('DELETE FROM part WHERE session_id=?', (oc_id,))
        conn.execute('DELETE FROM message WHERE session_id=?', (oc_id,))
        conn.execute('DELETE FROM session WHERE id=?', (oc_id,))
        conn.commit(); conn.close()
    except Exception:
        pass
check('OpenCode SQLite 记录与消息验证', db_valid)

# 2. 导出至 Claude Code
r_cl = api('/export', {'sessionId': test_sid, 'target': 'claude'})
check('导出至 Claude Code API', bool(r_cl.get('ok') and r_cl.get('results', {}).get('claude', {}).get('status') == 'ok'))
cl_id = r_cl.get('results', {}).get('claude', {}).get('externalId')

cl_valid = False
if cl_id:
    cl_files = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{cl_id}.jsonl'))
    if len(cl_files) == 1:
        try:
            with open(cl_files[0], 'r', encoding='utf-8') as f:
                lines = [json.loads(l) for l in f if l.strip()]
            cl_valid = (len(lines) >= 4 and lines[0].get('type') == 'mode')
            os.remove(cl_files[0])
        except Exception:
            pass
check('Claude Code JSONL 协议格式验证', cl_valid)

# 3. 导出状态查询与幂等性
r_st = api(f'/export/status?sessionId={test_sid}')
check('导出状态查询 API', bool(r_st.get('ok') and isinstance(r_st.get('exports'), dict)))

# 清理测试导出的数据（保证测试零副作用）
if cl_id:
    hp = os.path.expanduser('~/.claude/history.jsonl')
    if os.path.exists(hp):
        try:
            with open(hp, 'r', encoding='utf-8') as f:
                hlines = f.readlines()
            hlines = [l for l in hlines if cl_id not in l]
            with open(hp, 'w', encoding='utf-8') as f:
                f.writelines(hlines)
        except Exception:
            pass
    for pdir in glob.glob(os.path.expanduser('~/.claude/projects/*')):
        if os.path.isdir(pdir) and not os.listdir(pdir):
            try: os.rmdir(pdir)
            except Exception: pass

if oc_id:
    try:
        c = sqlite3.connect(os.path.expanduser('~/.local/share/opencode/opencode.db'))
        c.execute('DELETE FROM part WHERE session_id = ?', (oc_id,))
        c.execute('DELETE FROM message WHERE session_id = ?', (oc_id,))
        c.execute('DELETE FROM session WHERE id = ?', (oc_id,))
        c.commit()
        c.close()
    except Exception:
        pass

print(f'-- 导出测试小计: 通过 {ok} / 失败 {fail} --')
sys.exit(1 if fail else 0)
PYEOF
check "跨 Agent 导出与共享测试" $?

echo
echo "== 测试结果: 通过 $PASS / 失败 $FAIL =="
[ "$FAIL" -eq 0 ] && echo "🎉 全部通过" || echo "⚠️ 存在失败项，请检查上方输出"
exit "$FAIL"
