/**
 * 이미지 보기 — 전체 화면.
 * 헤더 56: 보낸 사람(아바타 32 · 이름 · "오늘 오전 10:21 · #채널") · "2 / 5"(mono) · 원본 열기 · 다운로드 · 닫기(Esc).
 * 가운데: ← 이전 / 이미지(최대 960, 비율 유지) / 다음 → (44 버튼) · ←→ 키 · Esc 닫기. 포커스는 닫기 버튼에서 시작하며 닫을 때 복원.
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '~/i18n'
import { apiUrl } from '~/lib/runtimeConfig'
import type { MessageSender } from '~/composables/useChat'
import { chatClockAmPm, initialOf } from '~/composables/useChatUi'
import { formatChatFileSize } from '~/composables/useChatAttachments'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { downloadAttachment, type ViewAttachment } from './ChatAttachmentGrid'

export interface ChatImageViewerProps {
  images: ViewAttachment[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
  sender?: MessageSender | null
  createdAt?: string
  channelName?: string | null
}

export function ChatImageViewer({ images, index, onIndex, onClose, sender, createdAt, channelName }: ChatImageViewerProps) {
  const { t, locale } = useI18n()
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const a = images[index]
  const L = useRef({ index, n: images.length, onIndex, onClose })
  L.current = { index, n: images.length, onIndex, onClose }

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      const c = L.current
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); c.onClose() }
      else if (e.key === 'ArrowLeft' && c.index > 0) { e.preventDefault(); c.onIndex(c.index - 1) }
      else if (e.key === 'ArrowRight' && c.index < c.n - 1) { e.preventDefault(); c.onIndex(c.index + 1) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.() }
  }, [])

  if (!a) return null
  const name = sender?.display_name || sender?.username || ''
  const when = createdAt ? chatClockAmPm(createdAt, locale === 'en' ? 'en-US' : 'ko-KR') : ''
  const day = createdAt && new Date(createdAt).toDateString() === new Date().toDateString() ? t('common.today') + ' ' : ''
  const meta = [a.filename, a.width && a.height ? `${a.width}×${a.height}` : '', a.size ? formatChatFileSize(a.size) : ''].filter(Boolean).join(' · ')

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t('chat.msg.viewer.title')} className="fixed inset-0 z-modal flex flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-3 px-3 text-[14px] md:px-5">
        <UiAvatar src={sender?.avatar_url} alt={name} fallback={initialOf(name)} textSize={11} className="h-8 w-8" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate font-semibold">{name}</p>
          <p className="truncate text-[12px] text-muted-foreground">{day}{when}{channelName ? ` · #${channelName}` : ''}</p>
        </div>
        <span className="font-mono text-[13px]" aria-live="polite">{index + 1} / {images.length}</span>
        <UiButton variant="ghost" size="sm" className="hidden md:inline-flex" onClick={() => window.open(apiUrl(a.url), '_blank', 'noopener,noreferrer')}>{t('chat.msg.viewer.openOriginal')}</UiButton>
        <UiIconButton icon="download" label={t('common.download')} onClick={() => { void downloadAttachment(a) }} />
        <UiIconButton ref={closeRef} icon="close" label={t('chat.msg.viewer.close')} onClick={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-2 pb-10 md:gap-6 md:px-6">
        <UiIconButton icon="chevron-left" label={t('chat.msg.viewer.prev')} variant="muted" size="lg" disabled={index === 0} onClick={() => onIndex(index - 1)} />
        <figure className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 self-stretch" style={{ maxWidth: 960 }}>
          <img src={apiUrl(a.url)} alt={a.alt || a.filename} className="min-h-0 max-w-full flex-1 rounded-lg object-contain" />
          <figcaption className="font-mono text-[13px] text-muted-foreground">{meta}</figcaption>
        </figure>
        <UiIconButton icon="chevron-right" label={t('chat.msg.viewer.next')} variant="muted" size="lg" disabled={index >= images.length - 1} onClick={() => onIndex(index + 1)} />
      </div>
    </div>,
    document.body,
  )
}

export default ChatImageViewer
