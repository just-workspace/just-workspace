/**
 * 분할 버튼 — 본 동작 버튼 + 붙은 ▾ 메뉴 버튼. 모양은 UiButton 두 개를 한 덩어리로 붙인 것.
 * 메뉴는 UiMenu(모바일은 바닥 시트). ▾ 버튼은 따로 포커스되고 aria-haspopup=menu.
 */
import type { ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { UiButton, type UiButtonProps } from './Button'
import { UiIcon } from './Icon'
import { UiMenu, type UiMenuItem } from './Menu'

export interface UiSplitButtonProps {
  /** 본 동작 글자 */
  children?: ReactNode
  /** 본 동작 아이콘(UiIcon 이름) */
  icon?: string
  /** UiButton variant — default(primary 채움) · outline · secondary · ghost */
  variant?: 'default' | 'outline' | 'secondary' | 'ghost'
  /** UiButton size — xs 32 · sm 36 · default 40 · lg 44 */
  size?: 'xs' | 'sm' | 'default' | 'lg'
  /** 본 동작 */
  onClick?: () => void
  /** ▾ 메뉴 항목 */
  items: UiMenuItem[]
  /** 메뉴 항목 고름 */
  onSelect?: (key: string) => void
  /** ▾ 버튼·메뉴 접근성 이름(기본 "다른 방법") */
  menuLabel?: string
  /** 메뉴 위쪽 소제목 등 자유 내용(UiMenu content) */
  menuContent?: ReactNode
  /** 메뉴 폭 px(기본 256) */
  menuWidth?: number
  disabled?: boolean
  /** 본 동작만 끄기 */
  mainDisabled?: boolean
  /** 본 동작 title(툴팁) */
  title?: string
  /** 바깥 상자 class(폭 등 — 본 버튼이 남는 폭을 채운다) */
  className?: string
  /** 본 버튼에 넘길 나머지(data-testid 등) */
  mainProps?: Partial<UiButtonProps>
}

/**
 * @example
 * <UiSplitButton icon="terminal" size="sm" onClick={open} items={[{ key: 'putty', label: 'PuTTY' }]} onSelect={pick}>
 *   콘솔 열기 · Windows Terminal
 * </UiSplitButton>
 */
export function UiSplitButton({
  children, icon, variant = 'default', size = 'sm', onClick, items, onSelect, menuLabel = '다른 방법', menuContent, menuWidth = 256,
  disabled, mainDisabled, title, className, mainProps,
}: UiSplitButtonProps) {
  const filled = variant === 'default'
  return (
    <div className={cn('inline-flex items-stretch', className)} role="group">
      <UiButton
        {...mainProps}
        type="button"
        variant={variant}
        size={size}
        icon={icon}
        title={title}
        disabled={disabled || mainDisabled}
        className={cn('min-w-0 flex-1 rounded-r-none active:scale-100', mainProps?.className)}
        onClick={onClick}
      >
        {children}
      </UiButton>
      <UiMenu
        items={items}
        label={menuLabel}
        width={menuWidth}
        content={menuContent}
        onSelect={onSelect}
        trigger={({ toggle, open, controls }) => (
          <UiButton
            type="button"
            variant={variant}
            size={size}
            disabled={disabled}
            aria-label={menuLabel}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={controls}
            className={cn(
              'rounded-l-none px-2 active:scale-100',
              filled ? 'border-l border-primary-foreground/20' : variant === 'outline' ? 'border-l-0' : 'border-l border-border',
              open && !filled && 'bg-accent',
            )}
            onClick={toggle}
          >
            <UiIcon name="chevron-down" className="h-4 w-4" />
          </UiButton>
        )}
      />
    </div>
  )
}

export default UiSplitButton
