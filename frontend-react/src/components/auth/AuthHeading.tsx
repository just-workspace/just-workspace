/**
 * 인증 폼 제목(Vue components/auth/AuthHeading.vue · 시안 8-3-1): 왼쪽 정렬 24/700 letter-spacing -0.02em + 보조 14 muted(위 6).
 * 40px 아이콘 타일은 결과 화면(재설정 완료·만료·오류)에만 — icon + tone 을 주면 제목 위에 붙는다.
 * 타일 반지름: 시안 11px 는 8-2-6 에서 사용 중지한 값 → 10px(디자이너 확인 필요).
 */
import type { ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { UiIcon } from '~/components/ui/Icon'

export interface AuthHeadingProps {
  title: string
  subtitle?: string
  /** 보조 문단 자리(Vue 기본 슬롯) — subtitle 대신 */
  children?: ReactNode
  /** utils/icons 이름. 결과 화면 전용 */
  icon?: string
  /** 기본 primary */
  tone?: 'success' | 'warning' | 'danger' | 'primary' | 'muted'
}

const TONE = {
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  primary: 'bg-primary/15 text-primary',
  // 회의 종료처럼 좋지도 나쁘지도 않은 결과(시안 WorkMobile meetOver)
  muted: 'bg-muted text-muted-foreground',
}

export function AuthHeading({ title, subtitle, children, icon, tone = 'primary' }: AuthHeadingProps) {
  return (
    <>
      {icon && (
        <span className={cn('grid h-10 w-10 place-items-center rounded-[10px]', TONE[tone])}>
          <UiIcon name={icon} className="h-5 w-5" strokeWidth={2.4} />
        </span>
      )}
      <div>
        <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">{title}</h1>
        {(subtitle || children != null) && (
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground [word-break:keep-all]">
            {children ?? subtitle}
          </p>
        )}
      </div>
    </>
  )
}

export default AuthHeading
