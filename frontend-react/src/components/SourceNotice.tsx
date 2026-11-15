/**
 * "소스 코드" 링크 — 이 서비스가 돌리는 프로그램의 소스가 있는 곳과 라이선스.
 *
 * 이 프로그램은 AGPL-3.0-or-later 로 배포된다. 네트워크로 서비스를 쓰는 사람도 그 서버가 돌리는 판의 소스를
 * 얻을 수 있어야 하므로, 로그인 화면 바닥글과 설정·관리 화면에 이 줄을 둔다.
 * 주소는 서버가 준다(/api/health 의 source_url — 환경변수 JW_SOURCE_URL, 고쳐서 서비스하는 사람이 바꾼다).
 */
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { useSiteConfig } from '~/composables/useSiteConfig'

export interface SourceNoticeProps {
  /** compact = 링크 한 줄(로그인 바닥글) · full = 설명 한 줄 + 링크(설정·관리 화면) */
  variant?: 'compact' | 'full'
  className?: string
}

/** http(s) 주소만 링크로 쓴다 */
export function safeSourceUrl(url: string | null | undefined): string {
  const v = (url ?? '').trim()
  return /^https?:\/\/[^\s"'<>]+$/i.test(v) ? v : ''
}

export function SourceNotice({ variant = 'full', className }: SourceNoticeProps) {
  const { t } = useI18n()
  const { sourceUrl, license } = useSiteConfig()
  const href = safeSourceUrl(sourceUrl)
  if (!href) return null
  const link = (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
      {t('about.sourceCode')}
    </a>
  )
  if (variant === 'compact') {
    return (
      <p data-testid="source-notice" className={cn('text-center text-[11px] text-muted-foreground', className)}>
        {link}<span aria-hidden="true"> · </span><span>{license}</span>
      </p>
    )
  }
  return (
    <p data-testid="source-notice" className={cn('text-xs leading-relaxed text-muted-foreground', className)}>
      {t('about.licenseLine', { license })}{' '}{link}
    </p>
  )
}

export default SourceNotice
