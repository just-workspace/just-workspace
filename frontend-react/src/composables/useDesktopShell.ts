/**
 * 데스크톱 셸(Electron) 내부 렌더 여부 판별.
 *
 * 데스크톱 앱은 타이틀바·좌측 레일을 네이티브로 직접 렌더하고, 본 웹앱은 그 내부 본문 영역에만 배치된다.
 * 따라서 셸 내부에서는 웹앱의 동일 껍데기(전역 사이드바·상단바·모바일 탭바)를 렌더하지 않는다.
 * 판별은 User-Agent 로 수행한다(쿼리는 링크 이동 1회로 소실되고, 쿠키는 일반 탭에까지 영향을 준다).
 *
 * 모듈 목록 칸(채팅 채널 목록·메일 폴더·파일 위치·캘린더 목록)은 셸 버전에 따라 상이하다.
 *  - 0.3.1+ 셸: 셸이 목록을 렌더하지 않는다 → 웹이 자체 목록 칸을 렌더한다.
 *  - 0.3.0 이하 셸: 셸이 자체 목록 칸을 별도로 렌더한다 → 업데이트 전까지는 웹이 숨겨 중복 표시를 방지한다.
 * 셸은 UA 에 `JustWorkspaceDesktop/<버전>` 을 포함한다(apps/desktop/src/main/windows/shell.ts).
 *
 * 0.5.0 부터 셸은 레일·검색·상단바를 렌더하지 않는다(창 테두리 한 줄만) — 사이드바·상단바·활동 패널·
 * 사용자 메뉴·플러그인 상단 버튼까지 웹이 브라우저와 동일하게 렌더한다. 웹 껍데기를 숨기는 것은 0.5.0 미만 셸뿐이다.
 *
 * React: const { isDesktopShell, shellHidesWebChrome, shellDrawsLists, navOwnedByShell } = useDesktopShell()
 */
import { useRoute } from '~/lib/router'

export const DESKTOP_SHELL_UA_MARK = 'JustWorkspaceDesktop'

/** 이 버전부터 셸이 모듈 목록 칸을 렌더하지 않는다 */
export const SHELL_WEB_LISTS_SINCE: readonly [number, number, number] = [0, 3, 1]

/** 이 버전부터 셸이 레일·상단바를 렌더하지 않는다 — 웹 껍데기(사이드바·상단바·활동 패널)를 그대로 렌더한다 */
export const SHELL_WEB_CHROME_SINCE: readonly [number, number, number] = [0, 5, 0]

/** UA 에서 셸 버전을 추출한다. 셸이 아니면 null, 셸이나 버전 판독 불가 시 [0,0,0](구 셸로 간주). */
export function parseShellVersion(ua: string): [number, number, number] | null {
  const at = ua.indexOf(DESKTOP_SHELL_UA_MARK)
  if (at < 0) return null
  const m = /^\/(\d+)\.(\d+)\.(\d+)/.exec(ua.slice(at + DESKTOP_SHELL_UA_MARK.length))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
}

/** 셸 버전이 since 보다 이전인지 여부. 셸이 아니면 false. */
function shellOlderThan(ua: string, since: readonly [number, number, number]): boolean {
  const v = parseShellVersion(ua)
  if (!v) return false
  for (let i = 0; i < 3; i++) {
    if (v[i] !== since[i]) return v[i] < since[i]
  }
  return false
}

/** 이 UA 의 셸이 모듈 목록 칸을 자체 렌더하는지 여부(= 구 셸, 0.3.1 미만). 셸이 아니면 false. */
export function shellDrawsListsFor(ua: string): boolean {
  return shellOlderThan(ua, SHELL_WEB_LISTS_SINCE)
}

/** 이 UA 의 셸이 자체 레일·상단바를 렌더하여 웹 껍데기를 숨겨야 하는지 여부(= 0.5.0 미만 셸). 셸이 아니면 false. */
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
   * 좌측 범위 선택 열(폴더·위치·캘린더·목록)의 셸 렌더 여부 — 구 셸(0.3.0 이하)만 해당한다.
   * 구 셸이 URL 에 `nav=shell` 을 추가해 통지한다. 참이면 이 페이지는 해당 열을 렌더하지 않는다(생략).
   * 0.3.1+ 셸은 nav=shell 을 추가하지 않으며, 포함되어 있어도 무시한다(목록 칸은 웹이 렌더한다).
   */
  const navOwnedByShell = _shellDrawsLists && route.query.nav === 'shell'
  return { isDesktopShell: _isDesktopShell, shellHidesWebChrome: _shellHidesWebChrome, shellDrawsLists: _shellDrawsLists, navOwnedByShell }
}
