/**
 * ExternalSessions — dsh-session-hub 侵入补丁（ui-workspace）。
 *
 * 在 DSH 侧边栏的工作区分组内，按来源（opencode / Claude / Antigravity / QoderCN）
 * 建立二级树状折叠子目录（Sub-tree Folders），默认折叠收拢，避免数百条外部会话平铺霸屏。
 *
 * 毫秒级极速导入：后端响应后立即跳转并移除外部行，避免卡顿。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import rows from './rows/Rows.module.css'

interface ExternalSession {
  source: string
  id: string
  title: string
  timeUpdated?: number
  imported?: boolean
}

const API = '/session-hub/api'

interface SourceBadgeMeta {
  label: string
  color: string
  bg: string
}

export const BADGE_CONFIG: Record<string, SourceBadgeMeta> = {
  opencode: { label: 'OpenCode', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.12)' },
  claude: { label: 'Claude', color: '#fb923c', bg: 'rgba(251, 146, 60, 0.14)' },
  antigravity: { label: 'Antigravity', color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.14)' },
  qodercn: { label: 'QoderCN', color: '#34d399', bg: 'rgba(52, 211, 153, 0.14)' },
  dsh: { label: 'DSH', color: '#60a5fa', bg: 'rgba(96, 165, 250, 0.12)' },
}

export function SourceBadge({ source }: { source: string }) {
  const cfg = BADGE_CONFIG[source] ?? { label: source, color: '#81858c', bg: 'rgba(255, 255, 255, 0.08)' }
  return (
    <span
      style={{
        fontSize: '9px',
        lineHeight: '14px',
        padding: '1px 4px',
        borderRadius: '3px',
        color: cfg.color,
        backgroundColor: cfg.bg,
        fontWeight: 500,
        marginRight: '6px',
        flexShrink: 0,
        letterSpacing: '0.02em',
      }}
    >
      {cfg.label}
    </span>
  )
}

export function SourceDot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: '5px',
        height: '5px',
        borderRadius: '50%',
        backgroundColor: color,
        flexShrink: 0,
        opacity: 0.8,
      }}
    />
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 0.15s ease',
        flexShrink: 0,
        opacity: 0.7,
      }}
    >
      <polyline points="6 4 10 8 6 12" />
    </svg>
  )
}

function FolderIcon({ color }: { color?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || 'currentColor'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, opacity: 0.85 }}
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function fmt(ts: number | undefined, now: number, zh: boolean): string {
  if (!ts) return ''
  const diff = Math.max(0, now - ts)
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000
  if (diff < MIN) return zh ? '刚刚' : 'now'
  if (diff < HOUR) { const n = Math.floor(diff / MIN); return zh ? `${n}分钟` : `${n}min` }
  if (diff < DAY) { const n = Math.floor(diff / HOUR); return zh ? `${n}小时` : `${n}h` }
  if (diff < 30 * DAY) { const n = Math.floor(diff / DAY); return zh ? `${n}天` : `${n}d` }
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function ExternalSessions({ cwd, expanded, now, t, onContinue, onExtCount, useSessions, sourceFilter }: {
  cwd: string | undefined
  expanded: boolean
  now: number
  t: WorkspaceBrowserProps['t']
  onContinue: (sessionId: string) => void
  onExtCount?: (n: number) => void
  useSessions: WorkspaceBrowserProps['useSessions']
  sourceFilter?: string
}) {
  const [sessions, setSessions] = useState<ExternalSession[] | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [emptyHint, setEmptyHint] = useState<string | null>(null)
  const byId = useSessions(s => s.byId)
  const byIdRef = useRef<Record<string, SessionSummary>>({})
  useEffect(() => { byIdRef.current = byId }, [byId])

  useEffect(() => {
    if (!cwd) return
    let alive = true
    setSessions(null)
    fetch(`${API}/sessions?cwd=${encodeURIComponent(cwd)}&_t=${Date.now()}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        // 过滤掉已由 DSH 原生加载的会话（仅在 ALL 模式下防止重复），并在特定工具视图下完整展示该工具所有会话
        const ext = (d.sessions ?? []).filter((s: { source: string; imported?: boolean }) => {
          if (s.source === 'dsh') return false
          if ((!sourceFilter || sourceFilter === 'all') && s.imported) return false
          if (sourceFilter && sourceFilter !== 'all' && s.source !== sourceFilter) return false
          return true
        })
        setSessions(ext)
        onExtCount?.(ext.length)
      })
      .catch(() => { if (alive) setSessions([]) })
    return () => { alive = false }
  }, [cwd, sourceFilter])

  if (!cwd || !expanded || sessions === null || sessions.length === 0) return null

  const open = (s: ExternalSession) => {
    if (opening !== null) return
    setOpening(s.id)
    fetch(`${API}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: s.source, id: s.id }),
    })
      .then((r) => r.json())
      .then((d) => {
        setOpening(null)
        if (!(d.ok && d.sessionId)) {
          if (d.error === 'empty session') {
            setEmptyHint(s.id)
            setTimeout(() => setEmptyHint(null), 2500)
          } else {
            console.warn('session-hub continue failed:', d)
          }
          return
        }
        const sid = String(d.sessionId)
        setSessions(prev => (prev ?? []).filter(x => x.id !== s.id))
        onExtCount?.(Math.max(0, (sessions?.length ?? 1) - 1))
        try {
          onContinue(sid)
        } catch (err) {
          console.warn('session-hub: onContinue failed:', err)
        }
      })
      .catch(() => setOpening(null))
  }

  const zh = t('session.new').includes('新')

  return (
    <>
      {sessions.map((s) => {
        const cfg = BADGE_CONFIG[s.source] ?? { label: s.source, color: '#81858c', bg: 'rgba(255, 255, 255, 0.08)' }
        return (
          <div
            key={`${s.source}:${s.id}`}
            className={rows.sessionRow}
            role="treeitem"
            aria-selected={false}
            onClick={() => open(s)}
            title={zh ? `来自 ${cfg.label}，点击直接打开` : `From ${cfg.label}, click to open`}
          >
            <span className={rows.slot}>
              <SourceDot color={cfg.color} />
            </span>
            <span className={rows.title} style={{ maxWidth: '175px' }}>
              {/^New session - \d{4}-/.test(s.title) ? (zh ? '（无标题）' : '(untitled)') : (s.title || s.id)}
            </span>
            <SourceBadge source={s.source} />
            <span className={rows.time}>
              {opening === s.id ? (zh ? '打开中…' : 'opening…') : emptyHint === s.id ? (zh ? '空会话' : 'empty') : fmt(s.timeUpdated, now, zh)}
            </span>
          </div>
        )
      })}
    </>
  )
}
