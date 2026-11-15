/**
 * 데스크톱 셸(Electron) 안에서 렌더되는지 판별.
 *
 * 데스크톱 앱은 타이틀바·좌측 레일을 네이티브로 직접 그리고, 이 웹앱은 그 안쪽 본문 자리에만 얹힌다.
 * 그래서 셸 안에서는 웹앱의 같은 껍데기(전역 사이드바·상단바·모바일 탭바)를 그리지 않는다.
 * 판별은 User-Agent 로 한다(쿼리는 링크 한 번에 사라지고, 쿠키는 일반 탭까지 물들인다).
 *
 * 모듈 목록 칸(채팅 채널 목록·메일 폴더·파일 위치·캘린더 목록)은 셸 버전에 따라 다르다.
 *  - 0.3.1+ 셸: 셸이 목록을 그리지 않는다 → 웹이 자기 목록 칸을 그린다.
 *  - 0.3.0 이하 셸: 셸이 자기 목록 칸을 따로 그린다 → 업데이트 전까지는 웹이 숨겨 두 벌이 안 되게 한다.
 * 셸은 UA 에 `JustWorkspaceDesktop/<버전>` 을 싣는다(apps/desktop/src/main/windows/shell.ts).
 *
 * 0.5.0 부터 셸은 레일·검색·상단바를 아예 그리지 않는다(창 테두리 한 줄만) — 사이드바·상단바·활동 패널·
 * 사용자 메뉴·플러그인 상단 버튼까지 웹이 브라우저와 똑같이 그린다. 웹 껍데기를 숨기는 건 0.5.0 미만 셸뿐이다.
 *
 * React: const { isDesktopShell, shellHidesWebChrome, shellDrawsLists, navOwnedByShell } = useDesktopShell()
 */
import { useRoute } from '~/lib/router'

export const DESKTOP_SHELL_UA_MARK = 'JustWorkspaceDesktop'

/** 이 버전부터 셸이 모듈 목록 칸을 그리지 않는다 */
export const SHELL_WEB_LISTS_SINCE: readonly [number, number, number] = [0, 3, 1]

/** 이 버전부터 셸이 레일·상단바를 그리지 않는다 — 웹 껍데기(사이드바·상단바·활동 패널)를 그대로 그린다 */
export const SHELL_WEB_CHROME_SINCE: readonly [number, number, number] = [0, 5, 0]

/** UA 에서 셸 버전을 뽑는다. 셸이 아니면 null, 셸인데 버전을 못 읽으면 [0,0,0](옛 셸로 본다). */
export function parseShellVersion(ua: string): [number, number, number] | null {
  const at = ua.indexOf(DESKTOP_SHELL_UA_MARK)
  if (at < 0) return null
  const m = /^\/(\d+)\.(\d+)\.(\d+)/.exec(ua.slice(at + DESKTOP_SHELL_UA_MARK.length))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
}

/** 셸 버전이 since 보다 옛것인가. 셸이 아니면 false. */
function shellOlderThan(ua: string, since: readonly [number, number, number]): boolean {
  const v = parseShellVersion(ua)
  if (!v) return false
  for (let i = 0; i < 3; i++) {
    if (v[i] !== since[i]) return v[i] < since[i]
  }
  return false
}

/** 이 UA 의 셸이 모듈 목록 칸을 자체로 그리는가(= 옛 셸, 0.3.1 미만). 셸이 아니면 false. */
export function shellDrawsListsFor(ua: string): boolean {
  return shellOlderThan(ua, SHELL_WEB_LISTS_SINCE)
}

/** 이 UA 의 셸이 자체 레일·상단바를 그려 웹 껍데기를 숨겨야 하는가(= 0.5.0 미만 셸). 셸이 아니면 false. */
export function shellHidesWebChromeFor(ua: string): boolean {
  return shellOlderThan(ua, SHELL_WEB_CHROME_SINCE)
}

const _ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const _isDesktopShell = _ua.includes(DESKTOP_SHELL_UA_MARK)
const _shellDrawsLists = shellDrawsListsFor(_ua)
const _shellHidesWebChrome = shellHidesWebChromeFor(_ua)

export function isDesktopShellNow(): boolean {
  return _isDesktopShell
}

export function useDesktopShell() {
  const route = useRoute()
  /**
   * 좌측 범위 선택 열(폴더·위치·캘린더·목록)을 셸이 그리는가 — 옛 셸(0.3.0 이하)만 해당.
   * 옛 셸이 URL 에 `nav=shell` 을 붙여 알려준다. 참이면 이 페이지는 그 열을 렌더하지 않는다(건너뛴다).
   * 0.3.1+ 셸은 nav=shell 을 붙이지 않고, 붙어 와도 무시한다(목록 칸은 웹이 그린다).
   */
  const navOwnedByShell = _shellDrawsLists && route.query.nav === 'shell'
  return { isDesktopShell: _isDesktopShell, shellHidesWebChrome: _shellHidesWebChrome, shellDrawsLists: _shellDrawsLists, navOwnedByShell }
}
