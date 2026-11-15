/**
 * 채팅 화면 전용 UI 상태 — 컴포넌트끼리 주고받는 "화면" 상태만 둔다(네트워크·실시간은 useChat).
 * 앱 전역 상태 묶음(zustand store 하나).
 *
 * useChat 을 키우지 않으려고 따로 뺐다: 모아보기(스레드·임시 저장·저장한 메시지) 화면, 알림 설정 시트,
 * "안 읽음으로 표시" 로 옮긴 새 메시지 구분선, ↑ 로 마지막 내 메시지 수정, 파일 선택 창 열기 요청.
 *
 * React: const { collection, setCollection, notifySheetChannelId, ... } = useChatUi()
 *   값을 바꿀 때는 setter(setCollection·setNotifySheetChannelId·setInviteOpen·setUnreadAnchor·
 *   setEditRequest·setThreadWide)로. 이벤트 처리기 안에서 "지금" 값은 chatUiStore.getState().
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { authStore } from '~/composables/useAuth'
import { chatStore, type Channel, type WorkspaceUser } from '~/composables/useChat'

export type ChatCollection = 'threads' | 'drafts' | 'saved'

export interface ChatUiState {
  /** 사이드바 고정 항목으로 연 모아보기. 채널을 열면 비운다(pages/chat). */
  collection: ChatCollection | null
  /** 채널 알림 설정 시트(데스크톱 모달 / 모바일 바텀시트)를 연 채널 id */
  notifySheetChannelId: string | null
  /** 멤버 초대 모달 */
  inviteOpen: boolean
  /** "안 읽음으로 표시" 한 메시지 — 목록이 새 메시지 구분선을 그 위로 옮긴다 */
  unreadAnchor: { channelId: string; messageId: string } | null
  /** 수정 모드로 열 메시지(컴포저에서 ↑ · 단축키 E) */
  editRequest: string | null
  /** 컴포저의 파일 선택 창 열기 요청(채널 소개 "파일 올리기" · Ctrl+U). 값이 바뀌면 연다 */
  filePickerTick: number
  /** 스레드 패널 넓게 보기 */
  threadWide: boolean
  /** 채널 목록 접힘(데스크톱) — 레일의 채팅 아이콘을 다시 누르면 접고 편다 */
  listCollapsed: boolean
  /** 멤버 열(데스크톱 ≥1180 상시 열) 켬 — 헤더 멤버 토글. 기기별 기억 */
  membersOpen: boolean
  /** 음성 채널 글 채팅(340)을 오른쪽 열에 둔다 — 멤버 열과 서로 배타, 새로 연 것이 바꿔 낀다 */
  voiceTextOpen: boolean
  /** 채널 탭 관리 창(채널 행 ⚙ 메뉴 · 머리에서 연다) */
  tabsManageOpen: boolean
  /** 컴포저에서 수정 중인 메시지(행 선택 덧칠) */
  editingMessageId: string | null
  // ── 답장·점프·떠 있는 것 ──
  /** 인라인 답장 중(컴포저 위 띠). ping = @ 켬(마지막 값은 사람마다 기억 — useUserPrefs chatReplyPing) */
  replyTo: { channelId: string; parentId: string | null; messageId: string; senderId: string | null; senderName: string; ping: boolean } | null
  /** 원문으로 점프 — 목록이 그 줄로 스크롤하고 강조(2초 유지 + 1초 사라짐). nonce 로 같은 메시지 다시 점프 */
  jumpTarget: { channelId: string; messageId: string; nonce: number } | null
  /** 오른쪽 자리 "스레드 목록"(400) — 다른 오른쪽 패널과 배타 */
  threadListOpen: boolean
  /** 채팅 안 전체 화면 설정. section = 'roles'|'role-perm'|'channel-perm'|'category-perm'|'emoji'|'voice'… */
  settings: { section: string; targetId?: string | null } | null
  /** 프로필 팝아웃 — 붙일 기준 사각형 */
  profilePopout: { userId: string; anchor: { x: number; y: number; w: number; h: number } } | null
  /** 이모지 피커 — 컴포저 입력 / 리액션 추가 */
  emojiPicker: { mode: 'compose' | 'react'; messageId?: string; anchor?: { x: number; y: number; w: number; h: number } } | null
}

const LS_UI = 'jw-chat-ui'
function readUi(): { listCollapsed?: boolean; membersOpen?: boolean } {
  try { return JSON.parse(localStorage.getItem(LS_UI) || '{}') || {} } catch { return {} }
}
function saveUi() {
  const s = chatUiStore.getState()
  try { localStorage.setItem(LS_UI, JSON.stringify({ listCollapsed: s.listCollapsed, membersOpen: s.membersOpen })) } catch { /* 기억 못 해도 동작은 같다 */ }
}
const _ui = typeof localStorage !== 'undefined' ? readUi() : {}

