/**
 * S6b 첨부 칩(시안 D1 입력창 · D2-3 변환 중/실패) + Wave5 보강(시안 K1).
 *  48 높이 · r10 · 테두리 · 아이콘 20 + 이름 13 / 부가 11.5(mono 크기 · 상태) + [빼기].
 *  올리는 중·변환 중 = 회전 아이콘 · 실패 = danger 테두리·바탕 + 코드별 문구.
 * K1-1: 이미지는 88×88 썸네일(모바일 64) + 오른쪽 위 [빼기](solid) — 미리보기는 고른 파일의 로컬 주소.
 * K1-2: 보낸 메시지 안 첨부는 AiSentAttachments(32 칩: 아이콘 14 · 이름 · 크기 mono) — 누르면 원본 미리보기·내려받기.
 */
import { useEffect, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { apiRawFetch } from '~/lib/api'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiModal } from '~/components/ui/Modal'
import { aiAttachErrorKey, aiFileIcon, aiFormatBytes, type AiAttachment } from '~/utils/aiAssist'

export interface AiAttachmentsProps {
  items: AiAttachment[]
  /** 지금 모델이 이미지를 읽는지(아니면 이미지 칩에 경고) */
  vision?: boolean
  /** 빼기 — 없으면 읽기 전용(메시지 안) */
  onRemove?: (a: AiAttachment) => void
  /** 모바일 입력창 — 썸네일 64 · 칩 64 높이 · 한 줄 가로 스크롤(K1-4) */
  compact?: boolean
  className?: string
}

