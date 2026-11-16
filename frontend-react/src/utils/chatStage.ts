/**
 * 채팅 모바일 단계 ↔ 주소 도우미: stageFromState·stageFromRoute·depthOf·sameStage
 * (페이지 파일이 컴포넌트만 내보내도록 본 파일로 분리)
 * 오른쪽 자리에 "스레드 목록"(threads, useChatUi.threadListOpen)이 추가되었다 — 주소 panel=threads.
 */
import { chatStore } from '~/composables/useChat'
import { chatUiStore } from '~/composables/useChatUi'

export type Panel = 'search' | 'thread' | 'threads' | 'members' | 'pins' | null
export type StageQuery = { channel?: string; view?: string; thread?: string; panel?: string }
export const STAGE_KEYS = ['channel', 'view', 'thread', 'panel'] as const
/** 주소 panel= 에 지정할 수 있는 값 */
export const STAGE_PANELS = ['search', 'threads', 'members', 'pins'] as const

/**
 * 현재 store 값 → 열린 오른쪽 패널(하나만). 순서 = 검색 · 스레드 · 스레드 목록 · 멤버 덮개 · 고정.
 * 스레드 목록에서 스레드를 열면 스레드가 우선한다(목록은 뒤에 유지되어 스레드를 닫으면 다시 표시된다).
 * threadListOpen 을 생략하면 chatUiStore 의 현재 값.
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
// 목록(/chat) → 대화(?channel= 또는 ?view=모아보기) → 스레드·패널(&thread= 또는 &panel=) 을 주소에 반영한다.
// 깊어지면 push, 얕아지면(‹·가장자리 밀기) 직전 기록이 해당 주소일 때 router.back(), 아니면 replace —
// 이에 따라 안드로이드·브라우저 뒤로가기가 한 단계씩 복귀하며, 앱 내 ‹ 이후 "빈 뒤로가기"가 남지 않는다.
// 데스크톱은 기존과 동일(딥 링크 ?channel=&thread= 는 진입 시에만 읽는다).
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
