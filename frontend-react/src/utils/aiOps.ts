// 관리자 › AI 운영(시안 F1·F2·I1·I2) — API 모양·순수 도우미. 화면은 pages/admin/ai-ops.tsx + components/admin/aiOps/*.
import { $fetch, errorStatus } from '~/lib/api'

export type AiOpsTab = 'usage' | 'writes' | 'audit' | 'policy' | 'feedback'
export const AI_OPS_TABS: AiOpsTab[] = ['usage', 'writes', 'audit', 'policy', 'feedback']
export const AI_OPS_BASE = '/admin/ai-ops'

/** 경로 → 탭(/admin/ai-ops = 사용량, 모르는 하위 경로도 사용량) */
export function tabFromPath(path: string): AiOpsTab {
  const rest = path.startsWith(AI_OPS_BASE) ? path.slice(AI_OPS_BASE.length).replace(/^\/+|\/+$/g, '') : ''
  return (AI_OPS_TABS as string[]).includes(rest) ? (rest as AiOpsTab) : 'usage'
}
export function tabPath(tab: AiOpsTab): string {
  return tab === 'usage' ? AI_OPS_BASE : `${AI_OPS_BASE}/${tab}`
}

export interface UsageUser { user_id: string; name: string; groups: string[]; questions: number; tool_calls: number; tool_failures: number }
export interface UsageTool { tool: string; calls: number; failures: number; success_rate: number | null; p50_ms: number | null; p95_ms: number | null }
export interface UsageGroup { group: string; users?: number; questions?: number; tool_calls?: number }
export interface WriteBucket { executed: number; undone: number; rejected: number; canceled: number; expired: number; failed: number; pending: number }
export interface UsageResponse {
  days: number
  totals: {
    tool_calls: number; tool_success_rate: number | null; questions: number; connector_calls: number; builtin_calls: number
    write_tool_calls: number; tool_failures: number; active_users: number; users_total: number; truncated: boolean
  }
  daily: { date: string; tool_calls: number; questions: number }[]
  users: UsageUser[]
  groups: UsageGroup[]
  tools: UsageTool[]
  writes_summary: { low: WriteBucket; high: WriteBucket; low_after_untrusted: number; untrusted_window_min: number }
  feedback: { up: number; down: number; reasons: Record<string, number> }
}

export interface AuditItem {
  at: string | null; user_id: string | null; user_name: string | null; action: string; tool: string
  source?: string | null; client?: string | null; kind?: string | null
  result: string; code: string | null
}
export interface AuditResponse { items: AuditItem[]; has_more: boolean; next_cursor: string | null; retention_years: number }
export type AuditSource = '' | 'builtin' | 'connector'
export interface AuditFilters { q: string; source: AuditSource; failedOnly: boolean; days: number }

export type SnapshotState = 'attached' | 'expired' | 'conversation_deleted' | 'admin_deleted' | 'none'
export interface FeedbackItem {
  id: string; at: string | null; rating: string; reasons: string[]; comment: string; model: string | null
  tools: string[]; snapshot: SnapshotState; snapshot_expires_at: string | null; who: string
}
export interface FeedbackResponse {
  items: FeedbackItem[]; total: number; has_more: boolean; next_cursor: string | null; attached_total: number
  reason_counts: Record<string, number>; snapshot_ttl_days: number
}
export interface FeedbackSnapshot {
  id: string; at: string | null; reasons: string[]; comment: string; model: string | null
  messages: { role: 'user' | 'assistant'; content: string }[]; expires_at: string | null
}

export interface Governance {
  mask_pii: boolean; mcp_write_enabled: boolean; mcp_rate_limit_per_min: number
  audit_retention_years: number; local_only: boolean
}

export const FEEDBACK_REASONS = ['inaccurate', 'wrong_source', 'ignored_instructions', 'too_long', 'too_short', 'other'] as const

export interface UsageState { data: UsageResponse | null; loading: boolean; error: LoadError | null }

