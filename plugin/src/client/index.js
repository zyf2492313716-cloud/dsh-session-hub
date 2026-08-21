/**
 * dsh-session-hub — client half.
 *
 * 在 DSH Web 注册客户端组件：Settings → General 信息行（官方 settings.general.item
 * 扩展点），展示插件运行状态与跨工具会话概览。数据全部来自 node half 的
 * /session-hub/api 只读接口。
 */
import { createElement as h, useEffect, useState, useCallback } from 'react'

const API = '/session-hub/api'
const SOURCES = [
  { id: 'all', label: '全部' },
  { id: 'opencode', label: 'opencode' },
  { id: 'claude', label: 'Claude' },
  { id: 'dsh', label: 'DSH' },
  { id: 'qodercn', label: 'QoderCN' },
]

const STYLE = `
.session-hub{display:flex;flex-direction:column;height:100%;min-height:0;padding:0 20px 20px;gap:12px;font-size:13px}
.session-hub .sh-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--dsh-border,#2c3140)}
.session-hub .sh-title{font-size:15px;font-weight:600;margin-right:auto}
.session-hub .sh-chip{background:var(--dsh-bg-2,#171a23);border:1px solid var(--dsh-border,#2c3140);border-radius:10px;padding:2px 10px;font-size:12px;color:var(--dsh-mut,#8b90a0)}
.session-hub .sh-search{flex:1;min-width:180px;max-width:360px;padding:7px 12px;border-radius:8px;border:1px solid var(--dsh-border,#2c3140);background:var(--dsh-bg-1,#12151d);color:var(--dsh-fg,#e6e8ee)}
.session-hub .sh-src{display:flex;gap:4px}
.session-hub .sh-src button{border:1px solid var(--dsh-border,#2c3140);background:transparent;color:var(--dsh-mut,#8b90a0);padding:4px 10px;border-radius:8px;cursor:pointer;font-size:12px}
.session-hub .sh-src button.on{background:var(--dsh-acc,#4f8cff);border-color:var(--dsh-acc,#4f8cff);color:#fff}
.session-hub .sh-body{display:flex;gap:12px;flex:1;min-height:0}
.session-hub .sh-list{flex:0 0 360px;overflow:auto;border:1px solid var(--dsh-border,#2c3140);border-radius:10px;background:var(--dsh-bg-2,#171a23)}
.session-hub .sh-ws{padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--dsh-border,#20242f)}
.session-hub .sh-ws:hover{background:var(--dsh-bg-1,#1c202b)}
.session-hub .sh-ws .n{font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px}
.session-hub .sh-ws .c{color:var(--dsh-mut,#8b90a0);font-size:11px;margin-left:auto}
.session-hub .sh-sess{display:flex;gap:6px;align-items:baseline;padding:4px 6px;margin:2px 0 2px 14px;border-radius:6px;cursor:pointer;font-size:12px}
.session-hub .sh-sess:hover{background:var(--dsh-bg-1,#1c202b)}
.session-hub .sh-sess .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.session-hub .sh-sess .b{color:var(--dsh-mut,#8b90a0);font-size:10px;flex-shrink:0}
.session-hub .sh-sess.sel{background:var(--dsh-acc,#4f8cff);color:#fff}
.session-hub .sh-detail{flex:1;overflow:auto;border:1px solid var(--dsh-border,#2c3140);border-radius:10px;background:var(--dsh-bg-2,#171a23);padding:14px}
.session-hub .sh-dhead{margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--dsh-border,#2c3140)}
.session-hub .sh-dhead .t{font-size:14px;font-weight:600}
.session-hub .sh-dhead .m{color:var(--dsh-mut,#8b90a0);font-size:11px;margin-top:2px}
.session-hub .sh-msg{margin:10px 0}
.session-hub .sh-who{font-size:10px;color:var(--dsh-mut,#8b90a0);margin-bottom:2px}
.session-hub .sh-text{background:var(--dsh-bg-1,#12151d);border-radius:8px;padding:8px 12px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.55}
.session-hub .sh-reason{background:rgba(108,92,231,.12);border-left:3px solid #6c5ce7;border-radius:6px;padding:6px 10px;margin:4px 0;font-size:12px;color:var(--dsh-mut,#aab)}
.session-hub details.sh-tool{background:var(--dsh-bg-1,#12151d);border-radius:6px;margin:4px 0;font-size:12px}
.session-hub details.sh-tool summary{cursor:pointer;padding:5px 10px;color:#9fd0ff}
.session-hub details.sh-tool .d{padding:5px 10px;border-top:1px solid var(--dsh-border,#2c3140);white-space:pre-wrap;max-height:200px;overflow:auto;color:var(--dsh-mut,#b8c0d4)}
.session-hub .sh-patch{background:rgba(46,160,67,.1);border-radius:6px;padding:5px 10px;margin:4px 0;font-size:12px;color:#8fd8a8}
.session-hub .sh-empty{color:var(--dsh-mut,#8b90a0);text-align:center;padding:40px;font-size:13px}
.session-hub .sh-sync{display:flex;align-items:center;gap:10px;padding:6px 0}
.session-hub .sh-syncbtn{background:var(--dsh-acc,#4f8cff);border:none;color:#fff;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px}
.session-hub .sh-syncbtn:disabled{opacity:.5;cursor:wait}
.session-hub .sh-syncmsg{color:var(--dsh-mut,#8b90a0);font-size:12px}
`

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function SessRow({ s, onOpen, selected }) {
  return h('div', { className: `sh-sess${selected ? ' sel' : ''}`, onClick: () => onOpen(s) },
    h('span', { className: 'b' }, s.source.slice(0, 1).toUpperCase()),
    h('span', { className: 't' }, s.title || s.id),
    h('span', { className: 'b' }, fmtTime(s.timeUpdated)),
  )
}

