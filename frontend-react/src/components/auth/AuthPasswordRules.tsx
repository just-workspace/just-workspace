/**
 * 비밀번호 규칙 체크 목록:
 * 12px, 통과 = success 600 + ✓, 미통과 = muted + 빈 원 10px. 강도 미터 없음.
 * 규칙 판정은 utils/passwordRules.ts(백엔드 정책과 동일). aria-live 로 변화를 읽어 준다.
 */
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { PASSWORD_MIN, PASSWORD_RECOMMENDED, type PasswordRuleResult } from '~/utils/passwordRules'
import { UiIcon } from '~/components/ui/Icon'

export interface AuthPasswordRulesProps {
  results: PasswordRuleResult[]
  /** distinct 규칙 문구에 쓸 대상(아이디 / 이메일) */
  contextLabel?: string
  /** length 규칙 문구의 하한(기본 PASSWORD_MIN) — checkPasswordRules 에 준 값과 같게 */
  min?: number
}

export function AuthPasswordRules({ results, contextLabel, min = PASSWORD_MIN }: AuthPasswordRulesProps) {
  const { t } = useI18n()
  function label(r: PasswordRuleResult): string {
    switch (r.key) {
      case 'length':
        return r.ok ? t('authScreens.rules.length', { min }) : t('authScreens.rules.lengthNow', { min, n: r.n })
      case 'distinct':
        return t('authScreens.rules.distinct', { target: contextLabel || t('authScreens.rules.defaultTarget') })
      case 'recommended':
        return t('authScreens.rules.recommended', { n: PASSWORD_RECOMMENDED })
      case 'common':
        return t('authScreens.rules.common')
    }
  }

  return (
    <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs" aria-live="polite">
      {results.map(r => (
        <li
          key={r.key}
          className={cn('flex items-center gap-1', r.ok ? 'font-semibold text-success' : 'text-muted-foreground')}
        >
          {r.ok
            ? <UiIcon name="check" className="h-3 w-3" strokeWidth={3} />
            : <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full shadow-[inset_0_0_0_1.5px_currentColor]" />}
          <span>{label(r)}{!r.required && ' ' + t('common.optional')}</span>
        </li>
      ))}
    </ul>
  )
}

export default AuthPasswordRules
