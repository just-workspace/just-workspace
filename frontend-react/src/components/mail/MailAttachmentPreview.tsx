/**
 * 첨부 미리보기 모달("PDF 는 미리보기 모달").
 * 공용 UiModal 넓은 판(wide 960 × 90dvh, 모바일 전체 화면) + 본문 여백 없음.
 * 서버는 이미지·PDF 만 inline 으로 제공한다(http_utils.INLINE_SAFE_TYPES). 그 외 형식에는 본 모달을 열지 않는다.
 */
import { useI18n } from '~/i18n'
import { formatBytes } from '~/utils/mailQuery'
import { UiModal } from '~/components/ui/Modal'
import { UiIconButton } from '~/components/ui/IconButton'

export interface MailAttachmentPreviewProps {
  /** 파일 이름(제목) */
  name: string
  /** 바이트 */
  size: number
  /** 이미지 · PDF */
  kind: 'image' | 'pdf'
  /** inline 첨부 URL */
  src: string
  /** 닫기 */
  onClose?: () => void
  /** 내려받기 */
  onDownload?: () => void
}

/** 첨부 미리보기(이미지·PDF) */
export function MailAttachmentPreview({ name, size, kind, src, onClose, onDownload }: MailAttachmentPreviewProps) {
  const { t } = useI18n()
  return (
    <UiModal
      title={name}
      ariaLabel={t('mail.attachment.previewLabel', { name })}
      size="wide"
      mobile="full"
      flush
      onClose={onClose}
      actions={(
        <>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatBytes(size)}</span>
          <UiIconButton label={t('common.download')} icon="download" onClick={() => onDownload?.()} />
        </>
      )}
    >
      <div className="min-h-0 flex-1 bg-muted">
        {kind === 'pdf'
          ? <iframe src={src} title={name} className="h-full w-full border-0" />
          : (
            <div className="grid h-full place-items-center overflow-auto p-4">
              <img src={src} alt={name} className="max-h-full max-w-full object-contain" />
            </div>
          )}
      </div>
    </UiModal>
  )
}

export default MailAttachmentPreview
