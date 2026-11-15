/**
 * 앱 레일(시안 ShellRail · Shell Handoff 1e · 답변서 C4) — 데스크톱 왼쪽 모듈 목록. 스토어 없이 props 만으로 그린다.
 * (자세한 설명·예시는 아래 컴포넌트 JSDoc)
 */
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { useInRouterContext } from 'react-router'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { iconPaths } from '~/utils/icons'
import { NuxtLink } from '~/components/NuxtLink'
import { UiStatusDot } from './StatusDot'

export interface UiAppRailItem {
  /** 고유 id(모듈 id) */
  id: string
  /** 이름(툴팁·aria-label·wide 글자) */
  label: string
  /** utils/icons 이름(레일 아이콘 18, 선 1.9) */
  icon?: string
  /** 이동 경로 */
  to: string
  /** 현재 화면 */
  active?: boolean
  /** 숫자 배지(0·빈 값이면 숨김, 99 넘으면 99+) */
  badge?: number | string
  /** aria-label(예: 배지가 있을 때 "채팅 — 나를 부른 것 5개"). 없으면 label */
  ariaLabel?: string
  /** 초록 live 점(통화 중) */
  live?: boolean
  /** live 점 접근성 이름(기본 "통화 중") */
  liveLabel?: string
  /** 바깥 출처로 새 탭(target=_blank, rel=noopener) — 오른쪽 12 external-link 아이콘 + 툴팁 "새 탭에서 열기"(handover-netlab 답) */
  external?: boolean
}

export interface UiAppRailGroup {
  /** 고유 키 */
  key: string
  /** 묶음 머리글(wide 에서 11/600 대문자 간격) — 없으면 머리글·구분선 없이(맨 위 홈 묶음) */
  label?: string
  items: UiAppRailItem[]
}

export interface UiAppRailProps {
  /** 확장(236) — false 면 레일(64) */
  wide?: boolean
  /** 브랜드: 이름(wide 글자·로고 alt) · 태그라인 · 로고 이미지 · 로고 없을 때 첫 글자(기본 이름 첫 글자) · 이동 경로(기본 '/') */
  brand?: { name: string; tagline?: string; logo?: string; initial?: string; to?: string }
  /** 묶음 목록(위→아래) */
  groups?: UiAppRailGroup[]
  /** 묶음 없이 항목만(머리글·구분선 없는 한 묶음) — groups 가 있으면 무시 */
  items?: UiAppRailItem[]
  /** 맨 아래 아바타 자리(26 아바타 + 상태점 링크 등). 없으면 바닥 줄을 그리지 않는다(wide 이고 footerAction 이 있으면 그것만 그린다) */
  avatar?: ReactNode
  /** wide 일 때 아바타 옆 이름 */
  userName?: string
  /** wide 일 때 바닥 줄 오른쪽 끝(사이드바 고정 버튼 등) */
  footerAction?: ReactNode
  /** 아바타 줄 위에 끼우는 조각(예: 음성채널 접속 바 — handover-20 답 §5.2). 폭은 레일/확장 그대로, 가로 여백 없이 */
  footerSlot?: ReactNode
  /** 항목·브랜드를 눌렀을 때(오버레이 확장을 닫는 등) */
  onNavigate?: (item: UiAppRailItem | null, e: MouseEvent) => void
  /** <aside> class(폭·위치 덮어쓰기) */
  className?: string
  /** nav 접근성 이름(기본 없음) */
  ariaLabel?: string
}

function RailIcon({ name, className }: { name?: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: iconPaths(name) }}
    />
  )
}

function RailLink({ to, inRouter, ...rest }: { to: string; inRouter: boolean } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return inRouter ? <NuxtLink to={to} {...rest} /> : <a href={to} {...rest} />
}

const badgeText = (b: number | string) => (typeof b === 'number' && b > 99 ? '99+' : String(b))
const hasBadge = (b: number | string | undefined) => b !== undefined && b !== '' && b !== 0

/**
 * 앱 레일(시안 ShellRail · Shell Handoff 1e · 답변서 C4) — 데스크톱 왼쪽 모듈 목록. 스토어 없이 props 만으로 그린다.
 * wide=false → 레일 64(아이콘 타일 26 + 묶음 사이 구분선), wide=true → 확장 236(아이콘 20 + 이름 + 묶음 머리글).
 *
 * 항목: 34 높이 · 활성 = 왼쪽 2×14 primary 막대 + 아이콘 타일 primary/16 · primary 글자(wide 는 행 바탕 primary/13 + 600).
 * 배지(badge): primary 숫자 알약 18(99 넘으면 99+) — 레일은 아이콘 오른쪽 위(card 2px 테두리), wide 는 행 오른쪽 끝.
 * live: 초록 상태 점(통화 중) — 레일 10(card 링) · wide 8.
 * 맨 위 브랜드(로고 타일 26 + wide 일 때 이름·태그라인), 맨 아래 아바타 슬롯(+ wide 일 때 이름·footerAction).
 *
 * 데이터·스토어 연결(현재 경로로 active 정하기, 채팅 멘션 수, 통화 상태 등)은 쓰는 쪽(layout/Sidebar)이 한다.
 * 링크: 라우터 안이면 앱 링크(NuxtLink), 라우터 밖(디자인 툴 등)이면 일반 <a href>.
 *
 * @example
 * <UiAppRail
 *   wide={false}
 *   brand={{ name: 'Workspace', tagline: 'self-hosted workspace' }}
 *   groups={[
 *     { key: 'home', items: [{ id: 'home', label: '홈', icon: 'home', to: '/', active: true }] },
 *     { key: 'talk', label: '소통', items: [{ id: 'chat', label: '채팅', icon: 'chat', to: '/chat', badge: 5 }, { id: 'meetings', label: '회의', icon: 'video', to: '/meetings', live: true }] },
 *   ]}
 *   avatar={<UiAvatar fallback="하" className="h-[26px] w-[26px]" textSize={11} />}
 * />
 */
