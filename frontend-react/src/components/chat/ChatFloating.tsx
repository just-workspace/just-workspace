/**
 * 채팅 셸의 플로팅 카드(프로필 팝아웃 300 · 사용자별 음량 260) — 데스크톱은 기준 사각형 옆에 붙는 팝오버, 모바일은 바텀 시트.
 *  · 데스크톱: body 로 포털, position:fixed. 기준이 화면 오른쪽 절반이면 왼쪽에, 아니면 오른쪽에 8 간격으로 배치.
 *    세로는 기준 위쪽에 맞추고 화면 안으로 보정(8 여백). 좌표는 배율(루트 zoom) 적용 시에도 일치하도록 toCssRect 사용.
 *  · 모바일: 어두운 막(bg-black/60) + 아래에서 올라오는 시트(rounded-t-2xl, 핸들 40×4). 막 클릭 시 닫힘.
 *  · 공통: Esc · 외부 클릭으로 닫힘, 열 때 첫 포커스 요소로 이동, 닫을 때 연 요소로 포커스 복원.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clsx as cn } from 'clsx'
import { toCssRect, useViewport } from '~/composables/useViewport'
import { FOCUSABLE } from '~/components/ui/internal'

export interface ChatFloatingProps {
  /** 화면 좌표 사각형(useChatUi.anchorOf) — 없으면 화면 가운데 */
  anchor: { x: number; y: number; w: number; h: number } | null
  width: number
  mobile: boolean
  role?: 'dialog' | 'menu'
  ariaLabel: string
  onClose: () => void
  /** 모바일 시트 최대 높이(px) */
  sheetMaxHeight?: number
  className?: string
  children: ReactNode
}

export function ChatFloating({ anchor, width, mobile, role = 'dialog', ariaLabel, onClose, sheetMaxHeight = 600, className, children }: ChatFloatingProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const { width: vw, height: vh } = useViewport()
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (mobile) return
    const h = ref.current?.offsetHeight ?? 400
    if (!anchor) { setPos({ left: Math.max(8, (vw - width) / 2), top: Math.max(8, (vh - h) / 2) }); return }
    const r = toCssRect({ left: anchor.x, top: anchor.y, width: anchor.w, height: anchor.h })
    const right = r.left + r.width / 2 > vw / 2
    let left = right ? r.left - width - 8 : r.left + r.width + 8
    left = Math.max(8, Math.min(left, vw - width - 8))
    const top = Math.max(8, Math.min(r.top, vh - h - 8))
    setPos({ left, top })
  }, [anchor, width, vw, vh, mobile])

  useEffect(() => {
    const el = ref.current
    const opener = document.activeElement as HTMLElement | null
    const first = el?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? el)?.focus({ preventScroll: true })
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // 내부에서 연 메뉴(UiMenu 포털)의 Esc 는 해당 메뉴가 처리
      if ((e.target as HTMLElement | null)?.closest?.('[role="menu"],[role="listbox"]') && !ref.current?.isSameNode((e.target as HTMLElement).closest('[role="menu"]'))) return
      e.stopPropagation(); e.preventDefault(); closeRef.current()
    }
    function onDown(e: PointerEvent) {
      const t = e.target as Node | null
      if (!t || ref.current?.contains(t)) return
      // 내부에서 연 메뉴(포털) 클릭 시에는 닫지 않음
      if ((t as HTMLElement).closest?.('[data-chat-floating-keep],[role="menu"],[role="dialog"][aria-modal="true"]')) return
      closeRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
      if (opener && document.contains(opener)) opener.focus?.({ preventScroll: true })
    }
  }, [])

  if (typeof document === 'undefined') return null

  if (mobile) {
    return createPortal(
      <div className="fixed inset-0 z-modal">
        <div className="absolute inset-0 bg-black/60" aria-hidden="true" />
        <div
          ref={ref}
          role={role}
          aria-label={ariaLabel}
          aria-modal="true"
          tabIndex={-1}
          className={cn('absolute inset-x-0 bottom-0 overflow-y-auto rounded-t-2xl border-t border-border bg-popover shadow-xl outline-hidden', className)}
          style={{ maxHeight: `min(${sheetMaxHeight}px, 90dvh)`, paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <span className="absolute left-1/2 top-2 z-10 h-1 w-10 -translate-x-1/2 rounded-full bg-muted-foreground/40" aria-hidden="true" />
          {children}
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={ariaLabel}
      tabIndex={-1}
      className={cn('fixed z-modal overflow-y-auto rounded-lg border border-border bg-popover shadow-xl outline-hidden', className)}
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: vh - 16 }}
    >
      {children}
    </div>,
    document.body,
  )
}

export default ChatFloating
