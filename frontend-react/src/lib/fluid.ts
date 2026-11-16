/**
 * 유동 레이아웃 규칙 — 순수 함수만 포함.
 *
 * 원칙: 배율을 먼저 결정하고, 레이아웃은 배율 적용 후의 "실효 폭·높이"(CSS px ÷ 배율)로만 결정한다.
 * 부품 px 값은 변경하지 않는다 — 배율(루트 zoom)이 확대를 담당한다.
 *
 * 상태·리스너는 composables/useViewport 가 보유한다. 본 모듈의 함수는 표 기반 테스트(tests/lib/fluid.test.ts)로 고정한다.
 */

/** 배율 구간 [최소, 배율] — 오름차순 */
type Band = ReadonlyArray<readonly [number, number]>

/** 폭 구간: 2560↑ 1.25 · 3840↑ 1.5 · 5120↑ 2 · 7680↑ 3 */
export const WIDTH_BANDS: Band = [[2560, 1.25], [3840, 1.5], [5120, 2], [7680, 3]]
/** 높이 구간: 1440↑ 1.25 · 2160↑ 1.5 · 2880↑ 2 · 4320↑ 3 */
export const HEIGHT_BANDS: Band = [[1440, 1.25], [2160, 1.5], [2880, 2], [4320, 3]]

/** 모바일(이 폭 미만)에는 배율을 적용하지 않는다 — useIsMobile 의 767px 과 대응한다 */
export const MOBILE_MAX = 767

/** 설정 › 표시 › 화면 크기 선택지(%). 'auto' = 구간 배율 */
export const UI_SCALE_CHOICES = ['auto', 100, 125, 150, 200, 300] as const
export type UiScalePref = typeof UI_SCALE_CHOICES[number]

/**
 * 수동 배율의 하한 — 배율 적용 후 실효 폭이 이 값보다 작아지는 배율은 선택할 수 없다.
 * "자동"은 항상 선택 가능하다. 화면 변경으로 현재 값이 범위를 벗어나면 자동으로 재설정한다(useViewport).
 */
export const UI_SCALE_MIN_WIDTH = 1280

/** 이 화면(창 CSS 폭)에서 선택 가능한 배율인지 여부 — 'auto' 와 모바일은 항상 가능 */
export function uiScaleAllowed(pref: UiScalePref, rawWidth: number): boolean {
  if (pref === 'auto' || rawWidth <= MOBILE_MAX) return true
  return Math.round(rawWidth / (pref / 100)) >= UI_SCALE_MIN_WIDTH
}

const band = (x: number, steps: Band) => steps.reduce((a, [min, k]) => (x >= min ? k : a), 1)
export const clamp = (a: number, x: number, b: number) => Math.max(a, Math.min(b, x))

/** 자동 배율 = min(폭 구간, 높이 구간). 모바일 폭이면 1 */
export function autoScale(w: number, h: number): number {
  if (w <= MOBILE_MAX) return 1
  return Math.min(band(w, WIDTH_BANDS), band(h, HEIGHT_BANDS))
}

/** 실제 적용할 배율 — 선택(자동·%)과 화면 크기 기준. 모바일은 항상 1 */
export function resolveScale(pref: UiScalePref, w: number, h: number): number {
  if (w <= MOBILE_MAX) return 1
  return pref === 'auto' ? autoScale(w, h) : pref / 100
}

export interface Effective {
  /** 배율 */
  scale: number
  /** 실효 폭·높이(CSS px ÷ 배율, 반올림) */
  width: number
  height: number
  /** 세로 화면 = 실효 높이 > 폭 */
  portrait: boolean
  /** 실질적으로 낮은 창 = 실효 높이 < 760 — 상단 띠 36 · 대시보드 인사 줄 숨김 */
  low: boolean
}

export function effective(w: number, h: number, scale: number): Effective {
  const width = Math.round(w / scale), height = Math.round(h / scale)
  return { scale, width, height, portrait: height > width, low: height < LOW_HEIGHT }
}

/** 낮은 화면 기준(실효 높이) */
export const LOW_HEIGHT = 760

// ── 셸 ──
export const RAIL_NARROW = 64
export const RAIL_WIDE = 236
/** 레일 기본 펼침 기준(실효 폭) */
export const RAIL_WIDE_MIN = 1920

