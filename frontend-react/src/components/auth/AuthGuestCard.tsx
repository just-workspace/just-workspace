/**
 * 손님 진입 대상 카드(문서·회의 공용):
 * 아이콘 타일 40(primary/15) + 이름 14/600 + 보조 12 muted + 권한 틴트 배지.
 * OAuth 동의의 앱 카드(AuthForm:37)도 같은 틀 — icon 대신 initial/logo 를 넘긴다.
 */
import type { ReactNode } from 'react'
import { UiIcon } from '~/components/ui/Icon'
import { UiBadge } from '~/components/ui/Badge'

export interface AuthGuestCardProps {
  name: string
  meta?: string
  /** 보조 줄 자리 전체 — meta 대신 */
  metaSlot?: ReactNode
  /** utils/icons 이름(문서 file-text · 회의 video). 기본 file-text */
  icon?: string
  /** 아이콘 대신 글자 타일(앱 이름 첫 글자) */
  initial?: string
  /** 아이콘 대신 로고 이미지 */
  logo?: string
  badge?: string
  /** 기본 success */
  badgeTone?: 'success' | 'warning' | 'danger' | 'primary' | 'neutral'
  /** 이름을 링크로(동의 화면 client_uri) */
  href?: string
}

export function AuthGuestCard({ name, meta, metaSlot, icon = 'file-text', initial, logo, badge, badgeTone = 'success', href }: AuthGuestCardProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3.5">
      {logo
        ? <img src={logo} alt="" className="h-10 w-10 shrink-0 rounded-[10px] border border-border object-contain" />
        : (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-primary/15 font-bold text-primary">
            {initial ? initial : <UiIcon name={icon} className="h-5 w-5" />}
          </span>
        )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-foreground">
          {href
            ? <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">{name}</a>
            : name}
        </div>
        {(meta || metaSlot != null) && (
          <div className="truncate text-xs text-muted-foreground">
            {metaSlot ?? meta}
          </div>
        )}
      </div>
      {badge && <UiBadge tone={badgeTone} tint>{badge}</UiBadge>}
    </div>
  )
}

export default AuthGuestCard
