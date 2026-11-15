/**
 * 툴팁(시안 8-2-5): 반전색 12/500, 400ms 지연, 포커스에도 표시, 문구 = aria-label, 단축키 키캡 병기.
 * 터치 기기(pointer: coarse)에서는 표시하지 않는다(길게 누르기 = 액션 시트 규칙).
 *
 * 래퍼는 상자를 만들지 않는다(display: contents). 그래서 트리거(버튼 등)에 준 위치·레이아웃 클래스
 * (absolute right-2 top-2, grid 칸 배치 등)가 실제 부모 기준으로 그대로 먹는다.
 * 말풍선은 body 로 포털해 트리거 좌표에 fixed 로 띄운다 → overflow 에 잘리지 않고,
 * 화면 위(아래)로 넘치면 반대쪽으로 자동으로 뒤집는다.
 * 래퍼 자체에 className 을 주면(예: "hidden md:inline-flex") contents 대신 그 표시 방식을 쓴다.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { toCssRect, viewportCss } from '~/composables/useViewport'
import { UiKeycap } from './Keycap'
import { transitionClass, useTransition } from './internal'

export interface UiTooltipProps extends HTMLAttributes<HTMLSpanElement> {
  /** 말풍선 문구 */
  text: string
  /** 단축키 키캡 목록. 예: ['Ctrl', 'K'] */
  keys?: string[]
  /** 선호 위치(기본 위). 공간이 없으면 반대쪽으로 뒤집는다 */
  side?: 'top' | 'bottom'
  /** 트리거를 block 래퍼로 감쌀 때(래퍼가 상자를 가져야 하는 경우) */
  block?: boolean
  /** 툴팁 끄기(라벨만 aria 로 남길 때) */
  disabled?: boolean
  /** 트리거(버튼 등) */
  children?: ReactNode
}

const GAP = 6
const EDGE = 4

function isCoarse() {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches
}

/**
 * 키보드로 온 포커스인가(:focus-visible). 마우스로 메뉴·모달을 닫으면 포커스가 트리거로 되돌아오는데,
 * 그때마다 툴팁이 떠서 다른 곳을 누를 때까지 남았다 — 키보드 포커스에만 보인다.
 * :focus-visible 을 모르는 환경(옛 브라우저·jsdom)은 예전처럼 보인다.
 */
function focusVisible(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return true
  // 실제 포커스가 아닌 이벤트(코드가 직접 쏜 focus)는 판정할 수 없다 — 보인다
  if (el.ownerDocument.activeElement !== el) return true
  try { return el.matches(':focus-visible') } catch { return true }
}

/**
 * 툴팁 래퍼.
 * @example <UiTooltip text="검색" keys={['Ctrl', 'K']}><button …/></UiTooltip>
 */
export function UiTooltip({ text, keys = [], side = 'top', block = false, disabled = false, className, children, onMouseEnter, onMouseLeave, onFocus, onBlur, onKeyDown, ...rest }: UiTooltipProps) {
  const wrapperClass = cn(block ? 'block' : 'contents', className)
  const root = useRef<HTMLSpanElement | null>(null)
  const bubble = useRef<HTMLSpanElement | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; placed: 'top' | 'bottom' }>({ left: 0, top: 0, placed: 'top' })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openRef = useRef(false)
  openRef.current = open
  const latest = useRef({ side, disabled })
  latest.current = { side, disabled }

  /** 트리거 사각형: contents 래퍼는 상자가 없으므로 첫 자식 요소 기준 */
  function anchorRect(): DOMRect | null {
    const el = root.current
    if (!el) return null
    // 화면 배율(루트 zoom) 아래 — 화면 좌표를 style 에 넣을 CSS px 로
    const r = el.getBoundingClientRect()
    if (r.width || r.height) return toCssRect(r)
    const child = el.firstElementChild as HTMLElement | null
    return child ? toCssRect(child.getBoundingClientRect()) : null
  }
  function place() {
    const r = anchorRect()
    const b = bubble.current
    if (!r || !b) return
    const bw = b.offsetWidth, bh = b.offsetHeight
    const { vw, vh } = viewportCss()
    let s = latest.current.side
    if (s === 'top' && r.top - GAP - bh < EDGE) s = 'bottom'
    else if (s === 'bottom' && r.bottom + GAP + bh > vh - EDGE && r.top - GAP - bh >= EDGE) s = 'top'
    const top = s === 'top' ? r.top - GAP - bh : r.bottom + GAP
    const center = r.left + r.width / 2
    const left = Math.min(Math.max(center - bw / 2, EDGE), Math.max(EDGE, vw - EDGE - bw))
    setPos({ left, top, placed: s })
  }
  function show(delay = 400) {
    if (latest.current.disabled || isCoarse()) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const r = anchorRect()
      if (!r) return
      // 첫 프레임은 대략 위치(측정 전), 측정 뒤 정확히(아래 layout effect)
      setPos(p => ({ ...p, left: r.left, top: r.top }))
      setOpen(true)
    }, delay)
  }
  function hide() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    setOpen(false)
  }

  // 열린 직후 측정해 정확한 자리로(Vue nextTick → place)
  useLayoutEffect(() => {
    if (open) place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 스크롤·크기 변경 때는 위치가 어긋나므로 닫는다
  useEffect(() => {
    const onViewportChange = () => { if (openRef.current) hide() }
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    return () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [])

  const tr = useTransition(open, 100, 75)
  const trClass = transitionClass(tr.phase, {
    enterActive: 'transition-opacity duration-100',
    enterFrom: 'opacity-0',
    leaveActive: 'transition-opacity duration-75',
    leaveTo: 'opacity-0',
  })

  return (
    <span
      ref={root}
      {...rest}
      className={wrapperClass}
      onMouseEnter={(e: MouseEvent<HTMLSpanElement>) => { onMouseEnter?.(e); show() }}
      onMouseLeave={(e: MouseEvent<HTMLSpanElement>) => { onMouseLeave?.(e); hide() }}
      onFocus={(e: FocusEvent<HTMLSpanElement>) => { onFocus?.(e); if (focusVisible(e.target)) show(0) }}
      onBlur={(e: FocusEvent<HTMLSpanElement>) => { onBlur?.(e); hide() }}
      onKeyDown={(e: KeyboardEvent<HTMLSpanElement>) => { onKeyDown?.(e); if (e.key === 'Escape') hide() }}
    >
      {children}
      {tr.mounted && createPortal(
        <span
          ref={bubble}
          role="tooltip"
          data-side={pos.placed}
          className={cn('pointer-events-none fixed z-toast flex items-center gap-1.5 whitespace-nowrap rounded-[6px] bg-foreground px-2 py-1 text-xs font-medium text-background', trClass)}
          style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
        >
          {text}
          {keys.length > 0 && (
            <span className="flex gap-0.5">
              {keys.map(k => <UiKeycap key={k} size={18} inverted>{k}</UiKeycap>)}
            </span>
          )}
        </span>,
        document.body,
      )}
    </span>
  )
}

export default UiTooltip
