/**
 * 툴팁: 반전색 12/500, 400ms 지연, 포커스에도 표시, 문구 = aria-label, 단축키 키캡 병기.
 * 터치 기기(pointer: coarse)에서는 표시하지 않는다(길게 누르기 = 액션 시트 규칙).
 *
 * 래퍼는 상자를 생성하지 않는다(display: contents). 따라서 트리거(버튼 등)에 지정한 위치·레이아웃 클래스
 * (absolute right-2 top-2, grid 칸 배치 등)가 실제 부모 기준으로 그대로 적용된다.
 * 말풍선은 body 로 포털하여 트리거 좌표에 fixed 로 표시한다 → overflow 에 잘리지 않으며,
 * 화면 위(아래)로 초과하면 반대쪽으로 자동 전환한다.
 * 래퍼 자체에 className 을 지정하면(예: "hidden md:inline-flex") contents 대신 해당 표시 방식을 사용한다.
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
  /** 선호 위치(기본 위). 공간 부족 시 반대쪽으로 전환 */
  side?: 'top' | 'bottom'
  /** 트리거를 block 래퍼로 감쌀 때(래퍼가 상자를 가져야 하는 경우) */
  block?: boolean
  /** 툴팁 비활성화(라벨만 aria 로 유지할 때) */
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
 * 키보드에 의한 포커스 여부(:focus-visible). 마우스로 메뉴·모달을 닫으면 포커스가 트리거로 복귀하는데,
 * 그때마다 툴팁이 표시되어 다른 위치를 클릭할 때까지 유지되었다 — 키보드 포커스에만 표시한다.
 * :focus-visible 미지원 환경(구형 브라우저·jsdom)에서는 기존과 동일하게 표시한다.
 */
function focusVisible(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return true
  // 실제 포커스가 아닌 이벤트(코드에서 직접 발생시킨 focus)는 판정 불가 — 표시한다
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
    // 화면 배율(루트 zoom) 적용 시 — 화면 좌표를 style 에 넣을 CSS px 로 변환
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
      // 첫 프레임은 근사 위치(측정 전), 측정 후 정확한 위치로 보정(아래 layout effect)
      setPos(p => ({ ...p, left: r.left, top: r.top }))
      setOpen(true)
    }, delay)
  }
  function hide() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    setOpen(false)
  }

  // 열림 직후 측정하여 정확한 위치로 이동
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
