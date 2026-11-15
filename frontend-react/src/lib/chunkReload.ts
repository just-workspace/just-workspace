/**
 * 재배포 뒤 옛 화면 조각(chunk) 로드 실패 → 오류 화면 대신 한 번 새로고침.
 *
 * 화면 파일 이름에 내용 해시가 붙어 있어 새로 배포하면 옛 이름은 서버에서 사라진다.
 * 열려 있던 탭이 메뉴를 옮기면 옛 이름으로 다음 화면을 불러오다 실패한다(동적 import 실패).
 * 이건 고장이 아니라 "새 판이 나왔다"는 뜻이므로 새로고침하면 바로 새 판으로 열린다.
 * 같은 탭에서 짧은 시간에 되풀이되면(정말 고장) 새로고침하지 않고 오류 화면을 보인다.
 */

const KEY = 'jw:chunk-reload-at'
const WINDOW_MS = 30_000

/** 이 탭에서 새로고침을 이미 걸었는가 — 새로고침 직전 오류 화면이 번쩍이지 않게 */
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

/** 새로고침을 시작했으면 true. 직전(30초 안)에 이미 했으면 false — 오류 화면을 보여야 한다. */
export function reloadOnce(now = Date.now(), storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSession(), reload = () => window.location.reload()): boolean {
  try {
    const last = Number(storage?.getItem(KEY) || 0)
    if (last && now - last < WINDOW_MS) return false
    storage?.setItem(KEY, String(now))
  } catch { /* 저장소 막힘 — 그래도 한 번은 새로고침 */ }
  reloading = true
  reload()
  return true
}

function safeSession(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

/**
 * Vite 가 프리로드 실패 때 쏘는 이벤트 — 새로고침만 건다.
 * preventDefault 는 하지 않는다: 하면 import 가 undefined 로 풀려 화면 쪽에서 엉뚱한 오류(… 'default')가 난다.
 * 오류는 그대로 라우터 오류 경계로 가고, 거기서 isReloading() 이면 아무것도 그리지 않는다.
 */
export function installChunkReload() {
  window.addEventListener('vite:preloadError', () => { reloadOnce() })
}
