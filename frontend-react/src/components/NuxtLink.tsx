/**
 * 앱 안 링크 — `<NuxtLink to="x" className="…">`.
 *
 * - to: 문자열 또는 { path, query, hash }
 * - 외부 주소(http:, mailto: 등)나 external 이면 일반 <a>
 * - 같은 페이지 해시(#general)는 기본 앵커 동작
 * 활성 링크 클래스(router-link-active)는 앱 CSS 가 쓰지 않아 붙이지 않는다.
 */
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { Link } from 'react-router'
import { resolve, type RouteLocationRaw } from '~/lib/router'

export interface NuxtLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** 이동 대상 */
  to: RouteLocationRaw
  /** 기록을 바꾸지 않고 대체 */
  replace?: boolean
  /** 외부 주소로 취급(전체 새로 고침) */
  external?: boolean
  children?: ReactNode
}

export const NuxtLink = forwardRef<HTMLAnchorElement, NuxtLinkProps>(function NuxtLink(
  { to, replace, external, children, ...rest },
  ref,
) {
  const raw = typeof to === 'string' ? to : resolve(to).fullPath
  const isExternal = external || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')
  if (isExternal || raw.startsWith('#')) {
    return <a ref={ref} href={raw} {...rest}>{children}</a>
  }
  // 앱 안 문자열 주소도 객체 주소와 같은 쿼리 모양으로(href·주소창 1:1)
  const href = typeof to === 'string' && to.startsWith('/') ? resolve(to).fullPath : raw
  return <Link ref={ref} to={href} replace={replace} {...rest}>{children}</Link>
})

export default NuxtLink
