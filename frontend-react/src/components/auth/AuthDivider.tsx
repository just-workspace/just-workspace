/**
 * "또는" 구분선(Vue components/auth/AuthDivider.vue · 시안 AuthForm:21): 12px muted, 양쪽 1px border.
 * 아래에 outline 44 보조 진입 버튼이 세로로 쌓인다(8-3-3).
 */
import { useI18n } from '~/i18n'

export interface AuthDividerProps {
  /** 기본 authScreens.login.or("또는") */
  label?: string
}

export function AuthDivider({ label }: AuthDividerProps) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
      <span className="h-px flex-1 bg-border" />{label ?? t('authScreens.login.or')}<span className="h-px flex-1 bg-border" />
    </div>
  )
}

export default AuthDivider
