/**
 * 탭: 밑줄형 40(상세 패널은 안쪽 36), 선택 = 글자 600 + 2px primary 밑줄, 카운트 mono,
 * ←→ 이동, 모바일은 가로 스크롤 + 선택 탭이 보이도록 자동 스크롤. 포커스는 inset ring.
 * 항목에 to 가 있으면 라우터 링크(설정·관리 탭), 없으면 modelValue/onUpdateModelValue로 전환.
 * to 탭의 선택 판정: 기본은 경로 접두 일치(/a 는 /a/b 에서도 선택). exact(컴포넌트 전체 또는 항목별)이면 경로가 동일할 때만 선택.
 * 정확 일치 탭이 일부 하위 경로에서도 선택되어야 하면 activeOn 에 해당 접두 경로를 지정한다(Git 코드 탭 = 루트 + /tree·/blob).
 * to 의 ?쿼리·#해시는 판정에서 제외한다(이동 시에는 그대로 포함된다).
 * 라우터 내부에서만 사용한다(useRoute).
 */
import { useEffect, useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { navigateTo, useRoute } from '~/lib/router'
import { UiIcon } from './Icon'
import { useModel } from './internal'

export interface TabItem {
  key: string
  label: string
  /** 오른쪽 mono 카운트 */
  count?: number | string
  disabled?: boolean
  /** 라우터 탭: 이동할 경로 */
  to?: string
  /** 앞 아이콘 */
  icon?: string
  /** to 탭: 경로가 동일할 때만 선택(컴포넌트 exact 보다 우선) */
  exact?: boolean
  /** to 탭: 지정한 접두 경로로 시작하는 경로에서도 선택 */
  activeOn?: string[]
}

export interface UiTabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  /** 선택된 탭 key(to 없는 탭) */
  modelValue?: string | null
  /** 탭 변경 */
  onUpdateModelValue?: (v: string | null) => void
  /** 탭 목록(필수) */
  items: TabItem[]
  /** md 40(기본) · sm 36(패널 안) */
  size?: 'md' | 'sm'
  /** 탭 목록 접근성 이름 */
  ariaLabel?: string
  /** 양끝 패딩 없이(카드 안에서 flush) */
  flush?: boolean
  /** to 탭 전체를 정확 일치로 판정 */
  exact?: boolean
  /** 탭 줄 오른쪽 끝 내용 */
  trailing?: ReactNode
}

/**
 * 밑줄 탭.
 * @example <UiTabs items={[{ key: 'all', label: '전체', count: 12 }, { key: 'mine', label: '내 것' }]} modelValue={tab} onUpdateModelValue={setTab} />
 */
export function UiTabs({ modelValue, onUpdateModelValue, items, size = 'md', ariaLabel, flush = false, exact = false, trailing, className, ...rest }: UiTabsProps) {
  const [model, setModel] = useModel<string | null>(modelValue, null, onUpdateModelValue)
  const route = useRoute()
  const listRef = useRef<HTMLDivElement | null>(null)

  function isActive(it: TabItem) {
    if (it.to) {
      const to = it.to.split(/[?#]/)[0]
      const p = route.path
      if (p === to) return true
      if (it.activeOn?.some(pre => p === pre || p.startsWith(pre + '/'))) return true
      return !(it.exact ?? exact) && p.startsWith(to + '/')
    }
    return model === it.key
  }
  function activate(it: TabItem) {
    if (it.disabled) return
    if (it.to) void navigateTo(it.to)
    else setModel(it.key)
  }
  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const n = items.length
    let j = i
    if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = n - 1
    else for (let k = 0; k < n; k++) { j = e.key === 'ArrowRight' ? (j + 1) % n : (j - 1 + n) % n; if (!items[j].disabled) break }
    activate(items[j])
    listRef.current?.querySelectorAll<HTMLElement>('[role=tab]')[j]?.focus()
  }

  // 선택 탭이 보이도록 자동 스크롤(모바일 가로 스크롤) — 최초 및 선택 탭 변경 시
  const activeKey = items.find(isActive)?.key
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeKey])

  return (
    <div
      {...rest}
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex shrink-0 gap-1 overflow-x-auto border-b border-border text-[13px] scrollbar-none', size === 'sm' ? 'h-9 px-2' : 'h-10', flush ? 'px-0' : '', className)}
    >
      {items.map((it, i) => {
        const on = isActive(it)
        return (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={on}
            aria-disabled={it.disabled || undefined}
            disabled={it.disabled}
            tabIndex={on ? 0 : -1}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 transition-colors focus-visible:outline-hidden focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))] focus-visible:rounded-t-[6px]',
              size === 'sm' ? 'px-2' : '',
              on ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              it.disabled ? 'opacity-50' : '',
            )}
            onClick={() => activate(it)}
            onKeyDown={e => onKey(e, i)}
          >
            {it.icon && <UiIcon name={it.icon} className="h-3.5 w-3.5" />}
            {it.label}
            {it.count !== undefined && <span className="font-mono text-[11px] font-medium text-muted-foreground">{it.count}</span>}
          </button>
        )
      })}
      {trailing}
    </div>
  )
}

export default UiTabs