/** 실패 기록 — 오류 타일 보조 줄("/api/admin/ai/usage · 504 · 11:52") */
export interface LoadError { path: string; status?: number; at: Date }
export function loadError(path: string, e: unknown): LoadError {
  return { path, status: errorStatus(e), at: new Date() }
}
export function errorDetail(err: LoadError): string {
  const hh = String(err.at.getHours()).padStart(2, '0')
  const mm = String(err.at.getMinutes()).padStart(2, '0')
  return `${err.path} · ${err.status ?? '—'} · ${hh}:${mm}`
}

const q = (o: Record<string, string | number | boolean | undefined | null>) => {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === '' || v === undefined || v === null || v === false) continue
    out[k] = v === true ? 'true' : v
  }
  return out
}

export const aiOpsApi = {
  usage: (days: number) => $fetch<UsageResponse>('/api/admin/ai/usage', { credentials: 'include', query: { days } }),
  audit: (f: AuditFilters, cursor?: string | null) => $fetch<AuditResponse>('/api/admin/ai/audit', {
    credentials: 'include', query: q({ q: f.q.trim(), source: f.source, failed_only: f.failedOnly, days: f.days, cursor: cursor || '', limit: 100 }),
  }),
  auditCsvUrl: (f: AuditFilters) => {
    const p = new URLSearchParams(Object.entries(q({ q: f.q.trim(), source: f.source, failed_only: f.failedOnly, days: f.days })).map(([k, v]) => [k, String(v)]))
    const s = p.toString()
    return `/api/admin/ai/audit.csv${s ? `?${s}` : ''}`
  },
  feedback: (o: { days: number; reason: string; attachedOnly: boolean; cursor?: string | null; limit?: number }) =>
    $fetch<FeedbackResponse>('/api/admin/ai/feedback', {
      credentials: 'include', query: q({ days: o.days, reason: o.reason, attached_only: o.attachedOnly, cursor: o.cursor || '', limit: o.limit ?? 50 }),
    }),
  snapshot: (id: string) => $fetch<FeedbackSnapshot>(`/api/admin/ai/feedback/${encodeURIComponent(id)}/snapshot`, { credentials: 'include' }),
  deleteSnapshot: (id: string) => $fetch<{ id: string; snapshot: SnapshotState }>(`/api/admin/ai/feedback/${encodeURIComponent(id)}/snapshot`, { method: 'DELETE', credentials: 'include' }),
  config: () => $fetch<{ governance: Governance }>('/api/ai/config', { credentials: 'include' }),
  saveGovernance: (g: Partial<Governance>) => $fetch<{ governance: Governance }>('/api/ai/governance', { method: 'PUT', credentials: 'include', body: g }),
}

/** 410 응답의 스냅샷 상태 코드 */
export function snapshotGoneCode(e: unknown): SnapshotState | null {
  if (errorStatus(e) !== 410) return null
  const d = (e as { data?: { detail?: { code?: string } } })?.data?.detail
  const c = d?.code
  return c === 'expired' || c === 'conversation_deleted' || c === 'admin_deleted' || c === 'none' ? c : 'none'
}

// ── 표시 도우미 ──
export function fmtNum(n: number | null | undefined, locale = 'ko-KR'): string {
  return n == null ? '—' : Math.round(n).toLocaleString(locale)
}
export function fmtRate(r: number | null | undefined): string {
  return r == null ? '—' : `${(r * 100).toFixed(1)}%`
}
/** 'MM-DD HH:mm(:ss)' — 로컬 시각 */
export function shortStamp(iso: string | null | undefined, seconds = false): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${seconds ? `:${p(d.getSeconds())}` : ''}`
}
/** 'YYYY-MM-DD' → 'MM-DD' */
export function mmdd(date: string): string {
  return date.length >= 10 ? date.slice(5, 10) : date
}
/** 막대 차트 눈금 위 끝 — 최댓값을 1·2·4·5 × 10^n 으로 올린 값(0 이면 10) */
export function niceMax(max: number): number {
  if (!(max > 0)) return 10
  const pow = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 2, 4, 5, 10]) if (m * pow >= max) return m * pow
  return 10 * pow
}

/** 감사 결과 → 배지 톤 */
export function resultTone(result: string): 'success' | 'danger' | 'neutral' | 'warning' {
  if (result === 'ok' || result === 'executed') return 'success'
  if (result === 'failed' || result === 'rejected') return 'danger'
  return 'neutral'
}
