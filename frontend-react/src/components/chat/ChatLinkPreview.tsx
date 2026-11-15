/**
 * 링크 미리보기 카드(R5 B12 · handover-22 "링크 카드" · Chat22 #cozy). 메시지 본문 아래, 최대 520 · 왼쪽 4px 띠(primary) · radius 4 · 첫 링크 1개만.
 * 사이트(12 muted) → 제목(primary 16/600, 2줄 자름) → 설명(13 muted, 2줄) → 오른쪽 112 썸네일(없으면 칸째 없음).
 * ✕(미리보기 지우기)는 보낸 사람에게만, 카드에 호버(또는 키보드 포커스)했을 때. 표시 여부는 받는 쪽 설정(설정 › 채팅 "링크 미리보기").
 * 썸네일은 서버 프록시 경로(/api/chat/link-preview/images/…) — 받는 쪽 브라우저가 외부로 직접 요청하지 않는다.
 */
import { useState } from 'react'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { apiUrl } from '~/lib/runtimeConfig'
import { addToast } from '~/composables/useToast'
import { dismissLinkPreview, type LinkPreview } from '~/composables/useChat'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'

export interface ChatLinkPreviewProps {
  /** 메시지 id(지우기용) */
  messageId: string
  preview: LinkPreview
  /** 내가 보낸 메시지 — ✕ 를 보인다 */
  canDismiss?: boolean
  className?: string
}

const clamp2 = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as const

export function ChatLinkPreview({ messageId, preview, canDismiss = false, className }: ChatLinkPreviewProps) {
  const { t } = useI18n()
  // 썸네일을 못 받으면(만료·404) 칸째 뺀다
  const [imgFailed, setImgFailed] = useState(false)
  const showImage = !!preview.image && !imgFailed

  async function onDismiss() {
    try { await dismissLinkPreview(messageId) } catch { addToast('error', t('common.error')) }
  }

  return (
    <div
      className={cn('group/link relative mt-1 flex overflow-hidden rounded border border-border bg-card', className)}
      style={{ maxWidth: 520 }}
      role="group"
      aria-label={t('chat.message.linkPreview')}
    >
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="flex min-w-0 flex-1 outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="w-1 shrink-0 bg-primary" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5">
          {preview.site && (
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <UiIcon name="globe" className="h-3 w-3" />
              <span className="truncate">{preview.site}</span>
            </div>
          )}
          <div className="text-[16px] font-semibold leading-[22px] text-primary" style={clamp2}>{preview.title}</div>
          {preview.description && (
            <p className="text-[13px] leading-snug text-muted-foreground" style={clamp2}>{preview.description}</p>
          )}
        </div>
        {showImage && (
          <div className="w-28 shrink-0 bg-muted">
            <img
              src={apiUrl(preview.image!)}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover"
              onError={() => setImgFailed(true)}
            />
          </div>
        )}
      </a>
      {canDismiss && (
        <span className="absolute right-1.5 top-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/link:opacity-100">
          <UiIconButton icon="close" label={t('chat.message.removePreview')} size="sm" onClick={() => { void onDismiss() }} />
        </span>
      )}
    </div>
  )
}

export default ChatLinkPreview
