/**
 * 반복 일정 범위 확인.
 *  삭제: alertdialog 400, 패딩 20 —
 *    제목 15/600 "반복 일정을 삭제할까요?" + 설명 13 '"제목" · 매주 목요일 15:00. 참석자 n명에게 취소 메일이 갑니다.' →
 *    라디오 행 40(테두리 카드, 고르면 1.5px primary + primary/0.08): 이 일정만 (날짜) / 이 일정과 이후 모두 / 반복 전체 →
 *    체크 "참석자에게 취소 알림 보내기"(참석자가 있을 때만) → [취소][삭제 danger].
 *  수정: 시안 그림이 없어 예전 확인형 그대로(라디오 3 + [취소][저장]).
 * "이 일정만" = 회차 예외(삭제는 EXDATE, 수정은 RECURRENCE-ID 행). 가장 좁은 범위라 기본 선택. 포커스는 [취소]부터.
 */
import { eventRange, zp } from '~/utils/calTz'
import { useState, type KeyboardEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import type { DeleteScope } from '~/composables/useCalendar'
import { parseRRule } from '~/utils/calendarLayout'
import { UiModal } from '~/components/ui/Modal'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiRadio } from '~/components/ui/Radio'

export interface CalendarScopeModalProps {
  mode: 'delete' | 'edit'
  /** 첫 회차(마스터)인가 — 지금은 기본 선택에 쓰지 않지만 호출부 호환을 위해 받는다 */
  isOccurrence: boolean
  /** 삭제 설명(제목·반복·시각·참석자 수)에 쓴다 */
  event?: { title: string; start: string; all_day?: boolean; recurrence_rule: string | null; attendees?: readonly { email: string }[] } | null
  /** 참석자 수에서 뺄 내 이메일(주최자 본인) */
  myEmail?: string | null
  onClose?: () => void
  /** 범위 확정(notify = 참석자에게 취소 알림) */
  onConfirm?: (scope: DeleteScope, notify: boolean) => void
}

const BTN = 'inline-flex h-9 items-center justify-center rounded-md px-3.5 text-[13px] transition-colors ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

