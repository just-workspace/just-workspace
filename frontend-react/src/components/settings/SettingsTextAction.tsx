/**
 * 설정 화면의 글자형 동작 버튼(12/600, 기본 danger).
 * 예: 로그인된 기기 "로그아웃" · "다른 기기 모두 로그아웃", 2단계 인증 "끄기".
 * 클릭 영역은 ::after 로 사방 12px 확장한다(after:-inset-3). type="button" 고정.
 *
 * @example <SettingsTextAction disabled={busy} onClick={revoke}>로그아웃</SettingsTextAction>
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'

export interface SettingsTextActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** 글자 색 — danger(기본) · primary */
  tone?: 'danger' | 'primary'
  children?: ReactNode
}

export function SettingsTextAction({ tone = 'danger', className, children, ...rest }: SettingsTextActionProps) {
  return (
    <button
      {...rest}
      type="button"
      className={cn(
        "relative shrink-0 text-xs font-semibold hover:underline after:absolute after:-inset-3 after:content-[''] disabled:opacity-50",
        tone === 'danger' ? 'text-danger' : 'text-primary',
        className,
      )}
    >{children}</button>
  )
}

export default SettingsTextAction