function SessionDetail({ session }) {
  if (!session) return h('div', { className: 'sh-empty' }, '从左侧选择一个会话查看内容')
  const parts = (session.messages ?? []).flatMap((m) => m.parts.map((p) => ({ ...p, role: m.role, time: m.time })))
  return h('div', {},
    h('div', { className: 'sh-dhead' },
      h('div', { className: 't' }, session.title || session.id),
      h('div', { className: 'm' },
        `${session.source} · ${session.messages?.length ?? 0} 条消息 · ${session.cwd || ''}${session.model ? ' · ' + (session.model.modelID || session.model) : ''}${session.cost ? ' · $' + Number(session.cost).toFixed(3) : ''}`,
      ),
    ),
    h('div', {},
      (session.messages ?? []).map((m, i) =>
        h('div', { className: 'sh-msg', key: i },
          h('div', { className: 'sh-who' }, `${m.role || '?'} · ${fmtTime(m.time)}`),
          (m.parts ?? []).map((p, j) => {
            if (p.type === 'text') return h('div', { className: 'sh-text', key: j, dangerouslySetInnerHTML: { __html: esc(p.text).replace(/\n/g, '<br>') } })
            if (p.type === 'reasoning') return h('div', { className: 'sh-reason', key: j }, `💭 ${esc((p.text || '').slice(0, 800))}`)
            if (p.type === 'tool') return h('details', { className: 'sh-tool', key: j },
              h('summary', {}, `🔧 ${esc(p.tool || 'tool')}${p.title ? ' · ' + esc(p.title) : ''}`),
              (p.input ? h('div', { className: 'd' }, `入参: ${esc(p.input)}`) : null),
              (p.output ? h('div', { className: 'd' }, `输出: ${esc(p.output)}`) : null),
            )
            if (p.type === 'patch') return h('div', { className: 'sh-patch', key: j }, `📝 ${esc((p.files || []).join(', '))}${p.hash ? ' (' + p.hash.slice(0, 8) + ')' : ''}`)
            if (p.type === 'file') return h('div', { className: 'sh-patch', key: j }, `🖼️ ${esc(p.file || '')}`)
            return null
          }),
        ),
      ),
    ),
  )
}

