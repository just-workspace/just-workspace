/**
 * 미니 통화 창 — 회의 화면과 셸 사이의 이동 경로 관리.
 *
 * LiveKit 접속 자체는 useMeetings 의 앱 수준 세션이 보유한다(회의 화면을 벗어나도 종료되지 않음).
 * 본 모듈은 복귀 경로·미니 창 부착 위치·표시 대상 화자 등 셸 측 상태만 보유한다.
 *  - 회의 화면(/meetings/room/:name, 셸 숨김)에서 "작게 보기" → 직전 화면으로 이동, 셸이 미니 창을 표시
 *  - 미니 창 "통화 화면으로 펼치기"·모바일 띠 탭 → 회의 화면으로 복귀(장치 재확인 없이 계속)
 *  - 손님(비로그인)은 셸이 없으므로 복귀 경로를 설정하지 않는다 → 미니 창이 표시되지 않고 기존과 같이 화면 이탈 시 퇴장
 *
 * React: const { inCall, returnPath, setReturnPath, corner, setCorner, lastSpeaker, setLastSpeaker, visible, ... } = useMeetingCall()
 *   값 변경 시 setReturnPath(x) · setCorner(c) · setLastSpeaker(id)
 *   inCall 은 useMeetings 와 동일한 값(meetingsStore.inCall)
 * 컴포넌트 외부: meetingCallStore.getState() / openRoom()·expand()·leaveRoomPage() 등
 */
import { createStore, useStore } from 'zustand'
import { navigateTo, useRoute, historyBackPath, routerApi } from '~/lib/router'
import { meetingsStore } from '~/composables/useMeetings'
import { isMeetingPopupWindow, miniCallBackTarget, shouldShowMiniCall, type MiniCallCorner } from '~/utils/miniCall'

export interface MeetingCallState {
  /** 미니 창에서 복귀할 회의 화면(fullPath — 공유 토큰 등 쿼리 포함). 로그인 사용자가 회의에 입장하면 회의 화면이 설정한다. */
  returnPath: string | null
  /** 미니 창이 부착된 모서리(네 모서리 스냅). 기본값은 우측 하단. */
  corner: MiniCallCorner
  /** 마지막 화자 — 발화자가 없을 때 타일이 수시로 전환되지 않도록 유지한다 */
  lastSpeaker: string | null
  /** 펼친 회의 화면이 열어 둘 사이드바(미니 창 대기실 띠 "대기실 전체" → 참가자). 회의 화면이 읽은 후 비운다 */
  roomPanel: 'participants' | null
}

/** 앱 전역 상태: 복귀 경로 · 미니 창 모서리 · 마지막 화자 */
export const meetingCallStore = createStore<MeetingCallState>()(() => ({
  returnPath: null,
  corner: 'br',
  lastSpeaker: null,
  roomPanel: null,
}))

export const setReturnPath = (v: string | null) => meetingCallStore.setState({ returnPath: v })
export const setCorner = (v: MiniCallCorner) => meetingCallStore.setState({ corner: v })
export const setLastSpeaker = (v: string | null) => meetingCallStore.setState({ lastSpeaker: v })
export const setRoomPanel = (v: 'participants' | null) => meetingCallStore.setState({ roomPanel: v })

/** 회의 화면 경로. 동일한 방이면 회의 화면이 접속을 승계한다(장치 확인 생략). */
export function roomPath(name: string, query?: Record<string, string>): { path: string; query?: Record<string, string> } {
  return { path: `/meetings/room/${encodeURIComponent(name)}`, query }
}

/**
 * 앱 내에서 회의 입장(목록 "참여"·채팅 머리 통화·연락처 통화). 이전에는 새 창(팝업)이었으나
 * 이 경우 통화가 해당 창에 한정되어 셸의 미니 창을 부착할 수 없다 — 같은 탭 라우트로 전환("② 같은 탭 라우트").
 * 이미 이 방에서 통화 중이면 그대로 펼친다.
 */
export function openRoom(name: string, query?: Record<string, string>) {
  const { inCall, currentRoomName } = meetingsStore.getState()
  const { returnPath } = meetingCallStore.getState()
  if (inCall && currentRoomName === name && returnPath) return navigateTo(returnPath)
  return navigateTo(roomPath(name, query && Object.keys(query).length ? query : undefined))
}

export function expand() {
  const { returnPath } = meetingCallStore.getState()
  if (returnPath) return navigateTo(returnPath)
}

/** 팝업으로 열린 회의 창 여부(공유 링크·이전 진입 방식) — 이 경우 "목록으로"는 창 닫기로 동작 */
export function isPopup(): boolean {
  return isMeetingPopupWindow(window.name || '')
}

/** 회의 화면을 벗어나 직전 화면(없으면 회의 목록)으로 이동 — "작게 보기"·장치 확인 취소 */
export function leaveRoomPage() {
  // 브라우저 히스토리에서 직전 경로
  const back = historyBackPath() ?? null
  const target = miniCallBackTarget(typeof back === 'string' ? back : null)
  if (target === 'back') routerApi.back()
  else void navigateTo(target)
}

export function useMeetingCall() {
  const route = useRoute()
  const inCall = useStore(meetingsStore, s => s.inCall)
  const returnPath = useStore(meetingCallStore, s => s.returnPath)
  const corner = useStore(meetingCallStore, s => s.corner)
  const lastSpeaker = useStore(meetingCallStore, s => s.lastSpeaker)

  const visible = shouldShowMiniCall({ inCall, returnPath, path: route.path })

  return {
    inCall, returnPath, setReturnPath, corner, setCorner, lastSpeaker, setLastSpeaker,
    visible, roomPath, openRoom, expand, isPopup, leaveRoomPage,
  }
}
