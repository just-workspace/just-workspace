/**
 * 채널 목록 폭 손잡이(handover-21 §5.9 + 디스코드 실측) — 목록 오른쪽 가장자리 세로 띠(맞히는 폭 8, 보이는 선은 호버·끄는 동안 primary 2px).
 *  드래그 199–367(CHAT_LIST_WIDTH — 디스코드 사이드바 264–432 에서 레일 64+1 을 뺀 값), 더블클릭 = 기본 298.
 *  키보드: role=separator(aria-orientation vertical, aria-valuenow/min/max) — ←→ 8px, Shift 와 함께 32px, Home/End 최소/최대, Enter 기본값.
 *  끄는 동안은 onPreview(폭)로 화면만 바꾸고, 놓을 때 개인 설정(chatSidebarWidth)에 한 번 저장한다.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { getUiZoom } from '~/composables/useViewport'
import { CHAT_LIST_WIDTH, clampChatListWidth, setChatSidebarWidth } from '~/composables/useUserPrefs'

export interface ChatListResizerProps {
  /** 지금 폭(저장값) */
  width: number
  /** 끄는 동안 미리보기 폭 — null 이면 끝 */
  onPreview: (w: number | null) => void
}

export function ChatListResizer({ width, onPreview }: ChatListResizerProps) {
  const { t } = useI18n()
  const start = useRef<{ x: number; w: number } | null>(null)
  const last = useRef(width)
  const [dragging, setDragging] = useState(false)

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    start.current = { x: e.clientX, w: width }
    last.current = width
    setDragging(true)
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!start.current) return
    const dx = (e.clientX - start.current.x) / (getUiZoom() || 1)
    last.current = clampChatListWidth(start.current.w + dx)
    onPreview(last.current)
  }
  function onPointerUp() {
    if (!start.current) return
    start.current = null
    setDragging(false)
    setChatSidebarWidth(last.current)
    onPreview(null)
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 32 : 8
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = width - step
    else if (e.key === 'ArrowRight') next = width + step
    else if (e.key === 'Home') next = CHAT_LIST_WIDTH.min
    else if (e.key === 'End') next = CHAT_LIST_WIDTH.max
    else if (e.key === 'Enter') next = CHAT_LIST_WIDTH.def
    if (next == null) return
    e.preventDefault()
    setChatSidebarWidth(next)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('chat.shell.list.resize')}
      aria-valuenow={width}
      aria-valuemin={CHAT_LIST_WIDTH.min}
      aria-valuemax={CHAT_LIST_WIDTH.max}
      tabIndex={0}
      title={t('chat.shell.list.resizeHint')}
      data-testid="chat-list-resizer"
      className="group absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-hidden"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => { setChatSidebarWidth(CHAT_LIST_WIDTH.def); onPreview(null) }}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors motion-reduce:transition-none',
          dragging ? 'bg-primary' : 'bg-transparent group-hover:bg-primary/60 group-focus-visible:bg-primary',
        )}
      />
    </div>
  )
}

export default ChatListResizer
