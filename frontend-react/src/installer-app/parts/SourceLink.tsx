/**
 * "소스 코드" 링크 — 이 제품의 소스가 있는 곳과 라이선스. 주소는 설치 관리자가 준다(`GET /api/state` 의 info.source_url).
 * 세션이 없어 주소를 모르면 아무것도 그리지 않는다.
 */
import { useT } from '../i18n'
import { useWizard } from '../store'

export function SourceLink({ className = '' }: { className?: string }) {
  const t = useT()
  const url = useWizard(s => s.server?.info.source_url ?? null)
  if (!url || !/^https?:\/\/[^\s"'<>]+$/i.test(url)) return null
  return (
    <p data-testid="source-link" className={`m-0 text-[11px] text-muted-foreground ${className}`}>
      <a href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">{t('sourceCode')}</a>
      <span aria-hidden="true"> · </span>{t('licenseId')}
    </p>
  )
}
