/**
 * 슬라이더(20 의 것 확정):
 * 트랙 6(bg-muted, rounded-full) + 채움 primary · 손잡이 16(border-2 primary, bg-background) · 눈금 marks(2×12 muted-foreground).
 * 전체 높이 20(h-5) — 손잡이·트랙을 세로 가운데. 값 글자(예: "120%" mono primary)는 호출부가 옆에 그린다.
 * 접근성: 바깥 div 가 role=slider(tabIndex 0, aria-valuemin/max/now, aria-valuetext = formatValue(값)). 포커스 링은 손잡이에.
 * 키보드: ←↓ / →↑ = step · PageDown / PageUp = pageStep(기본 step×10) · Home / End = min / max.
 * 포인터: 트랙 아무 곳이나 눌러 옮기고 끌면 따라온다(pointer capture). 놓을 때 onCommit(마지막 값) — 저장은 거기서.
 *
 * @example
 * <UiSlider ariaLabel="박준 님 음량" min={0} max={200} step={5} marks={[100]}
 *   modelValue={vol} onUpdateModelValue={setVol} onCommit={save} formatValue={v => `${v}%`} />
 */
import { useRef, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '~/lib/utils'
import { useModel } from './internal'

export interface UiSliderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'defaultValue' | 'onChange'> {
  /** 값. 안 주면 부품이 가진다(처음 = min) */
  modelValue?: number
  /** 값 바뀜(끄는 동안 계속) */
  onUpdateModelValue?: (v: number) => void
  /** 끌기를 놓았을 때 · 키보드로 바꿨을 때 — 저장 시점 */
  onCommit?: (v: number) => void
  /** 최소(기본 0) */
  min?: number
  /** 최대(기본 100) */
  max?: number
  /** 단계(기본 1) */
  step?: number
  /** PageUp/PageDown 단계(기본 step×10) */
  pageStep?: number
  /** 눈금 값들(예: [100] — 기본값 자리). 트랙 위 세로 막대, aria-hidden */
  marks?: number[]
  /** 접근성 이름(필수 — 화면에 라벨이 없으면) */
  ariaLabel?: string
  /** 라벨 요소 id(aria-labelledby) */
  ariaLabelledby?: string
  /** aria-valuetext 만들기(예: v => `${v}%`). 없으면 숫자 그대로 */
  formatValue?: (v: number) => string
  disabled?: boolean
}

function snap(v: number, min: number, max: number, step: number): number {
  const s = step > 0 ? step : 1
  const n = Math.round((v - min) / s) * s + min
  // 부동소수 꼬리 정리(0.1 단계 등)
  const dec = (String(s).split('.')[1] ?? '').length
  return Math.min(max, Math.max(min, Number(n.toFixed(dec))))
}

/**
 * 가로 슬라이더(트랙 6 · 손잡이 16 · 눈금).
 */
export function UiSlider({
  modelValue, onUpdateModelValue, onCommit, min = 0, max = 100, step = 1, pageStep, marks, ariaLabel, ariaLabelledby,
  formatValue, disabled = false, className, onKeyDown, onPointerDown, ...rest
}: UiSliderProps) {
  const [model, setModel] = useModel<number>(modelValue, min, onUpdateModelValue)
  const value = snap(model, min, max, step)
  const span = max - min || 1
  const pct = ((value - min) / span) * 100
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  const last = useRef(value)
  last.current = value

  function set(v: number, commit: boolean) {
    const n = snap(v, min, max, step)
    if (n !== value) setModel(n)
    last.current = n
    if (commit) onCommit?.(n)
  }

  function fromPointer(clientX: number): number {
    const r = trackRef.current?.getBoundingClientRect()
    if (!r || r.width <= 0) return value
    // clientX 와 rect 는 같은 좌표계(배율 무관 — 비율만 쓴다)
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return min + ratio * span
  }

  function onDown(e: PointerEvent<HTMLDivElement>) {
    onPointerDown?.(e)
    if (disabled || e.button !== 0) return
    dragging.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.currentTarget.focus()
    set(fromPointer(e.clientX), false)
  }
  function onMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    set(fromPointer(e.clientX), false)
  }
  function onUp(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    onCommit?.(last.current)
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(e)
    if (disabled || e.defaultPrevented) return
    const page = pageStep ?? step * 10
    let next: number
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': next = value + step; break
      case 'ArrowLeft': case 'ArrowDown': next = value - step; break
      case 'PageUp': next = value + page; break
      case 'PageDown': next = value - page; break
      case 'Home': next = min; break
      case 'End': next = max; break
      default: return
    }
    e.preventDefault()
    set(next, true)
  }

  return (
    <div
      {...rest}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={formatValue ? formatValue(value) : undefined}
      aria-disabled={disabled || undefined}
      aria-orientation="horizontal"
      className={cn(
        'group relative h-5 touch-none select-none focus-visible:outline-hidden',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
    >
      {/* 손잡이 반지름(8)만큼 안쪽에서 값 비율을 잰다 — 끝값에서 손잡이가 밖으로 나가지 않게 */}
      <div ref={trackRef} className="absolute inset-y-0 left-2 right-2">
        <span aria-hidden="true" className="absolute -inset-x-2 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
        <span aria-hidden="true" className="absolute -left-2 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary" style={{ width: `calc(${pct}% + 8px)` }} />
        {marks?.filter(m => m >= min && m <= max).map(m => (
          <span
            key={m}
            aria-hidden="true"
            data-mark={m}
            className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-muted-foreground"
            style={{ left: `${((m - min) / span) * 100}%` }}
          />
        ))}
        <span
          aria-hidden="true"
          data-thumb=""
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background ring-offset-background transition-shadow group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export default UiSlider