export function SessionHub() {
  const [overview, setOverview] = useState(null)
  const [workspaces, setWorkspaces] = useState([])
  const [expanded, setExpanded] = useState({})
  const [source, setSource] = useState('all')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [selected, setSelected] = useState(null)
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch(`${API}/overview`).then((r) => r.json()).then((d) => setOverview(d.sources ?? [])).catch(() => {})
    refresh()
  }, [])

  const refresh = useCallback((src = source) => {
    setLoading(true)
    fetch(`${API}/workspaces?source=${src}`).then((r) => r.json()).then((d) => {
      setWorkspaces(d.workspaces ?? [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [source])

  useEffect(() => { refresh(source) }, [source])

  const runSearch = useCallback((q) => {
    if (!q || !q.trim()) { setResults(null); return }
    setLoading(true)
    fetch(`${API}/search?q=${encodeURIComponent(q)}&source=${source}`).then((r) => r.json()).then((d) => {
      setResults(d.results ?? [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [source])

  let timer = null
  const onQuery = (v) => {
    setQuery(v)
    clearTimeout(timer)
    timer = setTimeout(() => runSearch(v), 400)
  }

  const openSession = (s) => {
    setSelected(s)
    setLoading(true)
    fetch(`${API}/session?source=${s.source}&id=${encodeURIComponent(s.id)}`).then((r) => r.json()).then((d) => {
      setSession(d.session ?? null)
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  const toggleWs = (name) => setExpanded((p) => ({ ...p, [name]: !p[name] }))

  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const doSync = () => {
    setSyncing(true)
    setSyncMsg('')
    fetch(`${API}/workspaces/sync`, { method: 'POST' }).then((r) => r.json()).then((d) => {
      setSyncMsg(`已同步 ${d.synced?.length ?? 0} 个工作区到 DSH 侧边栏${d.failed?.length ? `，${d.failed.length} 个失败` : ''}`)
      setSyncing(false)
      refresh(source)
    }).catch(() => { setSyncMsg('同步失败'); setSyncing(false) })
  }

  return h('div', { className: 'session-hub' },
    h('div', { className: 'sh-head' },
      h('span', { className: 'sh-title' }, '会话库'),
      (overview ?? []).map((s) => h('span', { className: 'sh-chip', key: s.source }, `${s.source} ${s.sessions}`)),
      h('input', { className: 'sh-search', placeholder: '搜索标题 / 内容（如 "brawl" 或中文）…', value: query, onChange: (e) => onQuery(e.target.value) }),
      h('div', { className: 'sh-src' }, SOURCES.map((s) => h('button', {
        key: s.id, className: source === s.id ? 'on' : '', onClick: () => setSource(s.id),
      }, s.label))),
    ),
    h('div', { className: 'sh-sync' },
      h('button', { className: 'sh-syncbtn', disabled: syncing, onClick: doSync }, syncing ? '同步中…' : '⇄ 同步工作区到 DSH 侧边栏'),
      syncMsg && h('span', { className: 'sh-syncmsg' }, syncMsg),
    ),
    h('div', { className: 'sh-body' },
      h('div', { className: 'sh-list' },
        results !== null
          ? h('div', {},
              h('div', { className: 'sh-ws' }, h('div', { className: 'n' }, `🔍 搜索结果 (${results.length})`, h('span', { className: 'c' }, '点击查看'))),
              results.map((r) => h(SessRow, { key: r.source + r.id, s: r, onOpen: openSession, selected: selected && selected.id === r.id && selected.source === r.source })),
            )
          : workspaces.map((w) =>
              h('div', { className: 'sh-ws', key: w.name },
                h('div', { className: 'n', onClick: () => toggleWs(w.name) },
                  `${w.inDsh ? '📌' : '📁'} ${w.name}`,
                  h('span', { className: 'c' }, `${w.inDsh ? '已同步 · ' : ''}${w.sessionCount} 会话`)),
                expanded[w.name] && w.sessions.slice(0, 200).map((s) =>
                  h(SessRow, { key: s.source + s.id, s, onOpen: openSession, selected: selected && selected.id === s.id && selected.source === s.source })),
              ),
            ),
        loading && h('div', { className: 'sh-empty' }, '加载中…'),
      ),
      h('div', { className: 'sh-detail' }, h(SessionDetail, { session })),
    ),
  )
}

/**
 * Settings → General 信息行：展示插件运行状态与各源会话概览。
 * 注册到官方公开扩展点 settings.general.item（list 槽，ui-permission 同款范式）。
 */
function SessionHubSettingsRow() {
  const [overview, setOverview] = useState(null)
  useEffect(() => {
    let alive = true
    fetch(`${API}/overview`)
      .then((r) => r.json())
      .then((d) => { if (alive) setOverview(d.sources ?? []) })
      .catch(() => { if (alive) setOverview([]) })
    return () => { alive = false }
  }, [])
  const total = (overview ?? []).reduce((n, s) => n + (s.sessions ?? 0), 0)
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', minWidth: 0 } },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontWeight: 600, fontSize: 14 } }, '会话库 · dsh-session-hub'),
      h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 2 } },
        overview === null
          ? '状态检查中…'
          : `已连接 · 共 ${total} 个外部会话（${(overview ?? []).map((s) => `${s.source} ${s.sessions}`).join(' / ')}）`,
      ),
    ),
  )
}

export const inject = ['slots']

/**
 * 客户端入口：注册 Settings → General 信息行。
 * 会话库 tab 已弃用（2026-08-07）：左侧工作区的 ExternalSessions 覆盖了
 * 外部会话的浏览与导入（node half 提供 /session-hub/api）。SessionHub 组件
 * 保留在源码中备恢复——恢复 tab 时在此处追加注册即可。
 */
export function apply(ctx) {
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'dsh-session-hub',
    order: 100,
  }, SessionHubSettingsRow))
}
