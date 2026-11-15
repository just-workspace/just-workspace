/**
 * 첨부 한도 막대 — Vue 판 components/mail/MailComposeQuota.vue (시안 ML2): 80×4 · "1.1 / 15 MB" mono. 90% 넘으면 warning.
 */
import { useI18n } from '~/i18n'
// Vue 의 class 묶음처럼 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지워 Vue 와 달라진다)
import { clsx as cx } from 'clsx'

const MB = 1024 * 1024

export interface MailComposeQuotaProps {
  /** 쓴 바이트 */
  used: number
  /** 한도 바이트 */
  max: number
  /** 올리는 중 */
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
