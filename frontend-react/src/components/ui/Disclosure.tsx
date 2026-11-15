/**
 * 펼침 행 — 머리(버튼)를 누르면 아래 내용이 펼쳐진다. 머리는 실제 <button aria-expanded aria-controls>.
 * - variant="card"(기본): 테두리 있는 독립 상자(접어 둔 선택 항목).
 * - variant="row": 테두리 없는 행 — 카드 안 목록의 한 줄(점검 항목 등). 구분선은 호출처가 준다.
 * 머리 구성: leading(왼쪽 아이콘) · title + description(두 줄) · trailing(배지) · 펼침 화살표.
 * `collapsible={false}` 면 펼칠 것이 없는 행 — 버튼이 아니라 그냥 줄로 그린다(화살표 없음).
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { UiIcon } from './Icon'
import { useModel, useUid } from './internal'

export interface UiDisclosureProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 머리 첫 줄(필수) */
  title: ReactNode
  /** 머리 둘째 줄(12 muted) */
  description?: ReactNode
  /** 펼침 여부(제어형). 안 주면 스스로 가진다 */
  open?: boolean
  /** 처음 펼침 여부(비제어형, 기본 접힘) */
  defaultOpen?: boolean
  /** 펼침 바뀜 */
  onUpdateOpen?: (open: boolean) => void
  /** 왼쪽 자리(상태 아이콘 등) */
  leading?: ReactNode
  /** 화살표 앞 자리(배지 등) */
  trailing?: ReactNode
  /** card(기본) · row */
  variant?: 'card' | 'row'
  /** 펼칠 내용이 있는가(기본 true). false 면 머리만 그린다 */
  collapsible?: boolean
  /** 머리 글자를 굵게(기본: card 는 굵게, row 는 보통) */
  strong?: boolean
  /** 펼쳤을 때 내용 */
  children?: ReactNode
}

/**
 * 펼침 행.
 * @example <UiDisclosure title="저장 폴더 지정" description="기본 폴더를 씁니다"><UiInput label="저장 폴더" /></UiDisclosure>
 */
export function UiDisclosure({ title, description, open, defaultOpen = false, onUpdateOpen, leading, trailing, variant = 'card', collapsible = true, strong, className, children, ...rest }: UiDisclosureProps) {
  const [isOpen, setOpen] = useModel(open, defaultOpen, onUpdateOpen)
  const id = useUid('ui-disc')
  const bold = strong ?? variant === 'card'
  const head = (
    <>
      {leading != null && <span className="flex shrink-0">{leading}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('text-[13.5px] leading-5', bold ? 'font-semibold' : '')}>{title}</span>
        {description != null && description !== '' && <span className="break-words text-xs leading-4 text-muted-foreground">{description}</span>}
      </span>
      {trailing != null && <span className="flex shrink-0 items-center">{trailing}</span>}
    </>
  )
  const headClass = cn('flex w-full items-center gap-3 px-4 text-left', variant === 'card' ? 'min-h-14 py-2' : 'min-h-12 py-1.5')
  const shown = collapsible && isOpen
  return (
    <div {...rest} data-open={shown || undefined} className={cn(variant === 'card' ? 'rounded-xl border border-border bg-card' : '', className ?? '')}>
      {collapsible
        ? (
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={id}
              onClick={() => setOpen(!isOpen)}
              className={cn(headClass, 'rounded-[inherit] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring')}
            >
              {head}
              <span className="flex shrink-0 text-muted-foreground">
                <UiIcon name={isOpen ? 'chevron-up' : 'chevron-down'} aria-hidden="true" className="size-4" />
              </span>
            </button>
          )
        : <div className={headClass}>{head}</div>}
      {collapsible && <div id={id} hidden={!isOpen}>{isOpen ? children : null}</div>}
    </div>
  )
}

export default UiDisclosure
