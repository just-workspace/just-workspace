/**
 * 작업 행(Vue components/tasks/TasksRow.vue · 시안 TK1:22 데스크톱 · WorkMobile tasksList 모바일 · 결정 작업 3).
 *  데스크톱 48: 원형 체크 18 · 제목 13.5/500 · 상태 칩(누르면 메뉴) · 우선순위(화살표+글자) · 하위 n/m(mono) · 마감(D-n, 지남 danger) · ⋮
 *  모바일 60: 체크 22 · 제목 15/500 + 메타 12(우선순위 · 상태 · 마감) · ⋮ 40
 * 색만 쓰던 2px 우선순위 바는 폐지. 선택 = primary/13(rounded-8).
 * 마지막 열 36 = 담당 아바타 24(시안 TK1). 행에 올리거나 포커스가 들어오면 같은 자리에 ⋮(시안 C 행 규격 hover ⋮).
 * 담당이 없으면 그 자리는 비고 ⋮ 만 hover 로.
 */
import type { KeyboardEvent, MouseEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import type { Task } from '~/composables/useTasks'
import { dueLabel, PRIORITY_META, STATUS_META, type TaskPriority, type TaskStatus } from '~/utils/taskQuick'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'

export interface TasksRowProps {
  task: Task
  selected?: boolean
  /** 행 선택(상세 열기) */
  onSelect?: () => void
  /** 완료 체크 토글 */
  onToggle?: () => void
  /** 상태 칩 → 상태 메뉴(기준 사각형) */
  onStatus?: (anchor: DOMRect) => void
  /** ⋮ → 행 메뉴(기준 사각형) */
  onMenu?: (anchor: DOMRect) => void
}

const TONE_TEXT: Record<string, string> = {
  danger: 'text-danger', warning: 'text-warning', foreground: 'text-foreground', muted: 'text-muted-foreground',
}
const STATUS_CHIP: Record<string, string> = {
  neutral: 'bg-muted text-foreground/85',
  warning: 'bg-warning/15 text-warning',
  primary: 'bg-primary/15 text-primary',
  success: 'bg-success/15 text-success',
}

function rect(e: MouseEvent<HTMLElement>) { return e.currentTarget.getBoundingClientRect() }

/** 작업 목록 행(데스크톱 48 격자 · 모바일 60) */
export function TasksRow({ task, selected, onSelect, onToggle, onStatus, onMenu }: TasksRowProps) {
  const { t } = useI18n()

  const done = task.status === 'done'
  const due = dueLabel(task, undefined, (k, p) => t(k, p ?? {}))
  const pr = PRIORITY_META[task.priority as TaskPriority] ?? PRIORITY_META.medium
  const st = STATUS_META[task.status as TaskStatus] ?? STATUS_META.todo
  const sub = task.subtask_count > 0 ? `${task.completed_subtask_count}/${task.subtask_count}` : ''
  const assigneeName = task.assignee_name || ''

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.() }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-label={task.title}
      className="group relative isolate cursor-pointer border-b border-border outline-hidden focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))] md:rounded-none"
      onClick={() => onSelect?.()}
      onKeyDown={onKey}
    >
      {selected
        ? <span className="absolute inset-0 -z-10 rounded-[8px] bg-primary/[0.13]" aria-hidden="true" />
        : <span className="absolute inset-0 -z-10 rounded-[8px] group-hover:bg-accent/40" aria-hidden="true" />}

      {/* 데스크톱 48 */}
      <div className="hidden h-12 grid-cols-[36px_minmax(0,1fr)_96px_80px_64px_96px_36px] items-center text-[13.5px] md:grid">
        <span className="grid place-items-center">
          <button
            type="button"
            role="checkbox"
            aria-checked={done}
            aria-label={done ? t('tasks.row.unmarkDone') : t('tasks.row.markDone')}
            className={cn(
              "relative grid h-[18px] w-[18px] place-items-center rounded-full transition-colors before:absolute before:-inset-[11px] before:content-[''] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              done ? 'bg-success text-background' : 'shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground))] hover:shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]',
            )}
            onClick={(e) => { e.stopPropagation(); onToggle?.() }}
          >
            {done && <UiIcon name="check" className="h-[11px] w-[11px]" strokeWidth={3.5} />}
          </button>
        </span>
        <span className={cn('truncate pr-3 font-medium', done ? 'text-muted-foreground line-through' : 'text-foreground')}>{task.title}</span>
        <span>
          <button
            type="button"
            aria-haspopup="menu"
            aria-label={t('tasks.row.statusChange', { label: t(st.labelKey) })}
            className={cn(
              "relative inline-flex h-[22px] items-center gap-1 rounded-[6px] px-2 text-xs font-semibold before:absolute before:-inset-y-[9px] before:inset-x-0 before:content-[''] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              STATUS_CHIP[st.tone],
            )}
            onClick={(e) => { e.stopPropagation(); onStatus?.(rect(e)) }}
          >
            {t(st.labelKey)}
            <UiIcon name="chevron-down" className="h-3 w-3" strokeWidth={2.6} />
          </button>
        </span>
        <span className="whitespace-nowrap text-xs font-semibold">
          <span className={TONE_TEXT[pr.tone]} aria-hidden="true">{pr.arrow}</span> {t(pr.labelKey)}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{sub}</span>
        <span className={cn('whitespace-nowrap font-mono text-[11px] font-semibold', due ? TONE_TEXT[due.tone] : '')}>{due?.text}</span>
        <span className="relative grid place-items-center">
          {assigneeName && (
            <span
              className="grid h-6 w-6 place-items-center rounded-full bg-muted text-[10px] font-semibold group-hover:invisible group-focus-within:invisible"
              title={t('tasks.row.assignee', { name: assigneeName })}
              role="img"
              aria-label={t('tasks.row.assignee', { name: assigneeName })}
            >{assigneeName.charAt(0)}</span>
          )}
          <UiIconButton
            label={t('tasks.row.menu', { title: task.title })}
            icon="more-vertical"
            className="absolute opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            onClick={(e) => { e.stopPropagation(); onMenu?.(rect(e)) }}
          />
        </span>
      </div>

      {/* 모바일 60 */}
      <div className="flex min-h-[60px] items-center gap-3 py-2 pl-4 pr-1 md:hidden">
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={done ? t('tasks.row.unmarkDone') : t('tasks.row.markDone')}
          className={cn(
            "relative grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full before:absolute before:-inset-[9px] before:content-['']",
            done ? 'bg-success text-background' : 'shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground))]',
          )}
          onClick={(e) => { e.stopPropagation(); onToggle?.() }}
        >
          {done && <UiIcon name="check" className="h-3 w-3" strokeWidth={3.5} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-[15px] font-medium', done ? 'text-muted-foreground line-through' : 'text-foreground')}>{task.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            <b className="font-semibold"><span className={TONE_TEXT[pr.tone]} aria-hidden="true">{pr.arrow}</span> {t(pr.labelKey)}</b>
            {' · '}{t(st.labelKey)}
            {sub && <> · <span className="font-mono">{sub}</span></>}
            {due && <> · <span className={cn('font-mono', due.tone === 'danger' ? 'text-danger' : '')}>{due.text}</span></>}
          </div>
        </div>
        <UiIconButton label={t('tasks.row.menu', { title: task.title })} icon="more-vertical" size="md" noTooltip onClick={(e) => { e.stopPropagation(); onMenu?.(rect(e)) }} />
      </div>
    </div>
  )
}

export default TasksRow
