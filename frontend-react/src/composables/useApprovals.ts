/**
 * AI 쓰기 승인(S3) — 대기 건수 싱글턴 + /api/approvals 호출.
 *
 * 대기 건수(승인 대기함 = high 이거나 MCP 에서 온 대기 요청)는 레일 배지·AI 사이드바·토스트가 같은 값을 쓴다(시안 회신 rB-1):
 *   - 처음 값: GET /api/approvals/count (로그인 뒤 한 번, 창이 다시 보일 때 1분 간격 보정)
 *   - 실시간: 사용자 소켓 이벤트 {type:"approvals.count", pending:n} (알림과 같은 /ws/chat 채널 — useChat onChatEvent)
 *   - 대기함 목록 응답의 pending 도 그대로 반영
 * 건수가 늘었고 사용자가 승인 대기함 밖에 있으면 토스트(시안 B2-4)로 알린다.
 *
 * React: const pending = useApprovalsCount()   (null = 모름)
 * 컴포넌트 밖: approvalsStore.getState().pending · setApprovalsCount(n) · approvalsApi.*
 */
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { i18n } from '~/i18n'
import { currentPath, navigateTo } from '~/lib/router'
import { authStore } from '~/composables/useAuth'
import { onChatEvent } from '~/composables/useChat'
import { toast } from '~/composables/useToast'
import type { ApprovalListResponse, ApprovalRequest } from '~/utils/approvals'

const FOCUS_MIN_GAP_MS = 60_000

export const approvalsStore = createStore<{ pending: number | null; seq: number }>()(() => ({ pending: null, seq: 0 }))

/** 요청 하나가 바뀌었을 때(대기함·카드 어디서든) — detail: ApprovalRequest */
export const APPROVAL_UPDATED_EVENT = 'jw:approval-updated'

