/**
 * 설정 카드 안 "제목 + 설명 · 오른쪽 컨트롤" 한 줄.
 * 기본(stack): min 56, 13px, 제목 600 + 설명 muted. 좁은 화면(sm 미만)에서는 컨트롤이 아래로 이동한다(선택 200 칸용).
 * inline: 한 줄 고정(min 48, py-2) — 스위치 등 소형 컨트롤용. 제목과 설명이 같은 줄(설명 앞 4px).
 * 행 사이 선은 부모(divide-y) 또는 border 클래스로 지정한다.
 *
 * @example <SettingsRow title="테마" description="밝게·어둡게·시스템"><UiSelect … className="w-full sm:w-[200px]" /></SettingsRow>
 */
import type { ReactNode } from 'react'
import { cn } from '~/lib/utils'

export interface SettingsRowProps {
  /** 행 제목(600) */
  title: ReactNode
  /** 제목 아래(stack) 또는 옆(inline) 설명 */
  description?: ReactNode
  /** stack = 좁으면 세로 배치(기본) · inline = 한 줄(스위치 행) */
  layout?: 'stack' | 'inline'
  /** 루트 class 추가(예: border-t border-border) */
  className?: string
  /** 오른쪽 컨트롤 */
  children?: ReactNode
}

export function SettingsRow({ title, description, layout = 'stack', className, children }: SettingsRowProps) {
  if (layout === 'inline') {
    return (
      <div className={cn('flex min-h-12 items-center gap-3 px-5 py-2 text-[13px]', className)}>
        <span className="min-w-0 flex-1">
          <b className="font-semibold text-foreground">{title}</b>
          {description != null && <span className="ml-1 text-muted-foreground">{description}</span>}
        </span>
        {children}
      </div>
    )
  }
  return (
    <div className={cn('flex min-h-14 flex-col gap-2 px-5 py-3 text-[13px] sm:flex-row sm:items-center sm:gap-3', className)}>
      <div className="flex-1"><div className="font-semibold text-foreground">{title}</div>{description != null && <div className="text-muted-foreground">{description}</div>}</div>
      {children}
    </div>
  )
}

export default SettingsRow
