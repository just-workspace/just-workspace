/**
 * 화면 주소 — `#/domain` 처럼 주소의 # 뒤에 단계 이름을 둔다. 새로 고침과 뒤로 가기가 그대로 동작하며,
 * 서버가 이 파일을 제공하는 경로와 무관하다(경로 규칙을 서버와 일치시킬 필요가 없다).
 * `#/domain?fix=1` 은 요약 화면의 "고치기"로 진입한 경우이다 — "다음" 대신 "요약으로 돌아가기"를 표시한다.
 */
import { useSyncExternalStore } from 'react'
import { ROUTES, type RouteId } from './flow'

export interface Route {
  /** 주소에 지정된 화면. 없거나 알 수 없는 이름이면 null */
  id: RouteId | null
  /** 요약에서 수정을 위해 진입함 */
  fix: boolean
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [path, query = ''] = raw.split('?')
  const name = path.replace(/\/+$/, '')
  const id = (ROUTES as string[]).includes(name) ? (name as RouteId) : null
  return { id, fix: new URLSearchParams(query).get('fix') === '1' }
}

export function hashFor(id: RouteId, opts: { fix?: boolean } = {}): string {
  return `#/${id}${opts.fix ? '?fix=1' : ''}`
}

/** 화면 이동. replace 이면 방문 기록에 남기지 않음(자동 이동의 경우) */
export function navigate(id: RouteId, opts: { fix?: boolean; replace?: boolean } = {}): void {
  const target = hashFor(id, opts)
  if (window.location.hash === target) return
  if (opts.replace) {
    const url = window.location.pathname + window.location.search + target
    window.history.replaceState(window.history.state, '', url)
  } else {
    window.location.hash = target
  }
  // 주소 변경을 즉시 통지한다(replaceState 는 이벤트가 발생하지 않고, hash 대입의 이벤트는 지연된다)
  window.dispatchEvent(new Event('hashchange'))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  window.addEventListener('popstate', onChange)
  return () => {
    window.removeEventListener('hashchange', onChange)
    window.removeEventListener('popstate', onChange)
  }
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => '')
  return parseHash(hash)
}

/**
 * 주소에 포함되어 전달된 설치 토큰을 추출하고 주소에서 제거한다(방문 기록·화면에 남기지 않는다).
 * 반환값은 세션 생성에 1회 사용한 뒤 폐기한다.
 */
/**
 * 서버가 주소의 토큰을 확인하고 토큰 없는 주소로 이동시키면서 전달한 결과(`?token_status=wrong|expired|locked`).
 * 추출 후 주소에서 제거한다. 없으면 null.
 */
export function takeTokenStatusFromUrl(): { status: 'wrong' | 'expired' | 'locked'; retry_after?: number } | null {
  const params = new URLSearchParams(window.location.search)
  const status = params.get('token_status')
  if (status == null) return null
  const retry = Number(params.get('retry_after')) || undefined
  params.delete('token_status')
  params.delete('retry_after')
  const query = params.toString()
  window.history.replaceState(window.history.state, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash)
  if (status !== 'wrong' && status !== 'expired' && status !== 'locked') return null
  return { status, retry_after: retry }
}

export function takeTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token')
  if (token == null) return null
  params.delete('token')
  const query = params.toString()
  window.history.replaceState(window.history.state, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash)
  return token
}
