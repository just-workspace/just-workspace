/**
 * 채팅 오른쪽 자리 — 순수 함수.
 * 자리는 하나: 멤버 264 · 스레드 400 · 스레드 목록 400 · 검색 결과 400 · 고정 400 · 음성 글 채팅 340 이 서로 배타, 새로 연 것이 바꿔 낀다.
 *  · 스레드·스레드 목록·검색·고정(그리고 좁은 화면의 멤버 덮개)은 잠깐 여는 패널 — 열려 있으면 그것(panelOf 순서).
 *  · 아니면 바탕 열: 음성 채널에 접속해 글 채팅을 열어 두었으면 음성 글 채팅, 아니면 멤버 열(켜 두었을 때).
 *  · 실효 폭 1180 미만이면 멤버 열을 상시로 두지 않는다 — 헤더 토글이 덮개로 연다(chatStore.showMemberPanel).
 *    다른 패널도 1180 미만에서는 대화 위 덮개.
 */
import type { Panel } from './chatStage'

export type RightColumn = 'thread' | 'threads' | 'search' | 'pins' | 'members' | 'voiceText' | null

/** 멤버 열을 상시로 붙이는 최소 실효 폭 */
export const CHAT_MEMBERS_DOCK_MIN = 1180

/** 자리별 폭(px) — 멤버 264 는 디스코드 기본, 나머지는 디자인 값 */
export const RIGHT_COLUMN_WIDTH: Record<Exclude<RightColumn, null>, number> = {
  members: 264, thread: 400, threads: 400, search: 400, pins: 400, voiceText: 340,
}

export interface RightColumnInput {
  /** 잠깐 패널(panelOf) — 'members' 는 덮개(좁은 화면) */
  panel: Panel
  /** 실효 폭 */
  width: number
  /** 헤더 멤버 토글로 켜 둔 상시 멤버 열 */
  membersOpen: boolean
  /** 채널이 열려 있다(아무것도 안 고른 빈 화면엔 멤버 열 없음) */
  hasChannel: boolean
  /** 지금 연 음성 채널에 내가 접속해 있다 — 음성 글 채팅을 둘 수 있다 */
  voiceTextAvailable: boolean
  /** 음성 글 채팅을 열어 두었다 */
  voiceTextOpen: boolean
}

export function resolveRightColumn(i: RightColumnInput): RightColumn {
  if (i.panel) return i.panel
  if (i.voiceTextAvailable && i.voiceTextOpen) return 'voiceText'
  if (i.hasChannel && i.membersOpen && i.width >= CHAT_MEMBERS_DOCK_MIN) return 'members'
  return null
}

/** 오른쪽 열이 대화 옆에 붙는가(아니면 대화 위 덮개). 좁은 화면의 패널은 덮개 */
export function rightColumnDocked(col: RightColumn, width: number): boolean {
  if (!col) return false
  return width >= CHAT_MEMBERS_DOCK_MIN
}

/** 지금 멤버 열이 보이는가 — 헤더 멤버 토글의 aria-pressed */
export function membersShown(i: RightColumnInput): boolean {
  return resolveRightColumn(i) === 'members'
}

export type RightOpenKind = 'members' | 'threads' | 'search' | 'pins'

/**
 * 헤더 단추로 연 오른쪽 자리 → 바꿀 상태(순수). 이미 그 자리가 보이면 닫는다(토글).
 *  · members: 넓으면 상시 열(membersOpen)을 켜고 끈다 — 잠깐 패널은 모두 닫는다. 좁으면 덮개(showMemberPanel).
 *  · 그 밖: 그 패널만 켜고 나머지 잠깐 패널은 끈다. 바탕 멤버 열(membersOpen)은 그대로 둔다 — 패널을 닫으면 다시 보인다.
 */
export interface RightOpenState {
  showSearchPanel: boolean
  showMemberPanel: boolean
  showPinsPanel: boolean
  threadListOpen: boolean
  /** 스레드 패널을 닫는다(activeThreadId → null) */
  closeThread: boolean
  membersOpen: boolean
}
export function nextRightState(kind: RightOpenKind, cur: RightColumn, wide: boolean, membersOpen: boolean): RightOpenState {
  const base: RightOpenState = {
    showSearchPanel: false, showMemberPanel: false, showPinsPanel: false, threadListOpen: false, closeThread: true, membersOpen,
  }
  const open = cur === kind
  if (kind === 'members') {
    if (wide) return { ...base, membersOpen: !open }
    return { ...base, showMemberPanel: !open }
  }
  if (open) return base
  if (kind === 'search') return { ...base, showSearchPanel: true }
  if (kind === 'pins') return { ...base, showPinsPanel: true }
  return { ...base, threadListOpen: true }
}
