/**
 * 첨부 한도 막대: 80×4 · "1.1 / 15 MB" mono. 90% 초과 시 warning.
 */
import { useI18n } from '~/i18n'
// class 를 단순 연결(tailwind-merge 를 사용하는 cn 은 leading-[1.35]+text-xl 같은 조합을 제거함)
import { clsx as cx } from 'clsx'

const MB = 1024 * 1024

export interface MailComposeQuotaProps {
  /** 사용 바이트 */
  used: number
  /** 한도 바이트 */
  max: number
  /** 업로드 중 */
  uploading?: boolean
}

/** 첨부 용량 막대 */
export function MailComposeQuota({ used, max, uploading }: MailComposeQuotaProps) {
  const { t } = useI18n()
  const pct = Math.min(100, (used / max) * 100)
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[11px] text-muted-foreground" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={t('mail.attachment.quota')}>
      <span className="h-1 w-20 overflow-hidden rounded-full bg-muted">
        <span className={cx('block h-full rounded-full', pct > 90 ? 'bg-warning' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </span>
      {`${(used / MB).toFixed(1)} / ${Math.round(max / MB)} MB`}
      {uploading && <span className="font-sans">{`· ${t('mail.attachment.uploading')}`}</span>}
    </span>
  )
}

export default MailComposeQuota
