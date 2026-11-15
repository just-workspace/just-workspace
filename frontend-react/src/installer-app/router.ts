/**
 * 화면 주소 — `#/domain` 처럼 주소의 # 뒤에 단계 이름을 둔다. 새로 고침과 뒤로 가기가 그대로 동작하고,
 * 서버가 어떤 경로로 이 파일을 내주든 상관없다(경로 규칙을 서버와 맞출 필요가 없다).
 * `#/domain?fix=1` 은 요약 화면의 "고치기"로 들어온 것 — "다음" 대신 "요약으로 돌아가기"를 보인다.
 */
import { useSyncExternalStore } from 'react'
import { ROUTES, type RouteId } from './flow'

export interface Route {
  /** 주소에 적힌 화면. 없거나 모르는 이름이면 null */
  id: RouteId | null
  /** 요약에서 고치러 들어왔다 */
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

/** 화면을 옮긴다. replace 면 방문 기록에 남기지 않는다(자동으로 넘기는 경우) */
export function navigate(id: RouteId, opts: { fix?: boolean; replace?: boolean } = {}): void {
  const target = hashFor(id, opts)
  if (window.location.hash === target) return
  if (opts.replace) {
    const url = window.location.pathname + window.location.search + target
    window.history.replaceState(window.history.state, '', url)
  } else {
    window.location.hash = target
  }
  // 주소를 바꾼 것을 바로 알린다(replaceState 는 알림이 없고, hash 대입의 알림은 한 박자 늦다)
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
 * 주소에 실려 온 설치 토큰을 꺼내고 주소에서 지운다(방문 기록·화면에 남기지 않는다).
 * 돌려준 값은 세션을 만드는 데 한 번 쓰고 버린다.
 */
export function takeTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token')
  if (token == null) return null
  params.delete('token')
  const query = params.toString()
  window.history.replaceState(window.history.state, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash)
  return token
}
