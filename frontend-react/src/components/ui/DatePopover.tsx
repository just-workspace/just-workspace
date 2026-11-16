/**
 * 날짜 선택 팝오버: 7열 미니 달력.
 * 머리 = 달 이름 13/600 + ‹ › 28(히트 40). 요일 24 muted. 날짜 칸 32 · mono 12.
 *   선택한 날 = bg-primary · primary-foreground(600) · 오늘 = 1px ring(primary, inset) · 다른 달 = muted-foreground/60 · 범위 밖 = 40% 비활성.
 * 값은 'YYYY-MM-DD' 문자열(검색 before/after/during 과 동일 형식). 날짜 계산은 브라우저 지역 날짜 기준이다(하루 경계는 서버가 결정한다).
 *
 * UiMiniCalendar — 달력 본체(인라인). 모바일 시트 내부 등에 그대로 배치한다.
 * UiDatePopover  — anchor 아래(공간 부족 시 위)에 body 포털 + fixed 로 표시한다(UiMenu·UiSelect 와 동일 방식, z-overlay, shadow-md).
 *   열리면 선택한 날(없으면 오늘)에 포커스, Esc = 닫고 anchor 로 포커스 복귀, 바깥 클릭 = 닫기, 날짜 선택 시 onPick 후 닫힘(closeOnPick).
 * 키보드(role=grid): ←→ 하루 · ↑↓ 일주일 · Home/End 주 처음/끝 · PageUp/PageDown 한 달(Shift = 한 해) · Enter/Space 선택.
 *
 * 참고: 캘린더 모듈의 CalendarMiniMonth 는 캘린더 스토어(주 시작·주 보기 강조·캘린더 시간대)에 결합되어 있고
 *   "오늘 = 채운 primary · 고른 날 = primary/13" 이라 본 시안(선택한 날 primary · 오늘 ring)과 반대이므로, 동일한 격자 형태로 신규 구현하였다.
 *
 * @example
 * const [open, setOpen] = useState(false); const btn = useRef<HTMLButtonElement>(null)
 * <button ref={btn} onClick={() => setOpen(o => !o)}>before:</button>
 * <UiDatePopover open={open} anchor={btn.current} value={before} onPick={d => setBefore(d)} onClose={() => setOpen(false)} />
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { toCssRect, viewportCss } from '~/composables/useViewport'
import { UiIcon } from './Icon'

// ── 날짜 문자열 도우미(지역 날짜, 시간 0시) ──
function pad(n: number) { return n < 10 ? `0${n}` : String(n) }
/** Date → 'YYYY-MM-DD'(지역) */
export function toYmd(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
/** 'YYYY-MM-DD' → Date(지역 0시). 형식 불일치 시 null */
export function fromYmd(s: string | null | undefined): Date | null {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}
function addDays(d: Date, n: number) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n) }
function addMonths(d: Date, n: number) {
  // 31일에서 월 이동 시 해당 월 말일로 보정(다다음 달로 넘어가는 것 방지)
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate()
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last))
}

export interface UiMiniCalendarProps {
  /** 선택한 날 'YYYY-MM-DD' | null */
  value?: string | null
  /** 날짜 선택 시 호출 */
  onPick: (ymd: string) => void
  /** 선택 가능한 시작·종료 날('YYYY-MM-DD', 포함) */
  min?: string
  max?: string
  /** 주 시작 요일(0 = 일, 1 = 월 · 기본 0) */
  weekStart?: 0 | 1
  /** 오늘(테스트·서버 기준일). 기본 = 브라우저 오늘 */
  today?: string
  /** 최초 표시 월(기본 = 선택한 날 또는 오늘) */
  initialMonth?: string
  /** 열릴 때 포커스(팝오버가 활성화) */
  autoFocus?: boolean
  /** 달력 접근성 이름(기본 = 달 이름) */
  ariaLabel?: string
  className?: string
}

/**
 * 7열 미니 달력(인라인).
 */
