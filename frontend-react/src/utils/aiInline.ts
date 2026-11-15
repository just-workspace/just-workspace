/**
 * 화면 안 AI(S7 · 시안 E1 메일 · E2 채팅·회의·문서) — API 와 순수 도우미.
 * 서버: backend/app/ai/inline_router.py (/api/ai/inline/*). 결과는 스트리밍이 아니라 한 번에 온다.
 * 모델 이름은 전부 서버 응답에서 온다(여기에 박지 않는다).
 */
import { $fetch } from '~/lib/api'

export type AiInlineReason = 'module_off' | 'not_configured' | 'external_blocked' | null

export interface AiInlineStatus {
  available: boolean
  reason: AiInlineReason
  external: boolean
  /** 외부 AI 로 보낼 때 개인정보를 가리는지 */
  mask_pii: boolean
  model: string
  is_admin: boolean
}

/** 모든 결과에 붙는 공통 꼬리 */
export interface AiInlineMeta {
  model: string
  ai_generated: boolean
  external: boolean
  masked: boolean
  clipped?: boolean
}

export interface MailTodo { title: string; due: string | null; who: string | null }
export interface MailSummary extends AiInlineMeta { points: string[]; todos: MailTodo[] }
export interface MailReply extends AiInlineMeta { draft: string; tone: AiTone }
export type AiTone = 'polite' | 'short'

export interface ChatCalledMe { message_id: string; text: string; at: string | null }
export interface ChatSummary extends AiInlineMeta {
  points: string[]
  called_me: ChatCalledMe[]
  scope: 'unread' | 'range'
  count: number
  from_at: string | null
  to_at: string | null
  from_message_id: string
  to_message_id: string
}

export interface MeetingTodo { title: string; due: string | null; note: string | null; assignee_id: string | null; assignee_name: string | null }
export interface MeetingSummaryResult extends AiInlineMeta {
  title: string
  points: string[]
  todos: MeetingTodo[]
  participants: number
  source: 'chat' | 'agenda'
  started_at: string | null
  ended_at: string | null
}

export type ProofKind = 'spelling' | 'spacing' | 'style'
export interface ProofItem { kind: ProofKind; original: string; fixed: string; reason: string }
export interface ProofResult extends AiInlineMeta { items: ProofItem[]; mode: 'all' | 'style' }

export interface TaskCreateItem { title: string; due_date?: string | null; description?: string | null; assignee_id?: string | null; idempotency_key?: string }
export interface TaskCreateResult {
  results: { ok: boolean; title: string; request_id?: string; task_id?: string | null; can_undo?: boolean; error?: string | null }[]
  created: number
}

export interface AiInlineError { code: string; message: string }

/** 사용자 시간대 — 서버가 메일·채팅 시각을 이 시간대로 모델에 넘긴다 */
export function userTz(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined } catch { return undefined }
}

export function fetchInlineStatus() {
  return $fetch<AiInlineStatus>('/api/ai/inline/status')
}

export function summarizeMail(body: { message_id: string; mailbox_id?: string | null; account_id?: string | null }) {
  return $fetch<MailSummary>('/api/ai/inline/mail_summary', { method: 'POST', body: { ...body, tz: userTz() } })
}

export function draftMailReply(body: { message_id: string; mailbox_id?: string | null; account_id?: string | null; tone: AiTone }) {
  return $fetch<MailReply>('/api/ai/inline/mail_reply', { method: 'POST', body: { ...body, tz: userTz() } })
}

export function summarizeChat(body: { channel_id: string; scope: 'unread' | 'range'; from_message_id?: string; to_message_id?: string }) {
  return $fetch<ChatSummary>('/api/ai/inline/chat_summary', { method: 'POST', body: { ...body, tz: userTz() } })
}

export function summarizeMeeting(body: { room: string; chat_lines?: { name: string; text: string }[]; started_at?: string | null }) {
  return $fetch<MeetingSummaryResult>('/api/ai/inline/meeting_summary', { method: 'POST', body: { ...body, tz: userTz() } })
}

export function proofreadDoc(body: { text: string; mode: 'all' | 'style'; title?: string }) {
  return $fetch<ProofResult>('/api/ai/inline/doc_proofread', { method: 'POST', body })
}

export function createInlineTasks(body: { source: 'mail' | 'meeting' | 'chat'; room?: string; items: TaskCreateItem[] }) {
  return $fetch<TaskCreateResult>('/api/ai/inline/tasks', { method: 'POST', body })
}

/** FetchError → {code, message}. 서버 detail 이 {code,message} 거나 문자열이거나, 아예 없을 때(네트워크) */
export function inlineError(e: unknown, fallback: string): AiInlineError {
  const d = (e as { data?: { detail?: unknown } })?.data?.detail
  if (d && typeof d === 'object' && 'message' in (d as Record<string, unknown>)) {
    const o = d as { code?: string; message?: string }
    return { code: o.code || 'error', message: o.message || fallback }
  }
  if (typeof d === 'string' && d) return { code: 'error', message: d }
  return { code: 'network', message: fallback }
}

/** 날짜 "2026-11-07" → "11-07(금)" (요일은 로캘). 형식이 아니면 그대로 */
export function shortDue(iso: string | null | undefined, locale?: string): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  let wd: string
  try { wd = d.toLocaleDateString(locale, { weekday: 'short' }) } catch { wd = '' }
  return `${m[2]}-${m[3]}${wd ? `(${wd})` : ''}`
}

/** ISO 시각 → 사용자 시각 "HH:MM" */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 한 번 누른 등록이 재시도돼도 두 번 만들지 않게(서버 멱등 키) */
export function idemKey(prefix: string, title: string): string {
  const rnd = Math.random().toString(36).slice(2, 10)
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0
  return `${prefix}:${(h >>> 0).toString(36)}:${rnd}`
}

/**
 * 교정 제안을 글에서 찾는다 — 같은 구절이 여러 번이면 from 이후 첫 자리.
 * 편집기(ProseMirror)는 텍스트 오프셋을 문서 위치로 바꿔 쓴다.
 */
export function findOriginal(text: string, original: string, from = 0): number {
  if (!original) return -1
  return text.indexOf(original, from)
}

/** 등록한 할일 되돌리기 — 쓰기 요청마다 /api/approvals/{id}/undo(실행 후 10분 안) */
export async function undoInlineTasks(requestIds: string[]): Promise<number> {
  let n = 0
  for (const id of requestIds) {
    try {
      await $fetch(`/api/approvals/${encodeURIComponent(id)}/undo`, { method: 'POST' })
      n++
    } catch { /* 시간 지남 등 — 남은 것만 되돌린다 */ }
  }
  return n
}
