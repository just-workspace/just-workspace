/**
 * 접속 바에서 위로 열리는 팝오버(음질 패널 460 · 음질 상태 400). 데스크톱 전용 — 모바일은 호출자가 UiModal(바텀시트)로 그린다.
 * 기준 요소(접속 바의 버튼) 위쪽에 붙여 body 로 포털(사이드바는 overflow-hidden 이라 안에서 그리면 잘린다).
 * 좌표는 화면 배율(루트 zoom) 아래에서도 맞게 toCssRect 로 바꾼다(UiMenu·UiTooltip 과 같은 규칙). Esc·바깥 클릭으로 닫힌다.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { toCssRect, useViewport } from '~/composables/useViewport'
import { FOCUSABLE } from '~/components/ui/internal'

export interface VoicePopoverProps {
  /** 기준 요소(접속 바) — 그 왼쪽 + 12, 바로 위(+8)에 열린다 */
  anchor: HTMLElement | null
  width: 400 | 460
  ariaLabel: string
  onClose: () => void
  className?: string
  children: ReactNode
}

export function VoicePopover({ anchor, width, ariaLabel, onClose, className, children }: VoicePopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const { width: vw, height: vh } = useViewport()
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)

  // 기준 요소의 위치(화면 → CSS px) — 창 크기·배율이 바뀌면 다시
  useLayoutEffect(() => {
    if (!anchor) { setPos(null); return }
    const r = toCssRect(anchor.getBoundingClientRect())
    const left = Math.max(8, Math.min(r.left + 12, vw - width - 8))
    setPos({ left, bottom: Math.max(8, vh - r.top + 8) })
  }, [anchor, width, vw, vh])

  useEffect(() => {
    const el = ref.current
    const opener = document.activeElement as HTMLElement | null
    const first = el?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? el)?.focus()
    // 안에서 연 드롭다운(UiSelect·UiMenu — body 포털)은 이 팝오버의 일부다. 그 목록의 Esc·클릭에 팝오버가 먼저 닫히면
    // 장치를 고를 수가 없다(클릭 전에 목록째 사라진다).
    const inChildLayer = (n: EventTarget | null) => !!(n as Element | null)?.closest?.('[role="listbox"],[role="menu"]')
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || inChildLayer(e.target) || document.querySelector('[role="listbox"]')) return
      e.stopPropagation(); closeRef.current()
    }
    function onDown(e: PointerEvent) {
      const t = e.target as Node | null
      if (!t) return
      if (ref.current?.contains(t) || anchor?.contains(t) || inChildLayer(t)) return
      closeRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
      opener?.focus?.()
    }
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={ariaLabel}
      tabIndex={-1}
      data-testid="voice-popover"
      className={cn('fixed z-overlay flex max-h-[calc(100dvh-16px)] flex-col overflow-y-auto rounded-xl border border-border bg-popover p-4 text-foreground shadow-xl outline-hidden', className)}
      // 아래를 기준 요소 위에 고정하므로 쓸 수 있는 높이는 그 위쪽뿐 — 안 줄이면 낮은 창에서 제목이 화면 위로 나가 스크롤로도 못 닿는다
      style={{ width, left: pos?.left ?? 76, bottom: pos?.bottom ?? 120, maxHeight: pos ? Math.max(160, vh - pos.bottom - 8) : undefined }}
    >
      {children}
    </div>,
    document.body,
  )
}

export default VoicePopover