export function UiMiniCalendar({ value, onPick, min, max, weekStart = 0, today, initialMonth, autoFocus = false, ariaLabel, className }: UiMiniCalendarProps) {
  const { t, tm, rt } = useI18n()
  const todayYmd = today ?? toYmd(new Date())
  const start = fromYmd(initialMonth) ?? fromYmd(value) ?? fromYmd(todayYmd) ?? new Date()
  const [focusDate, setFocusDate] = useState<Date>(start)
  const [view, setView] = useState<{ y: number; m: number }>({ y: start.getFullYear(), m: start.getMonth() })
  const gridRef = useRef<HTMLDivElement | null>(null)
  const wantFocus = useRef(autoFocus)

  // 값이 외부에서 변경되면 해당 월로 이동
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    const d = fromYmd(value)
    if (d) { setFocusDate(d); setView({ y: d.getFullYear(), m: d.getMonth() }) }
  }

  const wd = tm<unknown>('calendar.weekdaysShort')
  const raw = Array.isArray(wd) && wd.length === 7 ? wd.map(x => rt(x)) : ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  const dayLabels = [...raw.slice(weekStart), ...raw.slice(0, weekStart)]
  const monthLabel = t('calendar.monthLabel', { y: view.y, m: view.m + 1 })

  const weeks = useMemo(() => {
    const first = new Date(view.y, view.m, 1)
    const lead = (first.getDay() - weekStart + 7) % 7
    const s = addDays(first, -lead)
    const out: Date[][] = []
    for (let w = 0; w < 6; w++) {
      const row = Array.from({ length: 7 }, (_, i) => addDays(s, w * 7 + i))
      // 6주째가 전부 다음 달이면 생략
      if (w >= 4 && row[0].getMonth() !== view.m) break
      out.push(row)
    }
    return out
  }, [view, weekStart])

  const focusYmd = toYmd(focusDate)
  const inRange = (ymd: string) => (!min || ymd >= min) && (!max || ymd <= max)

  useEffect(() => {
    if (!wantFocus.current) return
    wantFocus.current = false
    gridRef.current?.querySelector<HTMLElement>(`[data-ymd="${focusYmd}"]`)?.focus()
  }, [focusYmd, view])

  function moveFocus(d: Date) {
    wantFocus.current = true
    setFocusDate(d)
    if (d.getFullYear() !== view.y || d.getMonth() !== view.m) setView({ y: d.getFullYear(), m: d.getMonth() })
  }
  function shiftMonth(n: number) {
    const d = addMonths(new Date(view.y, view.m, Math.min(focusDate.getDate(), 28)), n)
    setView({ y: d.getFullYear(), m: d.getMonth() })
    setFocusDate(new Date(d.getFullYear(), d.getMonth(), Math.min(focusDate.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())))
  }

  function onKey(e: KeyboardEvent<HTMLButtonElement>, d: Date) {
    const dow = (d.getDay() - weekStart + 7) % 7
    let next: Date
    switch (e.key) {
      case 'ArrowRight': next = addDays(d, 1); break
      case 'ArrowLeft': next = addDays(d, -1); break
      case 'ArrowDown': next = addDays(d, 7); break
      case 'ArrowUp': next = addDays(d, -7); break
      case 'Home': next = addDays(d, -dow); break
      case 'End': next = addDays(d, 6 - dow); break
      case 'PageUp': next = addMonths(d, e.shiftKey ? -12 : -1); break
      case 'PageDown': next = addMonths(d, e.shiftKey ? 12 : 1); break
      default: return
    }
    e.preventDefault()
    moveFocus(next)
  }

  const navBtn = "relative grid h-7 w-7 place-items-center rounded-sm text-muted-foreground hover:bg-overlay-hover hover:text-foreground after:absolute after:-inset-1.5 after:content-[''] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"

  return (
    <div className={cn('w-[248px] select-none', className)}>
      <div className="flex items-center justify-between px-1 pb-1.5 text-[13px] font-semibold text-foreground">
        <span aria-live="polite">{monthLabel}</span>
        <span className="flex gap-0.5">
          <button type="button" className={navBtn} aria-label={t('calendar.nav.prevMonth')} onClick={() => shiftMonth(-1)}><UiIcon name="chevron-left" className="h-4 w-4" /></button>
          <button type="button" className={navBtn} aria-label={t('calendar.nav.nextMonth')} onClick={() => shiftMonth(1)}><UiIcon name="chevron-right" className="h-4 w-4" /></button>
        </span>
      </div>
      <div ref={gridRef} role="grid" aria-label={ariaLabel ?? monthLabel} className="flex flex-col gap-0.5 text-center">
        <div role="row" className="grid grid-cols-7">
          {dayLabels.map((label, i) => (
            <span key={i} role="columnheader" className="h-6 text-[11px] leading-6 text-muted-foreground">{label}</span>
          ))}
        </div>
        {weeks.map((row, w) => (
          <div key={w} role="row" className="grid grid-cols-7 gap-0.5">
            {row.map(d => {
              const ymd = toYmd(d)
              const sel = ymd === value
              const isToday = ymd === todayYmd
              const inMonth = d.getMonth() === view.m
              const ok = inRange(ymd)
              return (
                <button
                  key={ymd}
                  type="button"
                  role="gridcell"
                  data-ymd={ymd}
                  aria-selected={sel}
                  aria-current={isToday ? 'date' : undefined}
                  aria-label={`${d.getMonth() + 1}/${d.getDate()}${isToday ? ` ${t('common.today')}` : ''}`}
                  aria-disabled={!ok || undefined}
                  tabIndex={ymd === focusYmd ? 0 : -1}
                  className={cn(
                    'grid h-8 place-items-center rounded-md font-mono text-[12px] transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                    sel ? 'bg-primary font-semibold text-primary-foreground'
                      : inMonth ? 'text-foreground hover:bg-overlay-hover' : 'text-muted-foreground/60 hover:bg-overlay-hover',
                    isToday && !sel ? 'ring-1 ring-inset ring-primary' : '',
                    ok ? '' : 'cursor-not-allowed opacity-40 hover:bg-transparent',
                  )}
                  onClick={() => { if (ok) { setFocusDate(d); onPick(ymd) } }}
                  onKeyDown={e => onKey(e, d)}
                >{d.getDate()}</button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

export interface UiDatePopoverProps extends Omit<UiMiniCalendarProps, 'autoFocus' | 'className'> {
  /** 열림 */
  open: boolean
  /** 닫기(Esc · 바깥 클릭 · 선택 후) */
  onClose: () => void
  /** 기준 요소(아래 → 공간 부족 시 위) */
  anchor: HTMLElement | null
  /** 아래(기본) / 위 */
  placement?: 'bottom' | 'top'
  /** 선택 시 닫기(기본 활성화) */
  closeOnPick?: boolean
  /** 팝오버 className */
  className?: string
}

/**
 * anchor 에 부착되는 날짜 선택 팝오버.
 */
export function UiDatePopover({ open, onClose, anchor, placement = 'bottom', closeOnPick = true, onPick, className, ariaLabel, ...cal }: UiDatePopoverProps) {
  const { t } = useI18n()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    if (!open || !anchor) { setPos(null); return }
    const place = () => {
      const panel = panelRef.current
      if (!panel) return
      const r = toCssRect(anchor.getBoundingClientRect())
      const { vw, vh } = viewportCss()
      const w = panel.offsetWidth, h = panel.offsetHeight
      const below = r.bottom + 4, above = r.top - 4 - h
      let top = placement === 'bottom' ? below : above
      if (placement === 'bottom' && below + h > vh - 8 && above >= 8) top = above
      if (placement === 'top' && above < 8 && below + h <= vh - 8) top = below
      setPos({ left: Math.max(8, Math.min(r.left, vw - w - 8)), top: Math.max(8, top) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, anchor, placement])

  // 바깥 클릭 = 닫기(anchor 는 제외 — anchor 의 토글이 별도로 닫기 처리)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const tgt = e.target as Node
      if (panelRef.current?.contains(tgt) || anchor?.contains(tgt)) return
      closeRef.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open, anchor])

  if (!open) return null

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      closeRef.current()
      anchor?.focus()
    }
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel ?? t('ui.kit22.pickDate')}
      className={cn('fixed z-overlay rounded-lg border border-border bg-popover p-3 text-foreground shadow-md', className)}
      style={{ left: `${pos?.left ?? 0}px`, top: `${pos?.top ?? 0}px`, opacity: pos || !anchor ? 1 : 0 }}
      onKeyDown={onKeyDown}
    >
      <UiMiniCalendar
        {...cal}
        autoFocus
        onPick={ymd => { onPick(ymd); if (closeOnPick) { closeRef.current(); anchor?.focus() } }}
      />
    </div>,
    document.body,
  )
}

export default UiDatePopover
