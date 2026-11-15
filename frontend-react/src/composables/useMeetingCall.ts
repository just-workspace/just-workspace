/**
 * 미니 통화 창 — 회의 화면과 셸 사이의 길잡이.
 *
 * LiveKit 접속 자체는 useMeetings 의 앱 수준 세션이 쥐고 있다(회의 화면을 떠나도 끊기지 않음).
 * 여기는 "어디로 돌아가나·창이 어디 붙나·누구를 비추나" 같은 셸 쪽 상태만 둔다.
 *  - 회의 화면(/meetings/room/:name, 셸 숨김)에서 "작게 보기" → 직전 화면으로, 셸이 미니 창을 띄움
 *  - 미니 창 "통화 화면으로 펼치기"·모바일 띠 탭 → 회의 화면으로(다시 장치 확인 없이 이어서)
 *  - 손님(로그인 안 함)은 셸이 없으므로 돌아갈 경로를 올리지 않는다 → 미니 창이 뜨지 않고 예전처럼 떠나면 퇴장
 *
 * React: const { inCall, returnPath, setReturnPath, corner, setCorner, lastSpeaker, setLastSpeaker, visible, ... } = useMeetingCall()
 *   값을 바꿀 때는 setReturnPath(x) · setCorner(c) · setLastSpeaker(id)
 *   inCall 은 useMeetings 와 같은 값(meetingsStore.inCall)
 * 컴포넌트 밖: meetingCallStore.getState() / openRoom()·expand()·leaveRoomPage() 등
 */
import { createStore, useStore } from 'zustand'
import { navigateTo, useRoute, historyBackPath, routerApi } from '~/lib/router'
import { meetingsStore } from '~/composables/useMeetings'
import { isMeetingPopupWindow, miniCallBackTarget, shouldShowMiniCall, type MiniCallCorner } from '~/utils/miniCall'

export interface MeetingCallState {
  /** 미니 창에서 돌아갈 회의 화면(fullPath — 공유 토큰 등 쿼리 포함). 로그인 사용자가 회의에 들어가면 회의 화면이 올린다. */
  returnPath: string | null
  /** 미니 창이 붙은 귀퉁이(네 귀퉁이 스냅). 기본 오른쪽 아래. */
  corner: MiniCallCorner
  /** 마지막으로 말한 사람 — 아무도 말하지 않을 때 타일이 이리저리 바뀌지 않게 붙들어 둔다 */
  lastSpeaker: string | null
  /** 펼친 회의 화면이 열어 둘 사이드바(미니 창 대기실 띠 "대기실 전체" → 참가자). 회의 화면이 읽고 비운다 */
  roomPanel: 'participants' | null
}

/** 앱 전역 상태: 돌아갈 경로 · 미니 창 귀퉁이 · 마지막 화자 */
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

/** 회의 화면 경로. 같은 방이면 회의 화면이 접속을 이어받는다(장치 확인 생략). */
export function roomPath(name: string, query?: Record<string, string>): { path: string; query?: Record<string, string> } {
  return { path: `/meetings/room/${encodeURIComponent(name)}`, query }
}

/**
 * 앱 안에서 회의로 들어가기(목록 "참여"·채팅 머리 통화·연락처 통화). 예전엔 새 창(팝업)이었지만
 * 그러면 통화가 그 창에 갇혀 셸의 미니 창이 붙을 수 없다 — 같은 탭 라우트로("② 같은 탭 라우트").
 * 이미 이 방에 통화 중이면 그대로 펼친다.
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

/** 팝업으로 열린 회의 창인가(공유 링크·예전 진입) — 이 경우 "목록으로"는 창 닫기 */
export function isPopup(): boolean {
  return isMeetingPopupWindow(window.name || '')
}

/** 회의 화면을 떠나 직전 화면(없으면 회의 목록)으로 — "작게 보기"·장치 확인 취소 */
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
