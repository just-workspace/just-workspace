/**
 * AI 쓰기 승인 — 요청 객체 형태와 순수 도우미. 채팅 카드와 승인 대기함이 공용으로 사용한다.
 * 요청 객체 = backend app/mcp/writes.py to_dict. 시각 판단은 항상 서버 시각 기준:
 *   offset = server_now − 수신 시점의 클라이언트 시각,  서버 현재 시각 = Date.now() + offset.
 * 클라이언트 시계만으로 만료·되돌리기 잔여 시간을 계산하지 않는다(시안 회신 rA-1·rA-4).
 */

export type ApprovalStatus = 'pending' | 'executed' | 'failed' | 'rejected' | 'canceled' | 'expired' | 'undone'

export interface ApprovalPreviewRow {
  field: string
  label: string
  before: unknown
  after: unknown
}

export interface ApprovalEditable {
  field: string
  label: string
  type: string
  enum?: unknown[] | null
  multiline?: boolean
}

export interface ApprovalReadExternal {
  kind?: string | null
  at?: string | null
  from?: string | null
  subject?: string | null
  label?: string | null
}

export interface ApprovalRequest {
  id: string
  tool: string
  title: string
  risk: 'low' | 'high' | string
  status: ApprovalStatus
  source: 'ai' | 'mcp' | 'internal' | string
  client_kind?: string | null
  client_name?: string | null
  target_summary?: string | null
  conversation_id?: string | null
  after_untrusted?: boolean
  args: Record<string, unknown>
  preview: ApprovalPreviewRow[]
  editable: ApprovalEditable[]
  read_external?: ApprovalReadExternal | null
  /** 자동 수락·허용 규칙이 있어도 확인을 요청하는 사유 코드 — 'visible_after_untrusted' = 외부 내용을 읽은 뒤 수행하는, 타인에게 노출되는 쓰기 */
  ask_reason?: string | null
  result?: unknown
  error?: string | null
  reject_reason?: string | null
  created_at?: string | null
  expires_at?: string | null
  decided_at?: string | null
  executed_at?: string | null
  can_undo?: boolean
  undo_until?: string | null
  server_now?: string | null
}

export interface ApprovalListResponse {
  items: ApprovalRequest[]
  has_more: boolean
  next_cursor: string | null
  pending: number
  server_now?: string
}

/** 서버 시각 − 클라이언트 시각(ms). server_now 가 없거나 유효하지 않으면 0 */
export function serverOffset(serverNow: string | null | undefined, clientNow: number = Date.now()): number {
  if (!serverNow) return 0
  const t = Date.parse(serverNow)
  return Number.isFinite(t) ? t - clientNow : 0
}

/** 서버 기준 현재 시각(ms) */
export function serverNowMs(offset: number, clientNow: number = Date.now()): number {
  return clientNow + offset
}

/** until 까지의 잔여 ms(서버 기준). until 이 없으면 null, 경과 시 0 */
export function remainingMs(until: string | null | undefined, offset: number, clientNow: number = Date.now()): number | null {
  if (!until) return null
  const t = Date.parse(until)
  if (!Number.isFinite(t)) return null
  return Math.max(0, t - serverNowMs(offset, clientNow))
}

