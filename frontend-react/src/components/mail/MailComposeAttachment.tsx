/**
 * 작성 창 첨부 칩: 36 · rounded-md · 이름 + 크기 mono + ✕ 24(히트 40). 모바일은 40.
 */
import { useI18n } from '~/i18n'
// class 를 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지운다)
import { clsx as cx } from 'clsx'
import type { UploadedAttachment } from '~/composables/useMail'
import { formatBytes } from '~/utils/mailQuery'
import { UiIcon } from '~/components/ui/Icon'

export interface MailComposeAttachmentProps {
  /** 올린 첨부 */
  att: UploadedAttachment
  /** md 36(데스크톱) · lg 40(모바일) */
  size?: 'md' | 'lg'
  /** ✕ */
  onRemove?: () => void
  /** 이름 앞 작은 표시(대용량 첨부 등) */
  badge?: string
}

/** 작성 중 첨부 한 개 */
export function MailComposeAttachment({ att, size = 'md', onRemove, badge }: MailComposeAttachmentProps) {
  const { t } = useI18n()
  return (
    <span className={cx('inline-flex max-w-full items-center gap-2 rounded-md border border-border pl-2.5 pr-1.5 text-xs', size === 'lg' ? 'h-10' : 'h-9')}>
      {badge && <span className="shrink-0 rounded-sm bg-primary/15 px-1 text-[10.5px] font-semibold text-primary">{badge}</span>}
      <span className="min-w-0 max-w-[200px] truncate">{att.name}</span>
      <span className="shrink-0 font-mono text-muted-foreground">{formatBytes(att.size)}</span>
      <button
        type="button"
        aria-label={t('mail.attachment.remove', { name: att.name })}
        className="relative grid h-6 w-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring before:absolute before:left-1/2 before:top-1/2 before:h-10 before:w-10 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
        onClick={() => onRemove?.()}
      ><UiIcon name="close" className="h-3 w-3" strokeWidth={2.4} /></button>
    </span>
  )
}

export default MailComposeAttachment
