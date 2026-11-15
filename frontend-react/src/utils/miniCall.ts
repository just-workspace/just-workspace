/**
 * 미니 통화 창(P-8) 상태 계산 — 화면과 떼어 낸 순수 함수(단위 테스트 대상).
 *
 * 시안 Workspace X3 결정 3: 오른쪽 아래 320×180(여백 24), 네 귀퉁이 스냅. 영상이 없으면 높이 56 알약.
 * 모바일은 상태 표시줄 아래 36px 초록 띠 — 탭하면 통화로.
 * 겹침(11-C11): 통화 창 z 45 > 메일 작성 창 z 40. 둘 다 뜨면 작성 창이 (통화 창 폭 + 16)만큼 왼쪽으로.
 */

export type MiniCallCorner = 'tl' | 'tr' | 'bl' | 'br'

export const MINI_CALL_WIDTH = 320
export const MINI_CALL_VIDEO_HEIGHT = 180
export const MINI_CALL_PILL_HEIGHT = 56
export const MINI_CALL_MARGIN = 24
/** 모바일 통화 띠 높이 */
export const MINI_CALL_BAND_HEIGHT = 36

/** 회의 화면(전체) 라우트인가 — 이 화면에선 미니 창 대신 전체 회의가 보인다 */
export function isMeetingRoomPath(path: string): boolean {
  return path.startsWith('/meetings/room/') || path.startsWith('/meetings/join/')
}

/**
 * 미니 통화 창을 띄울지. 통화 중(앱 수준 세션)이고, 돌아갈 회의 화면이 있고(로그인 사용자 세션),
 * 지금 회의 화면이 아닐 때만. 손님(셸 없음)은 돌아갈 경로를 올리지 않으므로 뜨지 않는다.
 */
export function shouldShowMiniCall(s: { inCall: boolean; returnPath: string | null; path: string }): boolean {
  return s.inCall && !!s.returnPath && !isMeetingRoomPath(s.path)
}

/** 놓은 지점(창 중심)에서 가장 가까운 귀퉁이 — 화면을 네 칸으로 나눠 고른다 */
export function nearestMiniCallCorner(x: number, y: number, viewportW: number, viewportH: number): MiniCallCorner {
  const left = x < viewportW / 2
  const top = y < viewportH / 2
  return (top ? 't' : 'b') + (left ? 'l' : 'r') as MiniCallCorner
}

/** 귀퉁이 → fixed 위치 스타일 */
export function miniCallCornerStyle(corner: MiniCallCorner, margin = MINI_CALL_MARGIN): Record<string, string> {
  const m = `${margin}px`
  return {
    [corner[0] === 't' ? 'top' : 'bottom']: m,
    [corner[1] === 'l' ? 'left' : 'right']: m,
  }
}

/**
 * 메일 작성 창이 비켜 설 폭(useShell().miniCallWidth). 작성 창은 오른쪽 아래에 붙으므로
 * 통화 창이 오른쪽 아래에 떠 있을 때만 겹친다 — 그때만 폭을 올린다. 모바일(띠)은 0.
 */
export function miniCallReservedWidth(s: { visible: boolean; mobile: boolean; corner: MiniCallCorner }): number {
  if (!s.visible || s.mobile) return 0
  return s.corner === 'br' ? MINI_CALL_WIDTH : 0
}

export interface MiniCallParticipant {
  identity: string
  isLocal: boolean
  isSpeaking: boolean
  isMuted: boolean
  videoTrack: unknown | null
  screenTrack: unknown | null
}

/**
 * 미니 창 타일에 비출 사람. 우선순위:
 *  1) 화면 공유 중인 사람  2) 지금 말하는 다른 사람  3) 마지막으로 말한 다른 사람(아직 방에 있으면)
 *  4) 영상이 켜진 다른 사람  5) 다른 사람 아무나  6) 나
 */
export function pickMiniCallSpotlight<T extends MiniCallParticipant>(list: T[], lastSpeaker: string | null): T | null {
  if (!list.length) return null
  const sharer = list.find(p => p.screenTrack)
  if (sharer) return sharer
  const remotes = list.filter(p => !p.isLocal)
  const speaking = remotes.find(p => p.isSpeaking && !p.isMuted)
  if (speaking) return speaking
  const last = lastSpeaker ? remotes.find(p => p.identity === lastSpeaker) : undefined
  if (last) return last
  return remotes.find(p => p.videoTrack) ?? remotes[0] ?? list.find(p => p.isLocal) ?? list[0]
}

/** 지금 말하는 사람(나 제외) — "김서연 말하는 중" 배지와 마지막 화자 기억에 쓴다 */
export function currentRemoteSpeaker<T extends MiniCallParticipant>(list: T[]): T | null {
  return list.find(p => !p.isLocal && p.isSpeaking && !p.isMuted) ?? null
}

/** 영상이 없으면 높이 56 알약 */
export function miniCallHasVideo(p: MiniCallParticipant | null): boolean {
  return !!(p && (p.videoTrack || p.screenTrack))
}

/** 통화 경과 "12:43" · 한 시간 넘으면 "1:02:05". 음수·NaN 은 0:00 */
export function formatCallElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * 회의 화면에서 "작게 보기"·취소 뒤 갈 곳. 직전 화면이 앱 안의 다른 화면이면 뒤로,
 * 아니면(직접 연 탭·새로 고침·직전도 회의 화면) 목록.
 */
export function miniCallBackTarget(historyBack: string | null | undefined): 'back' | string {
  if (historyBack && historyBack.startsWith('/') && !isMeetingRoomPath(historyBack)) return 'back'
  return '/meetings'
}

/** 팝업으로 열린 회의 창인가(예전 진입·바깥 링크) — window.open 때 붙인 창 이름으로 안다 */
export function isMeetingPopupWindow(windowName: string): boolean {
  return windowName.startsWith('meeting-') || windowName.startsWith('jw-call-')
}

// ─── 핸드오프 12 A5(시안 R12Call) ───

/** 연결 상태 → 미니 창 모양: live(정상) · reconnecting(warning, role=status) · lost(danger, role=alert) */
export function miniCallTone(state: string): 'live' | 'reconnecting' | 'lost' {
  if (state === 'connected') return 'live'
  if (state === 'disconnected') return 'lost'
  return 'reconnecting'
}

/** 호스트 대기실 요청 띠 — 이 시간 동안 응답이 없으면 띠를 접고 점 배지만 남긴다 */
export const MINI_CALL_LOBBY_COLLAPSE_MS = 30_000

/** 처음 보는 대기실 신청 id(소리 1회·띠 다시 펼치기 기준). seen 은 바꾸지 않는다 */
export function newLobbyIds(seen: ReadonlySet<string>, list: ReadonlyArray<{ id: string }>): string[] {
  return list.filter(r => !seen.has(r.id)).map(r => r.id)
}

/** 회의 화면 "작게 보기" 단축키 Alt+M(맥 ⌥M 은 글자가 µ 로 바뀌므로 code 로 본다) */
export const MINIMIZE_KEYS = ['Alt', 'M']
export function isMinimizeShortcut(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code?: string; key?: string }): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
  return e.code === 'KeyM' || e.key === 'm' || e.key === 'M'
}

/** 미니 창에서 나간 뒤 토스트 — 남은 사람이 있으면 "나왔습니다 · n분 · 아직 m명" + [다시 참여], 없으면 "끝났습니다 · n분" */
export function miniCallLeaveSummary(others: number, minutes: number | null): { ended: boolean; minutes: number | null; others: number } {
  return { ended: others <= 0, minutes, others: Math.max(0, others) }
}
