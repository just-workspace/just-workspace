/**
 * 상태 칩("상태 칩 — 아이콘 + 글자, Git·작업·회의 공용"):
 * 각진 22(6px) 틴트 + 12/600 + 아이콘 12. 열림 success · 닫힘 중립 · 병합 primary · 진행 중 warning.
 * 아이콘(원+점 · 원+체크 · 병합 가지 · 반원)은 WorkStateIcon.
 */
import type { HTMLAttributes } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { WorkStateIcon, type WorkState } from './WorkStateIcon'

const META = {
  open: { labelKey: 'tasks.workState.open', cls: 'bg-success/15 text-success' },
  closed: { labelKey: 'tasks.workState.closed', cls: 'bg-muted text-foreground/85' },
  merged: { labelKey: 'tasks.workState.merged', cls: 'bg-primary/15 text-primary' },
  progress: { labelKey: 'tasks.workState.progress', cls: 'bg-warning/15 text-warning' },
} as const

export interface WorkStateChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** 열림 · 닫힘 · 병합 · 진행 중 */
  state: WorkState
  /** 글자(없으면 상태 기본 이름) */
  label?: string
  /** 18(행 안) · 22(기본) */
  size?: 18 | 22
}

/** 상태 칩(아이콘 + 글자). Git 이슈·PR 머리·목록에서 쓴다 */
export function WorkStateChip({ state, label, size = 22, className, ...rest }: WorkStateChipProps) {
  const { t } = useI18n()
  const meta = META[state]
  return (
    <span
      {...rest}
      className={cn(
        'inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap font-semibold leading-none',
        meta.cls,
        size === 18 ? 'h-[18px] rounded-[5px] px-1.5 text-[11px]' : 'h-[22px] rounded-[6px] px-2 text-xs',
        className,
      )}
    >
      <WorkStateIcon state={state} className="h-3 w-3" />
      {label ?? t(meta.labelKey)}
    </span>
  )
}

export default WorkStateChip