export const approvalsApi = {
  list: (view: 'pending' | 'history', cursor?: string | null, limit = 50) =>
    $fetch<ApprovalListResponse>('/api/approvals', { query: { view, limit, ...(cursor ? { cursor } : {}) } }),
  count: () => $fetch<{ pending: number }>('/api/approvals/count'),
  /** 대화를 다시 열 때 채팅 카드 복원 — 그 대화의 요청 전부(오래된 순) */
  byConversation: (conversationId: string) =>
    $fetch<ApprovalListResponse>('/api/approvals', { query: { conversation_id: conversationId, limit: 100 } }),
  get: (id: string) => $fetch<ApprovalRequest>(`/api/approvals/${encodeURIComponent(id)}`),
  /** remember — Claude Code "예, 다시 묻지 않기": conversation(이 대화) | always(항상 허용 규칙) */
  approve: (id: string, remember?: 'conversation' | 'always') =>
    $fetch<ApprovalRequest>(`/api/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST', ...(remember ? { body: { remember } } : {}) }),
  reject: (id: string, reason?: string) => $fetch<ApprovalRequest>(`/api/approvals/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { reason: reason?.trim() || null } }),
  cancel: (id: string) => $fetch<ApprovalRequest>(`/api/approvals/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  edit: (id: string, args: Record<string, unknown>) => $fetch<ApprovalRequest>(`/api/approvals/${encodeURIComponent(id)}`, { method: 'PATCH', body: { args } }),
  /** 채팅 묶음 처리 — 고른 대기 low 카드(ids 없으면 전부)를 실행·취소 */
  batch: (conversationId: string, ids: string[] | null, action: 'approve' | 'cancel' = 'approve') =>
    $fetch<{ items: ApprovalRequest[] }>('/api/approvals/batch', { method: 'POST', body: { conversation_id: conversationId, ids, action } }),
  /** 허용·거부 규칙(Claude Code permissions.allow/deny) */
  rules: (conversationId?: string | null) =>
    $fetch<PermissionRules>('/api/approvals/rules', { query: conversationId ? { conversation_id: conversationId } : {} }),
  setRules: (allow: string[], deny: string[]) =>
    $fetch<{ allow: string[]; deny: string[] }>('/api/approvals/rules', { method: 'PUT', body: { allow, deny } }),
  dropConversationRule: (conversationId: string, tool: string) =>
    $fetch<{ conversation: string[] }>(`/api/approvals/rules/conversation/${encodeURIComponent(conversationId)}/${encodeURIComponent(tool)}`, { method: 'DELETE' }),
  undo: (id: string) => $fetch<ApprovalRequest>(`/api/approvals/${encodeURIComponent(id)}/undo`, { method: 'POST' }),
}

export interface PermissionRules {
  allow: string[]
  deny: string[]
  /** 이 대화에서만 허용한 도구 */
  conversation: string[]
  tools: { name: string; title: string; risk: 'low' | 'high' }[]
}

/** 다른 화면(카드·대기함)에 요청 변경을 알린다 */
export function announceApprovalUpdate(req: ApprovalRequest) {
  if (typeof window === 'undefined') return
  try { window.dispatchEvent(new CustomEvent(APPROVAL_UPDATED_EVENT, { detail: req })) } catch { /* 오래된 브라우저 */ }
}

/**
 * 건수 반영. 늘었고(이전 값을 알 때만) 대기함 밖이면 토스트.
 * seq 는 실시간 건수 이벤트(event)마다, 그 밖(조회 응답)에는 값이 바뀔 때만 올라간다 —
 * high 카드·대기함이 "다시 읽을" 신호로 쓴다. 조회 응답마다 올리면 대기함이 목록을 다시 받고 또 올려 끝없이 돈다.
 */
export function setApprovalsCount(n: number, opts: { notify?: boolean; event?: boolean } = {}) {
  const prev = approvalsStore.getState().pending
  const next = Math.max(0, Math.floor(Number(n) || 0))
  if (!opts.event && prev === next) return
  approvalsStore.setState(s => ({ pending: next, seq: s.seq + 1 }))
  if (opts.notify && prev !== null && next > prev && !onApprovalsPage()) void notifyNew(next - prev)
}

function onApprovalsPage(): boolean {
  const p = currentPath()
  return p === '/approvals' || p.startsWith('/approvals/')
}

/** 새 승인 요청 토스트(B2-4) — 가장 최근 대기 요청 한 건을 붙인다 */
async function notifyNew(added: number) {
  const t = (k: string, v?: Record<string, unknown>) => i18n.t(k, v)
  let latest: ApprovalRequest | undefined
  try { latest = (await approvalsApi.list('pending', null, 1)).items?.[0] } catch { /* 요약 없이 */ }
  const who = latest ? (latest.client_name || t(latest.source === 'ai' ? 'approvals.source.ai' : 'approvals.source.mcp')) : ''
  toast({
    type: 'warning',
    title: t('approvals.toast.title', { n: added }),
    description: latest
      ? t('approvals.toast.body', { who, title: latest.title, target: latest.target_summary || latest.title })
      : t('approvals.toast.bodyGeneric'),
    action: {
      label: t('approvals.toast.open'),
      onClick: () => { void navigateTo(latest ? `/approvals?id=${encodeURIComponent(latest.id)}` : '/approvals') },
    },
  })
}

let _started = false
let _last = 0
let _unsub: (() => void) | null = null

export async function refreshApprovalsCount() {
  if (!authStore.getState().user) return
  _last = Date.now()
  try {
    const r = await approvalsApi.count()
    setApprovalsCount(r.pending ?? 0, { notify: true })
  } catch { /* 조용히 — 다음 이벤트·포커스 때 다시 */ }
}

/** 소켓 이벤트 처리(테스트도 직접 부른다) */
export function handleApprovalsEvent(data: any) {
  if (data?.type === 'approvals.count' && typeof data.pending === 'number') setApprovalsCount(data.pending, { notify: true, event: true })
}

function onVisible() {
  if (document.visibilityState === 'visible' && Date.now() - _last > FOCUS_MIN_GAP_MS) void refreshApprovalsCount()
}

/** 셸에서 한 번(DefaultLayout). 로그인 감시 + 실시간 이벤트 구독 */
export function ensureApprovals() {
  if (_started) return
  _started = true
  let uid = authStore.getState().user?.id ?? null
  if (uid) void refreshApprovalsCount()
  authStore.subscribe((s) => {
    const next = s.user?.id ?? null
    if (next === uid) return
    uid = next
    approvalsStore.setState({ pending: null })
    if (uid) void refreshApprovalsCount()
  })
  _unsub = onChatEvent(handleApprovalsEvent)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
}

/** 테스트용 초기화 */
export function _resetApprovals() {
  _unsub?.()
  _unsub = null
  _started = false
  _last = 0
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  approvalsStore.setState({ pending: null, seq: 0 })
}

/** 지금 대기 건수(null = 모름) */
export function useApprovalsCount(): number | null {
  return useStore(approvalsStore, s => s.pending)
}

/** 건수 이벤트 순번(바뀌면 high 카드가 상태를 다시 본다) */
export function useApprovalsSeq(): number {
  return useStore(approvalsStore, s => s.seq)
}