export const chatUiStore = createStore<ChatUiState>()(() => ({
  collection: null,
  notifySheetChannelId: null,
  inviteOpen: false,
  unreadAnchor: null,
  editRequest: null,
  filePickerTick: 0,
  threadWide: false,
  listCollapsed: !!_ui.listCollapsed,
  membersOpen: _ui.membersOpen ?? true,
  voiceTextOpen: true,
  tabsManageOpen: false,
  editingMessageId: null,
  replyTo: null,
  jumpTarget: null,
  threadListOpen: false,
  settings: null,
  profilePopout: null,
  emojiPicker: null,
}))

const set = (p: Partial<ChatUiState>) => chatUiStore.setState(p)
export const setCollection = (v: ChatCollection | null) => set({ collection: v })
export const setNotifySheetChannelId = (v: string | null) => set({ notifySheetChannelId: v })
export const setInviteOpen = (v: boolean) => set({ inviteOpen: v })
export const setUnreadAnchor = (v: ChatUiState['unreadAnchor']) => set({ unreadAnchor: v })
export const setEditRequest = (v: string | null) => set({ editRequest: v })
export const setThreadWide = (v: boolean) => set({ threadWide: v })
export function setListCollapsed(v: boolean) { set({ listCollapsed: v }); saveUi() }
export function toggleListCollapsed() { setListCollapsed(!chatUiStore.getState().listCollapsed) }
export function setMembersOpen(v: boolean) { set({ membersOpen: v }); saveUi() }
export const setVoiceTextOpen = (v: boolean) => set({ voiceTextOpen: v })
export const setTabsManageOpen = (v: boolean) => set({ tabsManageOpen: v })
export const setEditingMessageId = (v: string | null) => set({ editingMessageId: v })
export const setReplyTo = (v: ChatUiState['replyTo']) => set({ replyTo: v })
export function jumpTo(channelId: string, messageId: string) {
  set({ jumpTarget: { channelId, messageId, nonce: (chatUiStore.getState().jumpTarget?.nonce ?? 0) + 1 } })
}
export const clearJump = () => set({ jumpTarget: null })
export const setThreadListOpen = (v: boolean) => set({ threadListOpen: v })
export const openChatSettings = (section = 'roles', targetId: string | null = null) => set({ settings: { section, targetId } })
export const closeChatSettings = () => set({ settings: null })
export const setProfilePopout = (v: ChatUiState['profilePopout']) => set({ profilePopout: v })
export const setEmojiPicker = (v: ChatUiState['emojiPicker']) => set({ emojiPicker: v })
/** DOM 요소 → 팝오버 기준 사각형 */
export function anchorOf(el: Element | null | undefined): { x: number; y: number; w: number; h: number } {
  const r = el?.getBoundingClientRect()
  return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 0, y: 0, w: 0, h: 0 }
}
export function openFilePicker() { set({ filePickerTick: chatUiStore.getState().filePickerTick + 1 }) }

/** DM 상대 — 채널 이름이 "username,username" 이다 */
export function dmPartner(
  channel: Pick<Channel, 'name' | 'type'> | null | undefined,
  allUsers: WorkspaceUser[] = chatStore.getState().allUsers,
  myUsername: string | null | undefined = authStore.getState().user?.username,
): WorkspaceUser | null {
  if (!channel || channel.type !== 'dm') return null
  const names = channel.name.split(',')
  const other = names.find(n => n !== myUsername) || names[0]
  return allUsers.find(u => u.username === other) || null
}

export function initialOf(name: string | null | undefined): string {
  return (name || '?').charAt(0).toUpperCase()
}

/** 상태 + setter */
export function useChatUi() {
  const s = useStore(chatUiStore, useShallow((x: ChatUiState) => x))
  const allUsers = useStore(chatStore, x => x.allUsers)
  const myUsername = useStore(authStore, x => x.user?.username)
  return {
    ...s,
    setCollection,
    setNotifySheetChannelId,
    setInviteOpen,
    setUnreadAnchor,
    setEditRequest,
    setThreadWide,
    /** DM 상대 — 렌더 시점 allUsers 로 */
    dmPartner: (channel: Pick<Channel, 'name' | 'type'> | null | undefined) => dmPartner(channel, allUsers, myUsername),
    initialOf,
    openFilePicker,
  }
}

/** 시각 표시(HH:MM, mono). 오늘이 아니면 "어제" 또는 M월 D일 — 모바일 목록 오른쪽 위 */
export function chatListTime(iso: string | null | undefined, t: (k: string) => string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return t('common.yesterday')
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
}

export function chatClock(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 묶음 첫 줄 시간 — "오전 10:02"(ko) · "10:02 AM"(en). 거터·compact 는 chatClock(24시간) */
export function chatClockAmPm(iso: string | null | undefined, lang = 'ko-KR'): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit', hour12: true })
}
