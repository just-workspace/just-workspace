/**
 * 앱 내부 링크 — `<NuxtLink to="x" className="…">`.
 *
 * - to: 문자열 또는 { path, query, hash }
 * - 외부 주소(http:, mailto: 등)이거나 external 이면 일반 <a>
 * - 동일 페이지 해시(#general)는 기본 앵커 동작
 * 활성 링크 클래스(router-link-active)는 앱 CSS 에서 사용하지 않으므로 부여하지 않는다.
 */
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { Link } from 'react-router'
import { resolve, type RouteLocationRaw } from '~/lib/router'

export interface NuxtLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** 이동 대상 */
  to: RouteLocationRaw
  /** 히스토리 항목 추가 없이 현재 항목 대체 */
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
  // 앱 내부 문자열 주소도 객체 주소와 동일한 쿼리 형태로 정규화(href·주소창 1:1)
  const href = typeof to === 'string' && to.startsWith('/') ? resolve(to).fullPath : raw
  return <Link ref={ref} to={href} replace={replace} {...rest}>{children}</Link>
})

export default NuxtLink
