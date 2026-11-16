/**
 * 관리 페이지 틀.
 * 본문 패딩 24/28, 헤더형(h1 24/700 −0.02em + 부제 13.5 + 오른쪽 행동),
 * 표·분석은 전체 폭 사용(기존 max-w-content 1400 왼쪽 정렬은 폐기), 설정 폼은 720, 모듈 목록은 960.
 * 모바일은 셸의 상세 상단 바가 제목을 담당하므로 h1 을 숨기고 부제·행동만 한 줄로 표시.
 *
 * @example <AdminPageShell title="사용자" subtitle="…" actions={<UiButton>초대</UiButton>}>…</AdminPageShell>
 */
import type { ReactNode } from 'react'
import { cn } from '~/lib/utils'

export interface AdminPageShellProps {
  /** 페이지 제목(데스크톱 h1) */
  title: string
  /** 제목 아래 부제(모바일에서도 표시) */
  subtitle?: string
  /** content = 표·분석(전체 폭) · form = 설정 폼 720 · wide = 모듈 목록 960 (기본 content) */
  width?: 'content' | 'form' | 'wide'
  /** 헤더 오른쪽 행동 버튼 */
  actions?: ReactNode
  /** 본문 */
  children?: ReactNode
}

export function AdminPageShell({ title, subtitle, width = 'content', actions, children }: AdminPageShellProps) {
  return (
    <div className="px-4 py-4 md:px-7 md:py-6">
      <div
        className={cn(
          'flex flex-col',
          width === 'form' ? 'max-w-[720px] gap-3.5' : width === 'wide' ? 'max-w-[960px] gap-4' : 'gap-4',
        )}
      >
        <div className="flex flex-wrap items-end gap-3 md:mb-0.5">
          <div className="hidden min-w-0 flex-1 md:block">
            <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">{title}</h1>
            {subtitle && <p className="mt-1 text-[13.5px] text-muted-foreground">{subtitle}</p>}
          </div>
          {subtitle && <p className="w-full text-[13px] text-muted-foreground md:hidden">{subtitle}</p>}
          {actions != null && actions !== false && (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
        {children}
      </div>
    </div>
  )
}

export default AdminPageShell
