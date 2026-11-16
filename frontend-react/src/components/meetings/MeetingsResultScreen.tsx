/**
 * 회의 결과 화면 1틀.
 *  모바일: 회의 머리 56(제목 17/600 "회의", 비밀번호 틀림만 "회의 입장") + 본문이 세로 가운데(패딩 24 · 간격 14)
 *          아이콘 타일 40(반지름 10) → 제목 22/700 → 설명 15/1.6 muted → (children: 입력·[1차 48][2차 48 outline]).
 *  데스크톱(lg↑): 동일 내용을 왼쪽 패널(520) 위치에 배치 — 입장 화면(MeetingsDeviceSetup)과 동일한 520 패널
 *          (48/60 패딩, 오른쪽 경계선, 세로 가운데, 간격 18) 맨 위에 브랜드 줄(타일 28 + 앱 이름 15/600), 제목 24/700.
 *  인증 화면 틀(AuthShell: 월페이퍼 띠·브랜드 머리)은 사용하지 않는다.
 *  아이콘 타일: 만료 warning · 거절 danger · 종료 muted.
 *  시안 모바일 머리 오른쪽 "더보기"는 결과 화면에서 수행할 동작이 정의되지 않아 배치하지 않는다(입장 화면 머리와 동일).
 *  데스크톱 오른쪽: aside 지정 시 bg-stage 가운데에 표시한다(회의 종료 "이번 회의" 요약 카드). 미지정 시 공백.
 */
import type { ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { UiIcon } from '~/components/ui/Icon'

export interface MeetingsResultScreenProps {
  /** 제목(22/700, 데스크톱 24) */
  title: string
  /** 설명(15/1.6 muted) */
  description?: string
  /** 아이콘 타일 아이콘(기본 clock) */
  icon?: string
  /** 아이콘 타일 색(기본 warning) */
  tone?: 'success' | 'warning' | 'danger' | 'primary' | 'muted'
  /** 최하단 보조 안내 */
  note?: string
  /** 모바일 머리 제목(기본 "회의") */
  header?: string
  /** 입력·버튼(세로 간격 10) */
  children?: ReactNode
  /** 데스크톱 오른쪽 stage 가운데 내용(예: MeetingsEndSummary). 모바일에서는 표시하지 않는다 */
  aside?: ReactNode
}

const TONE = {
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  primary: 'bg-primary/15 text-primary',
  muted: 'bg-muted text-muted-foreground',
}

/** 회의 결과 화면(만료·거절·종료·비밀번호 불일치·실패) */
export function MeetingsResultScreen({ title, description, icon = 'clock', tone = 'warning', note, header, children, aside }: MeetingsResultScreenProps) {
  const { appName, brandLogo } = useSiteConfig()
  const { t } = useI18n()
  const brandInitial = (appName || 'W').trim().charAt(0).toUpperCase()
  const headerText = header || t('meetings.join.resultHeader')

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground lg:flex-row">
      {/* 모바일 머리 56 */}
      <header className="flex h-14 shrink-0 items-center border-b border-border px-4 lg:hidden" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{headerText}</h1>
      </header>

      {/* 본문: 모바일은 세로 가운데, 데스크톱은 520 왼쪽 패널 */}
      <main className="flex flex-1 flex-col justify-center gap-3.5 p-6 lg:w-[520px] lg:flex-none lg:shrink-0 lg:gap-[18px] lg:border-r lg:border-border lg:px-[60px] lg:py-12">
        <div className="hidden items-center gap-2.5 lg:flex">
          {brandLogo
            ? <img src={brandLogo} alt="" className="h-7 w-7 rounded-sm object-cover" />
            : <span className="grid h-7 w-7 place-items-center rounded-sm bg-primary text-[13px] font-bold text-primary-foreground" aria-hidden="true">{brandInitial}</span>}
          <span className="text-[15px] font-semibold">{appName}</span>
        </div>

        <span className={cn('grid h-10 w-10 place-items-center rounded-[10px]', TONE[tone])}>
          <UiIcon name={icon} className="h-5 w-5" />
        </span>
        <h2 className="text-[22px] font-bold lg:text-2xl lg:tracking-[-0.02em]">{title}</h2>
        {description && <p className="text-[15px] leading-[1.6] text-muted-foreground [word-break:keep-all]">{description}</p>}

        <div className="flex flex-col gap-2.5">
          {children}
        </div>
        {note && <p className="text-xs leading-[1.7] text-muted-foreground">{note}</p>}
      </main>

      {/* 데스크톱 오른쪽: 입장 화면 미리보기 자리 — 요약(aside)이 있으면 stage 가운데에 표시, 없으면 공백 */}
      {aside
        ? <aside className="hidden flex-1 items-center justify-center bg-stage p-12 lg:flex">{aside}</aside>
        : <div className="hidden flex-1 lg:block" aria-hidden="true" />}
    </div>
  )
}

export default MeetingsResultScreen