/** 반복 일정 수정·삭제 범위 확인 대화 상자 */
export function CalendarScopeModal({ mode, event, myEmail, onClose, onConfirm }: CalendarScopeModalProps) {
  const { t, tm, rt } = useI18n()

  const [scope, setScope] = useState<DeleteScope>('this')
  const [notify, setNotify] = useState(true)

  // 캘린더 시간대 기준(종일은 날짜 그대로)
  const start = event ? eventRange({ start: event.start, end: event.start, all_day: event.all_day }).start : null
  const sp = start ? zp(start) : null
  const pad = (n: number) => String(n).padStart(2, '0')
  const startTime = sp ? `${pad(sp.hours)}:${pad(sp.minutes)}` : ''
  const startDay = sp ? `${sp.month + 1}/${sp.date}` : ''

  const repeatText = (() => {
    const r = parseRRule(event?.recurrence_rule)
    if (!r || !r.freq || !start) return ''
    const n = r.interval
    if (r.freq === 'WEEKLY') {
      const FULL = (tm('calendar.weekdaysFull') as any[]).map(m => rt(m))
      const days = (r.byday.length ? r.byday : [sp!.day]).map(i => FULL[i]).join('·')
      return n > 1 ? t('calendar.popover.everyNWeeks', { n, days }) : t('calendar.popover.weekly', { days })
    }
    const key = ({ DAILY: 'daily', MONTHLY: 'monthly', YEARLY: 'yearly' } as const)[r.freq]
    return n > 1 ? t(`calendar.popover.everyN.${key}`, { n }) : t(`calendar.popover.${key}`)
  })()

  const me = (myEmail || '').toLowerCase()
  const attendeeCount = (event?.attendees || []).filter(a => (a.email || '').toLowerCase() !== me).length

  const description = (() => {
    if (!event) return ''
    const head = t('calendar.scope.deleteDesc', { title: event.title, repeat: repeatText, time: startTime })
    return attendeeCount && notify ? `${head} ${t('calendar.scope.deleteMailNote', { n: attendeeCount })}` : head
  })()

  const options = [
    { value: 'this' as const, label: t('calendar.scope.this'), meta: startDay },
    { value: 'following' as const, label: t('calendar.scope.followingAll'), meta: '' },
    { value: 'all' as const, label: t('calendar.scope.allSeries'), meta: '' },
  ]

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const next = options[(i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length]
    setScope(next.value)
    requestAnimationFrame(() => (document.querySelector(`[data-scope-opt="${next.value}"]`) as HTMLElement | null)?.focus())
  }

  if (mode === 'delete') {
    // 삭제
    return (
      <UiModal
        confirm
        danger
        title={t('calendar.scope.deleteQuestion')}
        onClose={onClose}
        footer={(
          <>
            <button type="button" data-autofocus className={`${BTN} border border-border text-foreground hover:bg-accent`} onClick={() => onClose?.()}>{t('common.cancel')}</button>
            <button
              type="button"
              className={`${BTN} bg-danger px-4 font-semibold text-background hover:bg-danger/90`}
              onClick={() => onConfirm?.(scope, notify && attendeeCount > 0)}
            >{t('common.delete')}</button>
          </>
        )}
      >
        <div>
          {description && <p className="-mt-1 text-[13px] leading-relaxed text-muted-foreground [word-break:keep-all]">{description}</p>}
          <div role="radiogroup" aria-label={t('calendar.scope.deleteTitle')} className="mt-3.5 flex flex-col gap-1.5 text-[13px]">
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={scope === o.value}
                tabIndex={scope === o.value ? 0 : -1}
                data-scope-opt={o.value}
                className={cn(
                  'flex h-10 items-center gap-2.5 rounded-md px-3 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                  scope === o.value ? 'border-[1.5px] border-primary bg-primary/[0.08]' : 'border border-border hover:bg-accent/40',
                )}
                onClick={() => setScope(o.value)}
                onKeyDown={e => onKey(e, i)}
              >
                <span
                  className={cn(
                    'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full',
                    scope === o.value ? 'shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]' : 'shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground))]',
                  )}
                  aria-hidden="true"
                >{scope === o.value && <span className="h-[9px] w-[9px] rounded-full bg-primary" />}</span>
                <span>{o.label}</span>
                {o.meta && <span className="text-muted-foreground">{o.meta}</span>}
              </button>
            ))}
          </div>
          {attendeeCount > 0 && <UiCheckbox modelValue={notify} onUpdateModelValue={setNotify} label={t('calendar.scope.notifyAttendees')} className="mt-3 text-[13px]" />}
        </div>
      </UiModal>
    )
  }

  // 수정 — 예전 확인형 그대로
  return (
    <UiModal
      confirm
      title={t('calendar.scope.editTitle')}
      onClose={onClose}
      footer={(
        <>
          <button type="button" data-autofocus className={`${BTN} border border-border text-foreground hover:bg-accent`} onClick={() => onClose?.()}>{t('common.cancel')}</button>
          <button type="button" className={`${BTN} bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90`} onClick={() => onConfirm?.(scope, false)}>{t('common.save')}</button>
        </>
      )}
    >
      <div role="radiogroup" aria-label={t('calendar.scope.editTitle')} className="mt-1 flex flex-col">
        <UiRadio modelValue={scope} onUpdateModelValue={v => setScope(v as DeleteScope)} value="this" name="cal-scope" label={t('calendar.scope.this')} />
        <UiRadio modelValue={scope} onUpdateModelValue={v => setScope(v as DeleteScope)} value="following" name="cal-scope" label={t('calendar.scope.following')} />
        <UiRadio modelValue={scope} onUpdateModelValue={v => setScope(v as DeleteScope)} value="all" name="cal-scope" label={t('calendar.scope.all')} />
      </div>
    </UiModal>
  )
}

export default CalendarScopeModal