export function AiAttachments({ items, vision = true, onRemove, compact, className }: AiAttachmentsProps) {
  const { t } = useI18n()
  if (!items.length) return null
  return (
    <ul aria-label={t('ai.attach.listLabel')} className={cn('m-0 flex list-none gap-2 p-0', compact ? 'flex-nowrap overflow-x-auto' : 'flex-wrap', className)}>
      {items.map((a) => {
        const busy = a.status === 'uploading' || a.status === 'converting'
        const failed = a.status === 'failed'
        // 썸네일: 고른 이미지(로컬 미리보기가 있고 실패하지 않음)
        if (a.kind === 'image' && a.preview && !failed) {
          return (
            <li
              key={a.key || a.id || a.name}
              data-stage={a.status}
              className={cn('relative shrink-0 overflow-hidden rounded-[10px] border border-border bg-muted-foreground/[0.18]', compact ? 'h-16 w-16 rounded-lg' : 'h-[88px] w-[88px]')}
            >
              <img src={a.preview} alt={t('ai.attach.previewAlt', { name: a.name })} className="h-full w-full object-cover" />
              {busy && (
                <span role="status" aria-label={a.status === 'uploading' ? t('ai.attach.uploading') : t('ai.attach.converting')} className="absolute inset-0 grid place-items-center bg-background/50">
                  <UiIcon name="loader" className="h-5 w-5 animate-spin text-foreground" />
                </span>
              )}
              {onRemove && (
                <span className="absolute right-1 top-1">
                  <UiIconButton label={t('ai.attach.remove', { name: a.name })} icon="close" size="sm" variant="solid" onClick={() => onRemove(a)} />
                </span>
              )}
            </li>
          )
        }
        const blind = !failed && !busy && a.kind === 'image' && !vision
        const note = failed
          ? t(aiAttachErrorKey(a.error_code))
          : a.status === 'uploading' ? t('ai.attach.uploading')
            : a.status === 'converting' ? t('ai.attach.converting')
              : blind ? t('ai.attach.noVision')
                : a.kind === 'image' ? t('ai.attach.image') : (a.note || t('ai.attach.ready'))
        return (
          <li
            key={a.key || a.id || a.name}
            data-stage={a.status}
            className={cn(
              'flex max-w-full shrink-0 items-center gap-2 rounded-[10px] border pl-2.5',
              compact ? 'h-16 rounded-lg' : 'h-12 self-center',
              onRemove ? 'pr-1.5' : 'pr-2.5',
              failed ? 'border-danger/50 bg-danger/[0.08]' : blind ? 'border-warning/50 bg-warning/[0.08]' : 'border-border bg-background',
            )}
          >
            <UiIcon
              name={busy ? 'loader' : failed ? 'alert-circle' : blind ? 'alert-triangle' : aiFileIcon(a.name, a.kind)}
              className={cn('h-5 w-5 shrink-0', busy && 'animate-spin', failed ? 'text-danger' : blind ? 'text-warning' : 'text-primary')}
            />
            <span className="flex min-w-0 flex-col leading-[17px]">
              <span className={cn('truncate text-[13px] text-foreground', compact ? 'max-w-[120px]' : 'max-w-[180px]')}>{a.name}</span>
              <span className="truncate text-[11.5px] text-muted-foreground" role={busy ? 'status' : failed || blind ? 'alert' : undefined}>
                {!failed && a.size ? <><span className="font-mono">{aiFormatBytes(a.size)}</span> · </> : null}{note}
              </span>
            </span>
            {onRemove && (
              <UiIconButton label={t('ai.attach.remove', { name: a.name })} icon="close" size="sm" onClick={() => onRemove(a)} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** K1-2 — 보낸 메시지 안 첨부 칩. 누르면 원본 미리보기·내려받기 창 */
export function AiSentAttachments({ items, className }: { items: AiAttachment[]; className?: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState<AiAttachment | null>(null)
  if (!items.length) return null
  return (
    <>
      <ul aria-label={t('ai.attach.sentLabel')} className={cn('m-0 flex list-none flex-wrap gap-1.5 p-0', className)}>
        {items.map(a => (
          <li key={a.id || a.name}>
            <button
              type="button"
              disabled={!a.id}
              aria-label={t('ai.attach.openSent', { name: a.name })}
              className="inline-flex h-8 max-w-[260px] items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              onClick={() => setOpen(a)}
            >
              <UiIcon name={aiFileIcon(a.name, a.kind)} className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="min-w-0 truncate">{a.name}</span>
              {!!a.size && <span className="shrink-0 font-mono text-muted-foreground">{aiFormatBytes(a.size)}</span>}
            </button>
          </li>
        ))}
      </ul>
      {open?.id && <AiAttachmentPreview attachment={open} onClose={() => setOpen(null)} />}
    </>
  )
}

async function fetchBlob(path: string): Promise<Blob | null> {
  try {
    const r = await apiRawFetch(path, { credentials: 'include' })
    return r.ok ? await r.blob() : null
  } catch { return null }
}

/** 첨부 원본 미리보기 — 이미지·PDF 는 원본, 문서는 뽑은 글자. 원본이 보관 기간(7일)을 넘겼으면 내려받기 없음 */
export function AiAttachmentPreview({ attachment, onClose }: { attachment: AiAttachment; onClose: () => void }) {
  const { t } = useI18n()
  const id = attachment.id as string
  const isImage = attachment.kind === 'image'
  const isPdf = /\.pdf$/i.test(attachment.name)
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [hasFile, setHasFile] = useState<boolean>(attachment.has_file !== false)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    let made: string | null = null
    void (async () => {
      if ((isImage || isPdf) && attachment.has_file !== false) {
        const b = await fetchBlob(`/api/ai/attachments/${encodeURIComponent(id)}/file`)
        if (!alive) return
        if (b) { made = URL.createObjectURL(b); setUrl(made) } else setHasFile(false)
      }
      if (!isImage) {
        try {
          const r = await apiRawFetch(`/api/ai/attachments/${encodeURIComponent(id)}/text`, { credentials: 'include' })
          const j = r.ok ? await r.json() : null
          if (alive && j) { setText(j.text || ''); setHasFile(!!j.has_file) }
        } catch { /* 글자 없음 */ }
      }
      if (alive) setLoading(false)
    })()
    return () => { alive = false; if (made) URL.revokeObjectURL(made) }
  }, [id, isImage, isPdf, attachment.has_file])

  async function download() {
    const b = await fetchBlob(`/api/ai/attachments/${encodeURIComponent(id)}/file?download=1`)
    if (!b) { setHasFile(false); return }
    const u = URL.createObjectURL(b)
    const a = document.createElement('a')
    a.href = u; a.download = attachment.name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(u), 1000)
  }

  return (
    <UiModal
      title={attachment.name}
      size="wide"
      onClose={onClose}
      footer={(
        <>
          {!hasFile && <span className="mr-auto text-xs text-muted-foreground">{t('ai.attach.expired')}</span>}
          <UiButton variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</UiButton>
          <UiButton size="sm" icon="download" disabled={!hasFile} onClick={() => { void download() }}>{t('ai.attach.download')}</UiButton>
        </>
      )}
    >
      {loading ? <p className="m-0 text-sm text-muted-foreground">…</p>
        : isImage
          ? (url ? <img src={url} alt={attachment.name} className="mx-auto max-h-[70dvh] max-w-full rounded-lg object-contain" /> : <p className="m-0 text-sm text-muted-foreground">{t('ai.attach.expired')}</p>)
          : isPdf && url
            ? <iframe title={attachment.name} src={url} className="h-[70dvh] w-full rounded-lg border border-border" />
            : <pre className="m-0 max-h-[70dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 font-sans text-[13px] leading-relaxed text-foreground">{text || t('ai.attach.noText')}</pre>}
    </UiModal>
  )
}

export default AiAttachments
