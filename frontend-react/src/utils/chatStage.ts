/**
 * 채팅 모바일 단계 ↔ 주소 도우미. Vue 원본: frontend/pages/chat.vue 안의 stageFromState·stageFromRoute·depthOf·sameStage
 * (React 판은 페이지 파일이 컴포넌트만 내보내게 여기로 뺐다 — 내용 같음)
 * handover-22: 오른쪽 자리에 "스레드 목록"(threads, useChatUi.threadListOpen)이 더해졌다 — 주소 panel=threads.
 */
import { chatStore } from '~/composables/useChat'
import { chatUiStore } from '~/composables/useChatUi'

export type Panel = 'search' | 'thread' | 'threads' | 'members' | 'pins' | null
export type StageQuery = { channel?: string; view?: string; thread?: string; panel?: string }
export const STAGE_KEYS = ['channel', 'view', 'thread', 'panel'] as const
/** 주소 panel= 로 실을 수 있는 값 */
export const STAGE_PANELS = ['search', 'threads', 'members', 'pins'] as const

/**
 * 지금 store 값 → 열린 오른쪽 패널(하나만). 순서 = 검색 · 스레드 · 스레드 목록 · 멤버 덮개 · 고정.
 * 스레드 목록에서 스레드를 열면 스레드가 앞선다(목록은 뒤에 남아 스레드를 닫으면 다시 보인다).
 * threadListOpen 을 안 주면 chatUiStore 의 지금 값.
 */
export function panelOf(
  s: { showSearchPanel: boolean; activeThreadId: string | null; showMemberPanel: boolean; showPinsPanel: boolean },
  threadListOpen: boolean = chatUiStore.getState().threadListOpen,
): Panel {
  if (s.showSearchPanel) return 'search'
  if (s.activeThreadId) return 'thread'
  if (threadListOpen) return 'threads'
  if (s.showMemberPanel) return 'members'
  if (s.showPinsPanel) return 'pins'
  return null
}

// ─── 모바일 단계 ↔ 브라우저 기록 ───
// 목록(/chat) → 대화(?channel= 또는 ?view=모아보기) → 스레드·패널(&thread= 또는 &panel=) 를 주소에 싣는다.
// 깊어지면 push, 얕아지면(‹·가장자리 밀기) 직전 기록이 그 주소일 때 router.back(), 아니면 replace —
// 그래서 안드로이드·브라우저 뒤로가기가 한 단계씩 돌아가고, 앱 안 ‹ 뒤에 "빈 뒤로가기"가 남지 않는다.
// 데스크톱은 기존대로(딥 링크 ?channel=&thread= 는 진입 때만 읽는다).
export function stageFromState(): StageQuery {
  const s = chatStore.getState()
  const ui = chatUiStore.getState()
  const panel = panelOf(s, ui.threadListOpen)
  const q: StageQuery = {}
  if (s.selectedChannelId) q.channel = s.selectedChannelId
  else if (ui.collection) q.view = ui.collection
  if (s.activeThreadId) q.thread = s.activeThreadId
  else if (panel && panel !== 'thread') q.panel = panel
  return q
}
export function stageFromQuery(query: Record<string, unknown>): StageQuery {
  const q: StageQuery = {}
  for (const k of STAGE_KEYS) { const v = query[k]; if (typeof v === 'string' && v) q[k] = v }
  if (q.view && !['threads', 'drafts', 'saved'].includes(q.view)) delete q.view
  if (q.panel && !(STAGE_PANELS as readonly string[]).includes(q.panel)) delete q.panel
  return q
}
export const depthOf = (q: StageQuery) => (q.channel || q.view ? 1 : 0) + (q.thread || q.panel ? 1 : 0)
export const sameStage = (a: StageQuery, b: StageQuery) => STAGE_KEYS.every(k => (a[k] || '') === (b[k] || ''))
