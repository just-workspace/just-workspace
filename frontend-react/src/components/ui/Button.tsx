/**
 * 기본 버튼(shadcn 계열). 변형 variant × 크기 size. `as` 로 다른 태그(예: 'a')로 그린다.
 * 빨강은 danger 하나(시안 J). destructive 는 기존 호출처 호환용 별칭 — 새 코드는 danger.
 * 커맨드 바·필터 바 안 컨트롤은 전부 32 = size="xs"(시안 B·D).
 * type 기본값이 없다(Vue 판과 같음) — 폼 안에서 제출 버튼이 아니면 type="button" 을 줄 것.
 * 아이콘은 `icon`(글자 왼쪽) · `iconRight`(글자 오른쪽, ▾·외부 링크) — 아이콘 16, 글자와 간격 6(handover 18 답 10).
 * 버튼 안에 UiIcon 을 직접 넣지 말 것.
 */
import type { AllHTMLAttributes, ElementType, ReactNode, Ref } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '~/lib/utils'
import { UiIcon } from './Icon'

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs hover:shadow-md',
        // 빨강은 danger 하나(시안 J). destructive 는 기존 호출처 호환용 별칭 — 새 코드는 danger.
        danger: 'bg-danger text-danger-foreground hover:bg-danger/90',
        destructive: 'bg-danger text-danger-foreground hover:bg-danger/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        // 반전색 바탕(토스트 bg-foreground) 위 링크형 행동 — 반대 테마의 강조색(--primary-inverse, 4.5:1 보정)
        'link-inverse': 'font-semibold text-primary-inverse underline-offset-4 hover:underline focus-visible:ring-primary-inverse focus-visible:ring-offset-foreground',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        // 커맨드 바·필터 바 안 컨트롤은 전부 32(시안 B·D)
        xs: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

type ButtonVariants = VariantProps<typeof buttonVariants>

export interface UiButtonProps extends Omit<AllHTMLAttributes<HTMLElement>, 'size' | 'as'> {
  /** default(primary 채움) · danger · destructive(호환 별칭) · outline · secondary · ghost · link · link-inverse(반전색 토스트 위 행동) */
  variant?: NonNullable<ButtonVariants['variant']>
  /** default 40 · sm 36 · xs 32(커맨드·필터 바) · lg 44 · icon 40×40 */
  size?: NonNullable<ButtonVariants['size']>
  /** 그릴 태그(기본 'button'). 링크 모양 버튼은 as="a" href=… */
  as?: string
  /** 글자 왼쪽 아이콘 이름(UiIcon, 16). 예: 'plus' · 'refresh' · 'upload' */
  icon?: string
  /** 글자 오른쪽 아이콘 이름(UiIcon, 16). 예: 'chevron-down' · 'external-link' */
  iconRight?: string
  /** 그려지는 요소 */
  ref?: Ref<HTMLElement>
  children?: ReactNode
}

/**
 * 버튼.
 * @example <UiButton variant="outline" size="xs" type="button" onClick={save}>저장</UiButton>
 * @example <UiButton variant="outline" size="sm" icon="plus" onClick={create}>일정</UiButton>
 */
export function UiButton({ variant = 'default', size = 'default', as = 'button', icon, iconRight, className, children, ...rest }: UiButtonProps) {
  const Comp = as as ElementType
  return (
    <Comp {...rest} className={cn(buttonVariants({ variant, size }), (icon || iconRight) && 'gap-1.5', className ?? '')}>
      {icon && <UiIcon name={icon} data-slot="icon" className="h-4 w-4 shrink-0" />}
      {children}
      {iconRight && <UiIcon name={iconRight} data-slot="icon-right" className="h-4 w-4 shrink-0" />}
    </Comp>
  )
}

export default UiButton
