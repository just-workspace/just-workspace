/**
 * 미니 통화 창 상태 계산 — 화면과 분리한 순수 함수(단위 테스트 대상).
 *
 * 우측 하단 320×180(여백 24), 네 모서리 스냅. 영상이 없으면 높이 56 의 알약 형태.
 * 모바일은 상태 표시줄 아래 36px 초록 띠 — 탭 시 통화 화면으로 이동.
 * 겹침: 통화 창 z 45 > 메일 작성 창 z 40. 둘 다 표시되면 작성 창이 (통화 창 폭 + 16)만큼 좌측으로 이동.
 */

export type MiniCallCorner = 'tl' | 'tr' | 'bl' | 'br'

export const MINI_CALL_WIDTH = 320
export const MINI_CALL_VIDEO_HEIGHT = 180
export const MINI_CALL_PILL_HEIGHT = 56
export const MINI_CALL_MARGIN = 24
/** 모바일 통화 띠 높이 */
export const MINI_CALL_BAND_HEIGHT = 36

/** 회의 화면(전체) 라우트 여부 — 해당 화면에서는 미니 창 대신 전체 회의 화면 표시 */
export function isMeetingRoomPath(path: string): boolean {
  return path.startsWith('/meetings/room/') || path.startsWith('/meetings/join/')
}

/**
 * 미니 통화 창 표시 여부. 통화 중(앱 수준 세션)이고, 복귀할 회의 화면이 있으며(로그인 사용자 세션),
 * 현재 화면이 회의 화면이 아닌 경우에만 표시. 손님(셸 없음)은 복귀 경로를 등록하지 않으므로 표시되지 않음.
 */
export function shouldShowMiniCall(s: { inCall: boolean; returnPath: string | null; path: string }): boolean {
  return s.inCall && !!s.returnPath && !isMeetingRoomPath(s.path)
}

/** 드롭 지점(창 중심)에서 가장 가까운 모서리 — 화면을 4분할하여 선택 */
export function nearestMiniCallCorner(x: number, y: number, viewportW: number, viewportH: number): MiniCallCorner {
  const left = x < viewportW / 2
  const top = y < viewportH / 2
  return (top ? 't' : 'b') + (left ? 'l' : 'r') as MiniCallCorner
}

/** 모서리 → fixed 위치 스타일 */
export function miniCallCornerStyle(corner: MiniCallCorner, margin = MINI_CALL_MARGIN): Record<string, string> {
  const m = `${margin}px`
  return {
    [corner[0] === 't' ? 'top' : 'bottom']: m,
    [corner[1] === 'l' ? 'left' : 'right']: m,
  }
}

/**
 * 메일 작성 창이 양보할 폭(useShell().miniCallWidth). 작성 창은 우측 하단에 고정되므로
 * 통화 창이 우측 하단에 표시된 경우에만 겹침 — 해당 경우에만 폭을 설정한다. 모바일(띠)은 0.
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
 * 미니 창 타일에 표시할 참가자. 우선순위:
 *  1) 화면 공유 중인 참가자  2) 현재 발화 중인 타 참가자  3) 마지막으로 발화한 타 참가자(방에 남아 있는 경우)
 *  4) 영상이 켜진 타 참가자  5) 임의의 타 참가자  6) 본인
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

/** 현재 발화자(본인 제외) — "김서연 말하는 중" 배지와 마지막 화자 기록에 사용 */
export function currentRemoteSpeaker<T extends MiniCallParticipant>(list: T[]): T | null {
  return list.find(p => !p.isLocal && p.isSpeaking && !p.isMuted) ?? null
}

/** 영상이 없으면 높이 56 알약 */
export function miniCallHasVideo(p: MiniCallParticipant | null): boolean {
  return !!(p && (p.videoTrack || p.screenTrack))
}

/** 통화 경과 "12:43" · 1시간 초과 시 "1:02:05". 음수·NaN 은 0:00 */
export function formatCallElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * 회의 화면에서 "작게 보기"·취소 후 이동 대상. 직전 화면이 앱 내 다른 화면이면 뒤로 이동,
 * 그 외(직접 연 탭·새로 고침·직전도 회의 화면)에는 목록으로 이동.
 */
export function miniCallBackTarget(historyBack: string | null | undefined): 'back' | string {
  if (historyBack && historyBack.startsWith('/') && !isMeetingRoomPath(historyBack)) return 'back'
  return '/meetings'
}

/** 팝업으로 열린 회의 창 여부(구 진입 방식·외부 링크) — window.open 시 지정한 창 이름으로 판별 */
export function isMeetingPopupWindow(windowName: string): boolean {
  return windowName.startsWith('meeting-') || windowName.startsWith('jw-call-')
}

// ─── 미니 창 상태·모양 ───

/** 연결 상태 → 미니 창 모양: live(정상) · reconnecting(warning, role=status) · lost(danger, role=alert) */
export function miniCallTone(state: string): 'live' | 'reconnecting' | 'lost' {
  if (state === 'connected') return 'live'
  if (state === 'disconnected') return 'lost'
  return 'reconnecting'
}

/** 호스트 대기실 요청 띠 — 이 시간 동안 응답이 없으면 띠를 접고 점 배지만 유지 */
export const MINI_CALL_LOBBY_COLLAPSE_MS = 30_000

/** 신규 대기실 신청 id(소리 1회·띠 재펼침 기준). seen 은 변경하지 않음 */
export function newLobbyIds(seen: ReadonlySet<string>, list: ReadonlyArray<{ id: string }>): string[] {
  return list.filter(r => !seen.has(r.id)).map(r => r.id)
}

/** 회의 화면 "작게 보기" 단축키 Alt+M(맥 ⌥M 은 문자가 µ 로 변환되므로 code 로 판별) */
export const MINIMIZE_KEYS = ['Alt', 'M']
export function isMinimizeShortcut(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code?: string; key?: string }): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
  return e.code === 'KeyM' || e.key === 'm' || e.key === 'M'
}

/** 미니 창에서 퇴장한 뒤의 토스트 — 남은 참가자가 있으면 "나왔습니다 · n분 · 아직 m명" + [다시 참여], 없으면 "끝났습니다 · n분" */
export function miniCallLeaveSummary(others: number, minutes: number | null): { ended: boolean; minutes: number | null; others: number } {
  return { ended: others <= 0, minutes, others: Math.max(0, others) }
}
