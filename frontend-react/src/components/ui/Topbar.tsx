/**
 * 상단바(시안 ShellTop · 8-1 · 답변서 C4) — 높이 56, 바탕 background, 아래 테두리. 스토어 없이 props 만으로 그린다.
 * (자세한 설명·예시는 아래 컴포넌트 JSDoc)
 */
import type { CSSProperties, ReactNode, Ref } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIconButton } from './IconButton'
import { UiIcon } from './Icon'
import { UiKeycap } from './Keycap'
import { UiAvatar } from './Avatar'
import { UiStatusDot } from './StatusDot'

export interface UiTopbarProps {
  /** 경로 칸(최대 3: 워크스페이스 / 모듈 / 위치). 마지막 칸이 600 굵게, 3칸일 때 가운데는 foreground/85 */
  crumbs?: string[]
  /** 모바일 모양(제목 한 줄) */
  mobile?: boolean
  /** 모바일 제목(기본 = crumbs 마지막 칸) */
  title?: string
  /** 사이드바 고정 상태(aria-pressed) */
  pinned?: boolean
  /** 사이드바 고정 토글 — 있을 때만 데스크톱 왼쪽 버튼을 그린다 */
  onTogglePin?: () => void
  /** 고정 버튼 이름(기본: 고정 중 "사이드바 고정 풀기" / 아니면 "사이드바 고정") */
  pinLabel?: string
  /** 이동·검색 열기 — 있을 때만 검색 버튼(데스크톱 240 · 모바일 아이콘) */
  onSearch?: () => void
  /** 모바일 검색 아이콘 숨김(확장 액션이 돋보기를 가졌을 때) */
  hideMobileSearch?: boolean
  /** 벨(활동) 열기 — 있을 때만 데스크톱 벨 */
  onBell?: () => void
  /** 벨 숫자(0 이면 배지 없음, 99 넘으면 99+) */
  bellCount?: number
  /** 활동 패널 열림(aria-pressed) */
  bellPressed?: boolean
  /** 벨 이름(기본: 수가 있으면 "활동 — 안 읽은 n개", 없으면 "활동") */
  bellLabel?: string
  /** 확장 액션 자리(검색 앞) — 아이콘 버튼·칩 */
  actions?: ReactNode
  /** 기본 아바타 버튼의 사용자(이름·사진·상태점 상태) */
  user?: { name: string; avatarUrl?: string | null; status?: string }
  /** 아바타 버튼 눌렀을 때 */
  onAvatarClick?: () => void
  /** 사용자 메뉴 열림(aria-expanded) */
  avatarExpanded?: boolean
  /** 아바타 버튼 아래 붙는 메뉴(열림 애니메이션 포함해 쓰는 쪽이 그린다) */
  avatarMenu?: ReactNode
  /** 아바타 버튼 + 메뉴를 감싼 상자 ref(바깥 클릭 닫기용) */
  avatarRef?: Ref<HTMLDivElement>
  /** 아바타 자리를 통째로 바꾸기 */
  avatar?: ReactNode
  /** 노치(safe-area) 위 여백을 주지 않기(위에 다른 띠가 이미 줬을 때) */
  noSafeTop?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * 상단바(시안 ShellTop · 8-1 · 답변서 C4) — 높이 56, 바탕 background, 아래 테두리. 스토어 없이 props 만으로 그린다.
 *
 * 데스크톱(mobile=false):
 *   [사이드바 고정 32(onTogglePin 이 있을 때, aria-pressed, Ctrl \)] 경로 3단(워크스페이스 / 모듈 / 위치 — 12, 마지막 칸 600)
 *   … [확장 액션 슬롯] [이동하거나 검색 240 + Ctrl K 키캡(onSearch)] [벨 36 테두리 + primary 숫자 배지(onBell)] [아바타 32 + 상태점]
 * 모바일(mobile=true): 제목 한 줄(16/600, 기본 = 경로 마지막 칸) + [확장 액션] + 검색 아이콘 44(hideMobileSearch 로 숨김) + 아바타.
 *   벨은 그리지 않는다(활동은 탭바 "활동" 탭).
 *
 * 아바타: `user` 를 주면 기본 아바타 버튼(32 + 상태점, aria-haspopup=menu)을 그리고 `avatarMenu` 를 그 아래 붙인다
 * (avatarRef 는 버튼·메뉴를 감싼 상자 — 바깥 클릭 판정용). 완전히 다른 것을 그리려면 `avatar` 슬롯.
 * 문구 기본값은 i18n(shell.topbar.* · shell.palette.*) — 바꾸려면 *Label props.
 *
 * @example
 * <UiTopbar crumbs={['워크스페이스', '메일', '받은편지함']} pinned={false} onTogglePin={…} onSearch={openPalette}
 *   bellCount={7} onBell={toggleActivity} user={{ name: '하나', status: 'online' }} onAvatarClick={…} />
 */
export function UiTopbar({
  crumbs = [], mobile = false, title, pinned = false, onTogglePin, pinLabel, onSearch, hideMobileSearch = false,
  onBell, bellCount = 0, bellPressed = false, bellLabel, actions, user, onAvatarClick, avatarExpanded = false, avatarMenu, avatarRef, avatar,
  noSafeTop = false, className, style,
}: UiTopbarProps) {
  const { t } = useI18n()
  const last = crumbs.length - 1
  const mobileTitle = title ?? crumbs[last] ?? ''
  const bellName = bellLabel ?? (bellCount > 0 ? t('shell.topbar.bellUnread', { n: bellCount }) : t('shell.activity.title'))

  return (
    <header
      // 사용자 메뉴가 열린 동안은 헤더를 서랍(z-drawer) 위로 — 메뉴는 이 헤더의 쌓임 맥락에 갇혀 있어,
      // 평소 값(z-dropdown)이면 본문 오른쪽 패널(활동·작업 상세·발신자 패널)에 가려 안 보였다.
      className={cn('relative flex h-topbar shrink-0 items-center justify-between gap-3 border-b border-border bg-background pl-4 pr-4 lg:pl-4 lg:pr-6', avatarExpanded ? 'z-topbar-open' : 'z-dropdown', className)}
      style={noSafeTop ? style : { paddingTop: 'env(safe-area-inset-top)', ...style }}
    >
      {/* 왼쪽: 사이드바 고정 + 3단 경로(데스크톱) / 제목(모바일) */}
      <div className="flex min-w-0 items-center gap-2">
        {!mobile && onTogglePin && (
          <UiIconButton
            label={pinLabel ?? (pinned ? t('shell.topbar.unpinSidebar') : t('nav.pin'))}
            icon="panel-left"
            keys={['Ctrl', '\\']}
            pressed={pinned}
            className="-ml-1 rounded-md [&>svg]:h-[18px] [&>svg]:w-[18px]"
            onClick={onTogglePin}
          />
        )}
        {!mobile ? (
          <nav aria-label={t('shell.topbar.breadcrumb')} className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {crumbs.map((c, i) => (
              <Crumb key={i} index={i} last={last} text={c} />
            ))}
          </nav>
        ) : (
          <h1 className="truncate text-base font-semibold text-foreground">{mobileTitle}</h1>
        )}
      </div>

      {/* 오른쪽 */}
      <div className="flex items-center gap-2.5">
        {actions}
        {/* 이동·검색 (Ctrl K) */}
        {/* 모양은 화면 폭이 아니라 mobile 로 정한다(디자인 툴·좁은 데스크톱 창에서도 시안대로) */}
        {onSearch && !mobile && (
          <button
            type="button"
            aria-label={t('shell.topbar.paletteButton')}
            className="flex h-8 w-60 items-center gap-2 rounded-md border border-border bg-card pl-2.5 pr-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={onSearch}
          >
            <UiIcon name="search" className="h-3.5 w-3.5" />
            <span>{t('shell.palette.inputLabel')}</span>
            <span className="ml-auto flex gap-0.5"><UiKeycap size={20}>Ctrl</UiKeycap><UiKeycap size={20}>K</UiKeycap></span>
          </button>
        )}
        {onSearch && mobile && !hideMobileSearch && <UiIconButton label={t('shell.palette.dialogLabel')} icon="search" size="md" onClick={onSearch} />}

        {/* 활동(벨) → 우측 패널. 모바일은 탭바 "활동" 탭 */}
        {onBell && !mobile && (
          <UiIconButton
            label={bellName}
            variant="outline"
            pressed={bellPressed}
            className="relative h-9 w-9 rounded-md [&>svg]:h-[18px] [&>svg]:w-[18px]"
            onClick={onBell}
          >
            <UiIcon name="bell" />
            {bellCount > 0 && (
              <span
                className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-background bg-primary px-1 font-mono text-[11px] font-bold text-primary-foreground"
              >{bellCount > 99 ? '99+' : bellCount}</span>
            )}
          </UiIconButton>
        )}

        {/* 사용자 메뉴 */}
        {avatar ?? (user && (
          <div ref={avatarRef} className="relative">
            <button
              type="button"
              aria-label={t('shell.topbar.userMenuFor', { name: user.name })}
              aria-haspopup="menu"
              aria-expanded={avatarExpanded}
              className="relative grid h-8 w-8 place-items-center rounded-full ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={onAvatarClick}
            >
              <UiAvatar src={user.avatarUrl} alt={user.name} fallback={user.name.charAt(0).toUpperCase()} className="h-8 w-8" textSize={12} />
              {user.status && <UiStatusDot status={user.status} size={10} ring="background" className="absolute -bottom-px -right-px" />}
            </button>
            {avatarMenu}
          </div>
        ))}
      </div>
    </header>
  )
}

/** 경로 한 칸 — 첫 칸 앞에는 구분선 없음 */
function Crumb({ index, last, text }: { index: number; last: number; text: string }) {
  const sep = index > 0 && <span className="text-border" aria-hidden="true">/</span>
  // 3단: 첫 칸 회색 · 가운데 foreground/85 · 마지막 truncate 600 / 2단: 첫 칸 회색 · 마지막 600
  const cls = index === 0 && last > 0
    ? 'shrink-0'
    : index === last
      ? (index >= 2 ? 'truncate font-semibold text-foreground' : 'shrink-0 font-semibold text-foreground')
      : 'shrink-0 text-foreground/85'
  return <>{sep}<span className={cls}>{text}</span></>
}

export default UiTopbar
