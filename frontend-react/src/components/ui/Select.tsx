/**
 * 선택(시안 F·8-2-1): 데스크톱은 커스텀(40, 셰브런, 목록 = 드롭다운 규격 rounded-lg shadow-md bg-popover 224)
 * 모바일(터치)은 네이티브 <select> 를 그대로 — OS 피커가 더 낫다. 둘 다 같은 겉모습.
 * 옵션 swatch(CSS 색) = 이름 앞 색 견본 10(rounded 3) — 캘린더·라벨 고르기. 네이티브는 고른 값의 견본만 칸 왼쪽에 겹쳐 그린다.
 * search = 목록 위에 찾기 칸(UiInput icon search) — 긴 목록(시간대 등). 데스크톱 목록에만(모바일 OS 피커엔 없음).
 *   열면 찾기 칸에 포커스, ↑↓ Enter Esc 는 칸에서 그대로. match 를 안 주면 라벨 부분 일치(대소문자 무시).
 *
 * className 은 바깥 묶음에, 나머지 속성은 네이티브 <select>(모바일) 또는 콤보박스 <button>(데스크톱)에 붙는다.
 * ref 도 그 요소(select 또는 button).
 */
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { toCssRect, viewportCss } from '~/composables/useViewport'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import { useClickOutside } from '~/lib/dom'
import { UiIcon } from './Icon'
import { UiInput } from './Input'
import { useModel, useUid } from './internal'

export interface SelectOption {
  value: string | number
  label: string
  disabled?: boolean
  /** 오른쪽 보조 글(데스크톱 목록) */
  hint?: string
  /** 색 견본(CSS 색 값, 예: hsl(var(--cat-1)) · #4f8cff) */
  swatch?: string
}

export interface UiSelectSearch {
  /** 찾기 칸 자리표시 */
  placeholder?: string
  /** 옵션이 검색어에 맞나(빈 검색어는 부르지 않는다). 기본 = 라벨 부분 일치 */
  match?: (option: SelectOption, query: string) => boolean
}

export interface UiSelectProps extends Omit<HTMLAttributes<HTMLElement>, 'id' | 'onChange' | 'placeholder'> {
  /** 고른 값(Vue v-model). null = 고르지 않음 */
  modelValue?: string | number | null
  /** 값 바뀜 */
  onUpdateModelValue?: (v: string | number | null) => void
  /** 옵션 목록(필수) */
  options: SelectOption[]
  /** 칸 id(라벨 for). 없으면 자동 */
  id?: string
  /** 위 라벨 */
  label?: string
  /** 아래 도움말 */
  hint?: string
  /** 오류 문구 */
  error?: string
  /** 아무것도 안 골랐을 때 문구. 기본 '선택'(ui.select.placeholder), "" 이면 끔 */
  placeholder?: string
  /** sm 32 · md 40(기본) · lg 44 */
  size?: 'md' | 'lg' | 'sm'
  disabled?: boolean
  /** 필수 — 라벨 뒤 * */
  required?: boolean
  /** 네이티브 강제(폼 안 간단한 경우) */
  native?: boolean
  /** 목록 위 찾기 칸(데스크톱). true 면 기본값으로 */
  search?: boolean | UiSelectSearch
  /** 네이티브 <select> 또는 콤보박스 <button> */
  ref?: Ref<HTMLElement>
}

/**
 * 선택 상자.
 * @example <UiSelect label="캘린더" options={cals.map(c => ({ value: c.id, label: c.name, swatch: c.color }))} modelValue={calId} onUpdateModelValue={setCalId} />
 */
