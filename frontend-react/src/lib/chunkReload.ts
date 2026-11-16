/**
 * 재배포 후 구버전 화면 조각(chunk) 로드 실패 → 오류 화면 대신 1회 새로고침.
 *
 * 화면 파일 이름에 내용 해시가 포함되므로 재배포 시 기존 이름은 서버에서 제거된다.
 * 열려 있던 탭에서 메뉴를 이동하면 기존 이름으로 다음 화면을 로드하다가 실패한다(동적 import 실패).
 * 이는 장애가 아니라 신규 버전 배포를 의미하므로, 새로고침하면 즉시 신규 버전으로 열린다.
 * 동일 탭에서 단시간 내 반복되면(실제 장애) 새로고침하지 않고 오류 화면을 표시한다.
 */

const KEY = 'jw:chunk-reload-at'
const WINDOW_MS = 30_000

/** 이 탭에서 새로고침을 이미 시작했는지 여부 — 새로고침 직전 오류 화면 깜박임 방지 */
let reloading = false
export function isReloading() { return reloading }

const PATTERNS = [
  /Failed to fetch dynamically imported module/i,   // Chromium
  /error loading dynamically imported module/i,     // Firefox
  /Importing a module script failed/i,              // Safari
  /Unable to preload CSS/i,                         // Vite CSS 프리로드
  /Loading (CSS )?chunk [\w-]+ failed/i,
]

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false
  const msg = typeof err === 'string' ? err : (err as { message?: unknown }).message
  return typeof msg === 'string' && PATTERNS.some(p => p.test(msg))
}

/** 새로고침을 시작했으면 true. 직전(30초 이내)에 이미 수행했으면 false — 오류 화면을 표시해야 한다. */
export function reloadOnce(now = Date.now(), storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSession(), reload = () => window.location.reload()): boolean {
  try {
    const last = Number(storage?.getItem(KEY) || 0)
    if (last && now - last < WINDOW_MS) return false
    storage?.setItem(KEY, String(now))
  } catch { /* 저장소 접근 불가 — 이 경우에도 1회는 새로고침 */ }
  reloading = true
  reload()
  return true
}

function safeSession(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

/**
 * Vite 가 프리로드 실패 시 발생시키는 이벤트 — 새로고침만 수행한다.
 * preventDefault 는 호출하지 않는다: 호출 시 import 가 undefined 로 resolve 되어 화면 측에서 무관한 오류(… 'default')가 발생한다.
 * 오류는 그대로 라우터 오류 경계로 전달되며, 해당 경계는 isReloading() 이면 아무것도 렌더링하지 않는다.
 */
export function installChunkReload() {
  window.addEventListener('vite:preloadError', () => { reloadOnce() })
}
