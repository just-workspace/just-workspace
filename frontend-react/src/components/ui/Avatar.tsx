/**
 * 아바타 — 사진 또는 이니셜. 크기는 외부 className(h-/w-, 기본 40)으로, 이니셜 글자 크기는 textSize 로 지정한다.
 * (외부 className 의 text-* 는 안쪽 이니셜 칸의 기본 text-sm 에 가려 적용되지 않는다 — textSize 사용 필수.)
 */
import type { HTMLAttributes } from 'react'
import { cn } from '~/lib/utils'

export interface UiAvatarProps extends HTMLAttributes<HTMLDivElement> {
  /** 사진 주소. 없으면 이니셜 */
  src?: string | null
  /** 사진 대체 글(기본 '') */
  alt?: string
  /** 이니셜(기본 '?') */
  fallback?: string
  /** 이니셜 글자 크기 — 숫자 = px(예: 11), 문자열 = 클래스(반응형 예: 'text-xs md:text-[11px]'). 없으면 text-sm */
  textSize?: number | string
}

/**
 * 원형 아바타.
 * @example <UiAvatar src={user.avatar_url} fallback="김" className="h-7 w-7" textSize={11} />
 */
export function UiAvatar({ src, alt, fallback, textSize, className, ...rest }: UiAvatarProps) {
  const textClass = typeof textSize === 'string' ? textSize : textSize ? '' : 'text-sm'
  const textStyle = typeof textSize === 'number' ? { fontSize: `${textSize}px` } : undefined
  return (
    <div {...rest} className={cn('relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full', className ?? '')}>
      {src
        ? <img src={src} alt={alt ?? ''} className="aspect-square h-full w-full object-cover" />
        : (
          <div className={cn('flex h-full w-full items-center justify-center rounded-full bg-muted font-medium', textClass)} style={textStyle}>
            {fallback ?? '?'}
          </div>
        )}
    </div>
  )
}

export default UiAvatar