export function UiAppRail({ wide = false, brand, groups, items, avatar, userName, footerAction, footerSlot, onNavigate, className, ariaLabel }: UiAppRailProps) {
  const { t } = useI18n()
  const inRouter = useInRouterContext()
  const list: UiAppRailGroup[] = groups ?? (items ? [{ key: 'items', items }] : [])
  const brandInitial = brand?.initial ?? (brand?.name || 'W').charAt(0).toUpperCase()

  const itemClass = (it: UiAppRailItem) => cn(
    'relative flex h-[34px] shrink-0 items-center gap-2.5 rounded-md',
    wide ? 'px-2' : 'justify-center px-0',
    it.active ? 'text-foreground' : 'text-muted-foreground hover:bg-accent/50',
    it.active && wide ? 'bg-primary/[0.13] font-semibold' : '',
  )
  const tileClass = (it: UiAppRailItem) => cn(
    'grid shrink-0 place-items-center rounded-md',
    wide ? 'h-5 w-5' : 'h-[26px] w-[26px]',
    it.active ? 'bg-primary/[0.16] text-primary' : '',
  )
  const labelClass = cn('min-w-0 truncate text-[13.5px] transition-opacity', wide ? 'opacity-100 delay-75 duration-100' : 'pointer-events-none opacity-0 duration-75')

  const renderItem = (it: UiAppRailItem) => (
    <RailLink
      key={it.to + it.id}
      to={it.to}
      inRouter={inRouter && !it.external}
      {...(it.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      aria-label={it.external ? `${it.ariaLabel ?? it.label} — ${t('ui.rail.newTab')}` : (it.ariaLabel ?? it.label)}
      aria-current={it.active ? 'page' : undefined}
      title={it.external ? `${t('ui.rail.newTab')} · ${it.label}` : (!wide ? it.label : undefined)}
      className={itemClass(it)}
      onClick={e => onNavigate?.(it, e)}
    >
      {it.active && <span className="absolute left-0 h-3.5 w-0.5 rounded-full bg-primary" />}
      <span className={tileClass(it)}>
        <RailIcon name={it.icon} className="h-[18px] w-[18px]" />
      </span>
      <span className={labelClass}>{it.label}</span>
      {it.external && wide && <RailIcon name="external-link" className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />}
      {hasBadge(it.badge) && (
        <span
          className={wide
            ? 'ml-auto inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1 font-mono text-[11px] font-bold text-primary-foreground'
            : 'absolute -top-[3px] -right-px inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-card bg-primary px-1 font-mono text-[11px] font-bold text-primary-foreground'}
        >{badgeText(it.badge!)}</span>
      )}
      {it.live && (
        <UiStatusDot
          status="live"
          size={wide ? 8 : 10}
          label={it.liveLabel ?? t('shell.sidebar.inCall')}
          ring={wide ? 'none' : 'card'}
          className={wide ? 'ml-auto' : 'absolute right-1 top-0.5'}
        />
      )}
    </RailLink>
  )

  return (
    <aside className={cn('flex h-full flex-col gap-4 overflow-hidden border-r border-border bg-card px-3 py-4', wide ? 'w-sidebar' : 'w-sidebar-rail', className)}>
      {/* 브랜드: rail 에서는 로고 타일만, wide 에서 텍스트가 따라온다 */}
      {brand && (
        <RailLink to={brand.to ?? '/'} inRouter={inRouter} className="flex items-center gap-2.5 px-1.5" onClick={e => onNavigate?.(null, e)}>
          <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md bg-secondary text-[12px] font-semibold text-foreground">
            {brand.logo ? <img src={brand.logo} alt={brand.name} className="h-5 w-5 object-contain" /> : <span>{brandInitial}</span>}
          </span>
          <div className={cn('flex min-w-0 flex-col transition-opacity duration-100', wide ? 'opacity-100' : 'pointer-events-none opacity-0')}>
            <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">{brand.name}</span>
            {brand.tagline != null && <span className="truncate text-[11px] text-muted-foreground">{brand.tagline}</span>}
          </div>
        </RailLink>
      )}

      <nav aria-label={ariaLabel} className="flex flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden scrollbar-none">
        {list.map(g => (
          <div key={g.key} className="flex flex-col gap-0.5">
            {g.label != null && (wide
              ? <div className="px-2 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground/80">{g.label}</div>
              : <div className="mx-2 my-0.5 h-px bg-border" />)}
            {g.items.map(renderItem)}
          </div>
        ))}
      </nav>

      {/* 하단 끼움(접속 바 등 — handover-20) — aside 의 px-3 를 상쇄해 가로 끝까지 */}
      {footerSlot != null && <div className="-mx-3 mt-auto shrink-0">{footerSlot}</div>}

      {/* 하단: 아바타 + (wide) 이름·오른쪽 액션 */}
      {(avatar != null || (wide && footerAction != null)) && (
        <div className={cn('flex items-center gap-2.5 border-t border-border pt-2.5', footerSlot == null ? 'mt-auto' : '', wide ? 'px-2' : 'justify-center px-0')}>
          {avatar}
          {avatar != null && wide && userName != null && <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{userName}</span>}
          {wide && footerAction != null && <span className="ml-auto shrink-0">{footerAction}</span>}
        </div>
      )}
    </aside>
  )
}

export default UiAppRail