/** mm:ss (1시간 초과 시 h:mm:ss) */
export function formatCountdown(ms: number | null | undefined): string {
  const total = Math.max(0, Math.ceil((ms ?? 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/**
 * 화면 표시용 상태 — 서버 상태가 pending 이어도 서버 시각 기준으로 만료 시각이 지났으면 expired 로 간주한다
 * (서버는 다음 조회 시점에야 expired 로 변경한다).
 */
export function effectiveStatus(req: Pick<ApprovalRequest, 'status' | 'expires_at'>, offset: number, clientNow: number = Date.now()): ApprovalStatus {
  if (req.status !== 'pending') return req.status
  const left = remainingMs(req.expires_at, offset, clientNow)
  return left !== null && left <= 0 ? 'expired' : 'pending'
}

/** 되돌리기 가능 여부(서버 기준 undo_until 전) */
export function canUndoNow(req: Pick<ApprovalRequest, 'status' | 'can_undo' | 'undo_until'>, offset: number, clientNow: number = Date.now()): boolean {
  if (req.status !== 'executed' || !req.can_undo) return false
  const left = remainingMs(req.undo_until, offset, clientNow)
  return left !== null && left > 0
}

/** 도구 이름 → 아이콘(utils/icons) */
export function approvalIcon(tool: string): string {
  const t = (tool || '').toLowerCase()
  if (/(delete|remove|trash)/.test(t)) return 'trash'
  if (/share/.test(t)) return 'share'
  if (/(move|rename)/.test(t)) return 'folder-move'
  if (t.startsWith('mail')) return 'send'
  if (t.startsWith('calendar') || t.startsWith('pim') || t.includes('event')) return 'calendar'
  if (t.startsWith('files') || t.startsWith('file')) return 'folder'
  if (t.startsWith('notes') || t.startsWith('wiki')) return 'book-open'
  return 'edit'
}

/** 요청 출처 아이콘(client_kind) */
export function clientIcon(kind: string | null | undefined): string {
  if (kind === 'claude_app') return 'globe'
  if (kind === 'personal_token') return 'monitor'
  return 'sparkles'
}

/** 상태 → 배지 톤 */
export function statusTone(s: ApprovalStatus): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  switch (s) {
    case 'pending': return 'warning'
    case 'executed': return 'success'
    case 'failed': return 'danger'
    case 'rejected': return 'danger'
    default: return 'neutral'
  }
}

/** 전체 인자 보기(2칸 들여쓰기 JSON). idempotency_key 는 사용자에게 의미가 없어 제외한다 */
export function prettyArgs(args: Record<string, unknown> | null | undefined): string {
  const { idempotency_key: _k, ...rest } = args || {}
  try { return JSON.stringify(rest, null, 2) } catch { return String(rest) }
}

/** 미리보기 값 한 줄 */
export function previewValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(previewValue).join(', ')
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch { return String(v) } }
  return String(v)
}

/** 결과에 포함된 앱 내부 링크(있는 경우) — 동일 출처 경로만 */
export function resultLink(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  const data = (r.data && typeof r.data === 'object') ? r.data as Record<string, unknown> : r
  for (const k of ['link', 'url', 'href']) {
    const v = data[k] ?? r[k]
    if (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/api/')) return v
  }
  return null
}

/** 시각(HH:mm 또는 HH:mm:ss) — 숫자는 JetBrains Mono 로 표시한다 */
export function clockTime(iso: string | null | undefined, withSeconds = false, locale = 'ko'): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(locale === 'en' ? 'en-GB' : 'ko-KR', { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false })
}

/** 날짜+시각(YYYY-MM-DD HH:mm:ss) */
export function dateTime(iso: string | null | undefined, withSeconds = true): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return withSeconds ? `${base}:${p(d.getSeconds())}` : base
}

/** 짧은 날짜+시각(MM-DD HH:mm) — 처리 기록 표 */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}


/**
 * 대화를 다시 열 때 승인 카드를 원래 위치에 복원한다.
 * 저장된 메시지에는 어떤 쓰기 요청이 발생했는지 기록이 없으므로, 요청 시각 직후의 AI 답변에 연결한다
 * (요청은 답변 스트림 중에 생성되고 답변은 스트림 종료 시 저장되므로 해당 답변이 소유자이다). 이후 답변이 없으면 마지막 답변.
 */
export function attachWritesToMessages<M extends { role: string; created_at?: string | null; writes?: ApprovalRequest[] }>(
  messages: M[], reqs: ApprovalRequest[],
): M[] {
  if (!reqs?.length) return messages
  const out = messages.map(m => ({ ...m }))
  const asstIdx = out.map((m, i) => (m.role === 'assistant' ? i : -1)).filter(i => i >= 0)
  if (!asstIdx.length) return messages
  for (const r of reqs) {
    const t = r.created_at ? Date.parse(r.created_at) : NaN
    let target = asstIdx[asstIdx.length - 1]
    if (!Number.isNaN(t)) {
      const hit = asstIdx.find(i => { const ct = out[i].created_at ? Date.parse(out[i].created_at as string) : NaN; return !Number.isNaN(ct) && ct >= t })
      if (hit !== undefined) target = hit
    }
    const m = out[target]
    const list = m.writes ? [...m.writes] : []
    if (!list.some(w => w.id === r.id)) list.push(r)
    m.writes = list
  }
  return out
}
