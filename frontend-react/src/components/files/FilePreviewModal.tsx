/**
 * 미리보기 모달(Vue components/files/FilePreviewModal.vue): 이미지 · PDF(iframe) · 텍스트(GET /api/files/preview) · 오피스(편집기로 열기) ·
 * 그 밖은 "미리 볼 수 없음 + 다운로드". Esc 닫기 + 열릴 때 포커스, 닫으면 연 요소로 복귀(시안 G 규칙).
 * 마운트 = 열림. Vue 와 같이 포털 없이 페이지 안에 fixed 로 그린다.
 */
import { useZoneInstalled } from '~/composables/useSiteConfig'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { useFiles, type FileItem } from '~/composables/useFiles'
import { previewKind } from '~/lib/files'
import { UiIconButton } from '~/components/ui/IconButton'

export interface FilesFilePreviewModalProps {
  item: FileItem
  onClose?: () => void
  /** 오피스 문서를 편집기로 */
  onOpenEditor?: (item: FileItem) => void
}

export function FilesFilePreviewModal({ item, onClose, onOpenEditor }: FilesFilePreviewModalProps) {
  const { getPreviewUrl, downloadFile, isOfficeFile } = useFiles()
  const { t } = useI18n()

  const [textContent, setTextContent] = useState<string | null>(null)
  const [loadingText, setLoadingText] = useState(false)

  // 형식 판정은 lib/files previewKind 한곳 — mime 을 모르는 항목(직접 공유받은 파일)은 확장자로 본다
  // 문서 구역이 없으면 편집기로 열 수 없다 — 오피스 파일도 "미리 볼 수 없음 + 내려받기"로
  const docsOn = useZoneInstalled('docs')
  const previewType = previewKind(item) ?? (docsOn && isOfficeFile(item.name) ? 'office' : null)

  async function loadTextPreview() {
    if (previewType !== 'text') return
    setLoadingText(true)
    try {
      const data = await $fetch<{ type: string; content: string; name: string }>(getPreviewUrl(item.path))
      setTextContent(data.content)
    } catch {
      setTextContent(t('files.preview.loadError'))
    } finally {
      setLoadingText(false)
    }
  }

  // 미리보기 모달: Esc 닫기 + 열릴 때 포커스, 닫으면 연 요소로 복귀(시안 G 규칙)
  const panel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    panel.current?.focus()
    if (previewType === 'text') loadTextPreview()
    return () => { opener?.focus?.() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="fixed inset-0 z-modal flex items-end sm:items-center justify-center bg-scrim"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }}
    >
      <div ref={panel} tabIndex={-1} className="bg-card border border-border rounded-t-sheet sm:rounded-lg w-full sm:max-w-4xl max-h-[90dvh] sm:mx-4 flex flex-col shadow-xl outline-hidden" role="dialog" aria-modal="true" aria-label={item.name}>
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border pl-5 pr-2.5">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{item.name}</h2>
          <UiIconButton label={t('common.download')} icon="download" onClick={() => downloadFile(item.path)} />
          <UiIconButton label={t('common.close')} icon="close" keys={['Esc']} onClick={() => onClose?.()} />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-2 sm:p-4 min-h-0">
          {previewType === 'image'
            ? (
              <div className="flex items-center justify-center h-full">
                <img src={getPreviewUrl(item.path)} alt={item.name} className="max-w-full max-h-full object-contain rounded" />
              </div>
            )
            : previewType === 'pdf'
              ? (
                <div className="h-full">
                  <iframe src={getPreviewUrl(item.path)} className="w-full h-full min-h-[50dvh] sm:min-h-[60dvh] rounded-md border border-border" />
                </div>
              )
              : previewType === 'text'
                ? (
                  <div>
                    {loadingText
                      ? (
                        <div className="flex items-center justify-center h-40">
                          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        </div>
                      )
                      : <pre className="text-sm bg-muted/30 rounded-lg p-4 overflow-auto max-h-[70dvh] whitespace-pre-wrap break-words font-mono">{textContent}</pre>}
                  </div>
                )
                : previewType === 'office'
                  ? (
                    <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-12 w-12 mb-3">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
                      </svg>
                      <p className="text-sm mb-3">{item.name}</p>
                      <button
                        onClick={() => { onOpenEditor?.(item); onClose?.() }}
                        className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                      >
                        {t('files.editor.openIn')}
                      </button>
                    </div>
                  )
                  : (
                    <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
                      <p className="text-sm">{t('files.preview.unsupported')}</p>
                      <button
                        onClick={() => downloadFile(item.path)}
                        className="mt-3 px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                      >
                        {t('common.download')}
                      </button>
                    </div>
                  )}
        </div>
      </div>
    </div>
  )
}

export default FilesFilePreviewModal
