/**
 * 상태 점 공용(시안 I): ● 온라인/정상/Live · ◐ 자리 비움/느림/연결 중 · ⊖ 방해 금지/중단/실패 · ○ 오프라인/꺼짐/예정.
 * 모양 4종이라 색만으로 의미를 주지 않는다. 크기 10(≤32 아바타·행) / 12(≥40 아바타).
 * 아바타 귀퉁이에 올릴 때는 ring 으로 바탕색 2px 링을 준다(bg-background / bg-card).
 */
import type { HTMLAttributes } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'

type Shape = 'full' | 'half' | 'minus' | 'empty'

export interface UiStatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  /** 사람: online·away·dnd·offline / 서비스: ok·slow·down·off / 회의·AI: live·connecting·failed·scheduled (그 밖 success·busy·error·unknown) */
  status: string
  /** 지름 px — 10(기본) · 12(≥40 아바타) · 8 */
  size?: 10 | 12 | 8
  /** 접근성 라벨(= title). 없으면 상태별 기본 문구(ui.status.*) */
  label?: string
  /** 바탕색 링(아바타 위). 'background' | 'card' | 'none'(기본) */
  ring?: 'background' | 'card' | 'none'
}

const SHAPE: Record<string, Shape> = {
  online: 'full', ok: 'full', live: 'full', success: 'full',
  away: 'half', slow: 'half', connecting: 'half', busy: 'half',
  dnd: 'minus', down: 'minus', failed: 'minus', error: 'minus',
  offline: 'empty', off: 'empty', scheduled: 'empty', unknown: 'empty',
}

/**
 * 상태 점(role=img).
 * @example <UiStatusDot status="online" ring="card" className="absolute -bottom-0.5 -right-0.5" />
 */
export function UiStatusDot({ status, size = 10, label, ring = 'none', className, style, ...rest }: UiStatusDotProps) {
  const { t } = useI18n()
  const shape: Shape = SHAPE[status] ?? 'empty'
  const text = label ?? (status in SHAPE ? t(`ui.status.${status}`) : status)
  const px = `${size}px`
  const ringClass = ring === 'background' ? 'ring-2 ring-background' : ring === 'card' ? 'ring-2 ring-card' : ''
  return (
    <span
      {...rest}
      role="img"
      aria-label={text}
      title={text}
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-full',
        ringClass,
        shape === 'full' ? 'bg-success' : '',
        shape === 'half' ? 'shadow-[inset_0_0_0_2px_hsl(var(--warning))] [background:linear-gradient(90deg,hsl(var(--warning))_50%,transparent_50%)]' : '',
        shape === 'minus' ? 'bg-danger' : '',
        shape === 'empty' ? 'shadow-[inset_0_0_0_2px_hsl(var(--muted-foreground))]' : '',
        className,
      )}
      style={{ width: px, height: px, ...style }}
    >
      {shape === 'minus' && <span className="block h-[2px] w-[60%] bg-background" />}
    </span>
  )
}

export default UiStatusDot
