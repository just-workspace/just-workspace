/**
 * 모바일 설정 첫 화면 조각 — Vue pages/settings/index.vue 의 인라인 마크업을 이름 붙여 뺀 것.
 *  · SettingsProfileHead — 아바타 52 + 이름 16/600 + 이메일 13 muted
 *  · SettingsNavGroupCard — 그룹 머리(11/600 0.08em) + 카드 안 52 행(이름 15 + 보조 글자 13 muted + ›)
 */
import { NuxtLink } from '~/components/NuxtLink'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiIcon } from '~/components/ui/Icon'

export interface SettingsProfileHeadProps {
  /** 아바타 이미지 주소 */
  avatarUrl?: string | null
  /** 표시 이름(첫 글자가 아바타 대체 글자) */
  name: string
  /** 이메일 줄 */
  email?: string | null
}

/** 모바일 설정 목록 머리 — 아바타 52 + 이름 + 이메일 */
export function SettingsProfileHead({ avatarUrl, name, email }: SettingsProfileHeadProps) {
  return (
    <div className="flex items-center gap-3 px-1 pb-2">
      <UiAvatar src={avatarUrl} alt={name} fallback={name.charAt(0).toUpperCase()} className="h-[52px] w-[52px] text-lg" />
      <div className="min-w-0">
        <div className="truncate text-base font-semibold text-foreground">{name}</div>
        <div className="truncate text-[13px] text-muted-foreground">{email}</div>
      </div>
    </div>
  )
}

export interface SettingsNavGroupCardItem {
  /** 이동 경로 */
  to: string
  /** 항목 이름 */
  label: string
  /** 오른쪽 보조 글자(빈 문자열이면 없음) */
  meta?: string
}

export interface SettingsNavGroupCardProps {
  /** 그룹 이름 */
  label: string
  /** 그룹 항목 */
  items: SettingsNavGroupCardItem[]
}

/** 모바일 설정 목록의 그룹 하나 — 머리 + 52 행 카드 */
export function SettingsNavGroupCard({ label, items }: SettingsNavGroupCardProps) {
  return (
    <>
      <div className="px-1 pb-1 pt-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="rounded-lg border border-border bg-card">
        {items.map(it => (
          <NuxtLink
            key={it.to}
            to={it.to}
            className="flex min-h-[52px] items-center gap-3 border-b border-border pl-4 pr-3 text-[15px] text-foreground last:border-b-0"
          >
            <span className="flex-1">{it.label}</span>
            {it.meta && <span className="text-[13px] text-muted-foreground">{it.meta}</span>}
            <UiIcon name="chevron-right" className="h-4 w-4 text-muted-foreground" strokeWidth={2.4} />
          </NuxtLink>
        ))}
      </div>
    </>
  )
}