export function UiSelect({
  modelValue, onUpdateModelValue, options, id, label, hint, error, placeholder, size = 'md', disabled = false,
  required = false, native = false, search, ref, className, onClick, onKeyDown, ...rest
}: UiSelectProps) {
  const { t } = useI18n()
  const [model, setModel] = useModel<string | number | null>(modelValue, null, onUpdateModelValue)
  /** 기본 자리표시('선택') — placeholder="" 로 끌 수 있다 */
  const ph = placeholder ?? t('ui.select.placeholder')

  const isMobile = useIsMobile()
  const useNative = native || isMobile

  const uid = useUid('ui-select')
  const inputId = id ?? uid
  const describedBy = (error || hint) ? `${inputId}-desc` : undefined

  const selected = options.find(o => o.value === model)

  // ── 커스텀 리스트박스 ──
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  // 목록은 body 로 포털해 fixed 로 띄운다 — 모달·카드의 overflow 에 갇혀 잘리지 않게(UiMenu 와 같은 방식)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number } | null>(null)
  function place() {
    const btn = rootRef.current?.querySelector('button')
    const panel = panelRef.current
    if (!btn || !panel) return
    const r = toCssRect(btn.getBoundingClientRect())
    const { vw, vh } = viewportCss()
    const width = Math.min(Math.max(r.width, 224), vw - 16)
    const left = Math.max(8, Math.min(r.left, vw - width - 8))
    const h = panel.offsetHeight
    const spaceBelow = vh - r.bottom - 12, spaceAbove = r.top - 12
    const up = h > spaceBelow && spaceAbove > spaceBelow
    const maxH = Math.max(120, Math.min(up ? spaceAbove : spaceBelow, 320))
    const top = up ? Math.max(8, r.top - 4 - Math.min(h, maxH)) : r.bottom + 4
    setPos({ left, top, width, maxH })
  }

  const searchOpt: UiSelectSearch | null = search ? (search === true ? {} : search) : null
  const q = query.trim()
  const shown = searchOpt && q
    ? options.filter(o => (searchOpt.match ? searchOpt.match(o, q) : o.label.toLowerCase().includes(q.toLowerCase())))
    : options

  function toggle() {
    if (disabled) return
    const next = !open
    setOpen(next)
    setQuery('')
    if (next) setActive(Math.max(0, options.findIndex(o => o.value === model)))
  }
  // 열리면 찾기 칸(있으면) 또는 목록으로 포커스(Vue nextTick)
  useEffect(() => { if (open) (searchRef.current ?? listRef.current)?.focus() }, [open])
  // 고른 칸이 보이게
  useEffect(() => {
    if (!open || active < 0) return
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  /**
   * 목록을 닫고 콤보박스 버튼으로 포커스를 돌려준다. 목록은 body 포털이라 닫히면 포커스가 body 로 빠진다 —
   * 그러면 모달 안에서 Esc(모달 닫기)·Tab(모달 안 돌기)이 더 먹지 않았다.
   */
  function closeList(returnFocus = true) {
    setOpen(false)
    if (returnFocus) rootRef.current?.querySelector<HTMLElement>('button[role="combobox"]')?.focus()
  }
  function choose(o: SelectOption) {
    if (o.disabled) return
    setModel(o.value)
    closeList()
  }
  function onKey(e: KeyboardEvent<HTMLElement>, fromSearch = false) {
    // 멈추지 않으면 React 이벤트가 포털을 건너 바깥 모달까지 올라가, 목록만 닫으려던 Esc 에 모달째 닫힌다(저장 전 변경 소실)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeList(); return }
    // Tab: 버튼으로 돌아간 뒤 브라우저가 거기서 다음(이전) 칸으로 옮긴다 — 목록에서 그대로 두면 포커스가 body 로 빠진다
    if (e.key === 'Tab') { closeList(); return }
    const n = shown.length
    if (!n) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % n) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + n) % n) }
    // 찾기 칸에선 스페이스가 글자
    else if (e.key === 'Enter' || (e.key === ' ' && !fromSearch)) { e.preventDefault(); const o = shown[active]; if (o) choose(o) }
  }
  function onQuery(v: string) {
    setQuery(v)
    setActive(0)
  }
  useClickOutside(rootRef, (e) => { if (panelRef.current?.contains(e.target as Node)) return; setOpen(false) })
  useLayoutEffect(() => { if (open) place(); else setPos(null) }, [open])
  // 찾기로 목록 길이가 바뀌면 자리를 다시 잡는다 — 위로 열린 목록은 줄어든 만큼 버튼에서 떨어졌다
  const shownCount = shown.length
  useLayoutEffect(() => { if (open) place() }, [shownCount]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    const on = () => place()
    window.addEventListener('resize', on)
    window.addEventListener('scroll', on, true)
    return () => { window.removeEventListener('resize', on); window.removeEventListener('scroll', on, true) }
  }, [open])

  const boxClass = cn(
    'flex w-full min-w-0 items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-sm text-foreground outline-hidden transition-[box-shadow,border-color]',
    size === 'lg' ? 'h-11' : size === 'sm' ? 'h-8 text-xs' : 'h-10',
    error ? 'border-danger focus:ring-2 focus:ring-danger/35' : 'border-input focus:border-ring focus:ring-2 focus:ring-ring/35',
    disabled ? 'cursor-not-allowed bg-muted/50 text-muted-foreground opacity-70' : '',
  )

  return (
    <div ref={rootRef} className={cn('flex flex-col gap-1.5', className ?? '')}>
      {label && (
        <label htmlFor={inputId} className={cn('text-xs font-semibold', error ? 'text-danger' : 'text-muted-foreground')}>
          {label}{required && <span aria-hidden="true" className="ml-0.5 text-danger">*</span>}
        </label>
      )}

      {useNative
        ? (
          /* 모바일: 네이티브 select (겉모습만 맞춤) */
          <div className="relative">
            <select
              {...(rest as HTMLAttributes<HTMLSelectElement>)}
              onClick={onClick}
              onKeyDown={onKeyDown}
              ref={ref as Ref<HTMLSelectElement>}
              id={inputId}
              value={model === null ? '' : String(model)}
              onChange={(e) => {
                // Vue v-model 은 옵션의 원래 값(숫자면 숫자)을 돌려준다
                const o = options.find(x => String(x.value) === e.target.value)
                setModel(o ? o.value : e.target.value)
              }}
              disabled={disabled}
              required={required}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={describedBy}
              className={cn(boxClass, 'appearance-none pr-9', selected?.swatch ? 'pl-8' : '')}
            >
              {ph && (model === null || model === '') && <option value="" disabled>{ph}</option>}
              {options.map(o => <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>{o.label}</option>)}
            </select>
            {selected?.swatch && <span className="pointer-events-none absolute left-3 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-[3px]" style={{ background: selected.swatch }} aria-hidden="true" />}
            <UiIcon name="chevron-down" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" strokeWidth={2.4} />
          </div>
        )
        : (
          /* 데스크톱: 커스텀 리스트박스 */
          <div className="relative">
            <button
              {...(rest as HTMLAttributes<HTMLButtonElement>)}
              ref={ref as Ref<HTMLButtonElement>}
              id={inputId}
              type="button"
              role="combobox"
              aria-expanded={open}
              aria-controls={`${inputId}-list`}
              aria-haspopup="listbox"
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={describedBy}
              disabled={disabled}
              className={boxClass}
              onClick={(e) => { onClick?.(e); toggle() }}
              onKeyDown={(e) => {
                onKeyDown?.(e)
                if (e.key === 'ArrowDown') { e.preventDefault(); toggle() }
                // 마우스로 열면 포커스가 이 버튼에 남는다 — 여기서도 Esc 로 목록만 닫는다(바깥 모달·팝오버까지 닫지 않게 멈춘다)
                else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false) }
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                {selected?.swatch && <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: selected.swatch }} aria-hidden="true" />}
                <span className={cn('truncate', selected ? '' : 'text-muted-foreground')}>{selected?.label ?? ph}</span>
              </span>
              <UiIcon name="chevron-down" className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open ? 'rotate-180' : '')} strokeWidth={2.4} />
            </button>
            {open && searchOpt && createPortal(
              <div ref={panelRef} className="fixed z-overlay flex flex-col rounded-lg border border-border bg-popover shadow-md" style={panelStyle()}>
                <div className="border-b border-border p-1.5">
                  <UiInput
                    ref={searchRef}
                    icon="search"
                    modelValue={query}
                    onUpdateModelValue={onQuery}
                    placeholder={searchOpt.placeholder ?? t('common.search')}
                    aria-label={searchOpt.placeholder ?? t('common.search')}
                    role="searchbox"
                    aria-controls={`${inputId}-list`}
                    onKeyDown={e => onKey(e, true)}
                  />
                </div>
                {renderList('max-h-64 p-1')}
              </div>,
              document.body,
            )}
            {open && !searchOpt && createPortal(
              <div ref={panelRef} className="fixed z-overlay flex flex-col rounded-lg border border-border bg-popover p-1 shadow-md" style={panelStyle()}>
                {renderList('min-h-0 flex-1')}
              </div>,
              document.body,
            )}
          </div>
        )}

      {error
        ? (
          <p id={describedBy} className="flex items-center gap-1.5 text-xs font-medium text-danger">
            <UiIcon name="alert-circle" className="h-[13px] w-[13px]" strokeWidth={2.2} />{error}
          </p>
        )
        : hint ? <p id={describedBy} className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )

  function panelStyle() {
    return pos
      ? { left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px`, maxHeight: `${pos.maxH}px` }
      : { left: 0, top: 0, visibility: 'hidden' as const }
  }

  function renderList(cls: string) {
    return (
              <ul
                id={`${inputId}-list`}
                ref={listRef}
                role="listbox"
                tabIndex={-1}
                className={cn('overflow-y-auto outline-hidden', cls)}
                onKeyDown={e => onKey(e)}
              >
                {!shown.length && <li role="presentation" className="px-2.5 py-2 text-sm text-muted-foreground">{t('ui.select.noMatch')}</li>}
                {shown.map((o, i) => (
                  <li
                    key={String(o.value)}
                    role="option"
                    aria-selected={o.value === model}
                    aria-disabled={o.disabled}
                    className={cn(
                      'flex h-9 cursor-pointer items-center gap-2 rounded-sm px-2.5 text-sm',
                      o.value === model ? 'bg-primary/[0.13] font-semibold' : '',
                      i === active && o.value !== model ? 'bg-accent/40' : '',
                      o.disabled ? 'cursor-not-allowed opacity-50' : '',
                    )}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(o)}
                  >
                    {o.swatch && <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: o.swatch }} aria-hidden="true" />}
                    <span className="flex-1 truncate">{o.label}</span>
                    {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
                    {o.value === model && <UiIcon name="check" className="h-3.5 w-3.5 text-primary" strokeWidth={3} />}
                  </li>
                ))}
              </ul>
    )
  }
}

export default UiSelect
