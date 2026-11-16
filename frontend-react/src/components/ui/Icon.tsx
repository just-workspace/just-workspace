/**
 * 공용 선 아이콘(24 격자 1세트). 이름은 utils/icons.ts ICON_PATHS 키.
 * 글리프(✕ ▾ ⋯ ⋮ ‹ › ★)를 사용하던 위치는 `<UiIcon name="close" className="h-4 w-4" />` 로 대체한다.
 * 크기는 외부 className(h-/w-)으로 지정한다. 미등록 이름은 점(dot)으로 렌더링한다.
 * width·height 속성(size, 기본 16)도 함께 출력한다 — CSS(Tailwind 클래스·부모 [&>svg] 규칙)가 표현 속성보다 우선하므로
 * 앱 외형은 동일하며, 클래스가 적용되지 않는 곳(디자인 캔버스 등)에서도 16px 로 렌더링된다.
 */
import type { SVGAttributes } from 'react'
import { cn } from '~/lib/utils'
import { iconPaths } from '~/utils/icons'

export interface UiIconProps extends Omit<SVGAttributes<SVGSVGElement>, 'strokeWidth' | 'name'> {
  /** 아이콘 이름(utils/icons.ts ICON_PATHS 키 또는 lucide 별칭). 예: 'close' · 'check' · 'chevron-down' */
  name: string
  /** 선 굵기(기본 2). 작은 아이콘(≤14px)은 2.2~2.4 권장 */
  strokeWidth?: number | string
  /** 채운 아이콘(별표 켬 등). 기본은 선만 */
  filled?: boolean
  /** width·height 속성(기본 16). 클래스(h-/w-/size-)가 있으면 클래스가 우선한다 */
  size?: number | string
}

/**
 * 선 아이콘(svg, aria-hidden).
 * @example <UiIcon name="search" className="h-4 w-4 text-muted-foreground" />
 */
export function UiIcon({ name, strokeWidth = 2, filled = false, size = 16, className, ...rest }: UiIconProps) {
  return (
    <svg
      width={size}
      height={size}
      {...rest}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
      dangerouslySetInnerHTML={{ __html: iconPaths(name) }}
    />
  )
}

export default UiIcon