/** 레일 기본값 — 실효 폭 ≥ 1920 이면 펼침, 세로 화면은 항상 64 */
export function railWideByDefault(width: number, portrait: boolean): boolean {
  return !portrait && width >= RAIL_WIDE_MIN
}

// ── 대시보드 ──
/** 카드 한 칸 최대 폭 — 그리드 최대 = 열 × 520(가운데) */
export const DASH_COL_MAX = 520

/**
 * 공식 예외 기준 — 가로 화면이라도 실효 폭이 이 값보다 작으면 대시보드는 2열.
 * 공식상으로는 3열이지만(하한 3) 1280 미만에서는 카드 한 칸이 과도하게 좁아지므로 2열을 유지한다.
 */
export const DASH_TWO_COL_BELOW = 1280

/**
 * 열 = clamp(3, floor((본문 폭 − 56 + 20) / 400), 6). 세로 화면 2.
 * 공식 예외: 가로 화면이고 실효 폭(effectiveWidth) < 1280 이면 2열.
 * @param effectiveWidth 화면 실효 폭(레일 포함). 생략 시 예외를 적용하지 않는다(표 계산용)
 */
export function dashColumns(mainWidth: number, portrait: boolean, effectiveWidth?: number): number {
  if (portrait) return 2
  if (effectiveWidth != null && effectiveWidth < DASH_TWO_COL_BELOW) return 2
  return clamp(3, Math.floor((mainWidth - 56 + 20) / 400), 6)
}

/** 카드 수 = clamp(6, 열 × 2, 12) — 상위 두 줄이 항상 채워지도록 */
export function dashCardCount(cols: number): number {
  return clamp(6, cols * 2, 12)
}

// ── 목록 + 상세 ──
/** 메일·파일 목록 열 = clamp(320, 본문 폭 × 24%, 440). 세로 화면은 본문 폭 전체(위 42%) */
export function listColumnWidth(mainWidth: number, portrait = false): number {
  if (portrait) return mainWidth
  return Math.round(clamp(320, mainWidth * 0.24, 440))
}

/** 메일 오른쪽 보낸 사람 패널(360) 자동 펼침 — 상세 칸 ≥ 1400, 가로 화면 */
export const MAIL_SIDE_MIN_PANE = 1400
export const MAIL_SIDE_WIDTH = 360
export function mailSideOpen(paneWidth: number, portrait: boolean): boolean {
  return !portrait && paneWidth >= MAIL_SIDE_MIN_PANE
}

// ── 채팅 ──
// 디스코드식 4열 셸부터 채팅 화면은 아래 유동 폭 대신 고정 폭을 사용한다:
//   채널 목록 = 개인 설정 chatSidebarWidth(useUserPrefs CHAT_LIST_WIDTH 기본 298 · 199–367 드래그),
//   오른쪽 자리 = utils/chatRightColumn RIGHT_COLUMN_WIDTH(멤버 264 · 400 · 음성 글 340), 1180 미만 덮개.
// chatSideWidth · chatThreadDocked 는 표 테스트(tests/lib/fluid)와 구 화면 계산을 위해 유지한다.
/** (구 계산) 채팅 채널 목록 = clamp(240, 본문 폭 × 16%, 320) */
export function chatSideWidth(mainWidth: number): number {
  return Math.round(clamp(240, mainWidth * 0.16, 320))
}
/** 세로 화면 채널 서랍 폭 */
export const CHAT_DRAWER_WIDTH = 260
/** 채팅 메시지 열 최대(왼쪽 정렬, 입력 칸 같은 폭) */
export const CHAT_COLUMN_MAX = 1040
/** 채팅 오른쪽 패널(스레드 400) 펼침 상태 유지 — (본문 − 채널 목록) ≥ 1840, 가로 화면 */
export const CHAT_THREAD_MIN = 1840
export function chatThreadDocked(mainWidth: number, sideWidth: number, portrait: boolean): boolean {
  return !portrait && mainWidth - sideWidth >= CHAT_THREAD_MIN
}

/** 셸 본문 폭(실효 폭 − 레일) */
export function mainWidthOf(width: number, railWide: boolean): number {
  return width - (railWide ? RAIL_WIDE : RAIL_NARROW)
}
