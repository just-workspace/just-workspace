/**
 * 데스크톱 캘린더 사이드바: 236 bg-card · [+ 새 일정] 40 primary · 미니 달력 ·
 * "내 캘린더" / "구독"(끝에 "+ 구독 추가" 줄) / "공유받은 캘린더" 34 행(체크 16 + 색 견본 10 + 이름). 공유·삭제는 hover/포커스에만(데스크톱 규칙 C).
 * 구독 행은 hover 에 ⋮ 하나만 — 메뉴 = 지금 새로 고침 · 색 바꾸기 · 공유 · ─ · 구독 해제(설정 › 캘린더와 같은 한 벌).
 * 모바일(<md)에서는 페이지가 이 사이드바를 그리지 않고 FAB + 상단 ⋯ 시트를 쓴다.
 */
import { useEffect, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useCalendar, calendarStore, type CalendarInfo } from '~/composables/useCalendar'
import { confirmBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'
import { eventBar } from '~/utils/calendarLayout'
import { CAT_HEX, catForIndex, catNameKey } from '~/utils/categoryColor'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiInput } from '~/components/ui/Input'
import { UiMenu } from '~/components/ui/Menu'
import { refreshSubscriptionNow, subscriptionMenuItems, subscriptionColorOf, confirmUnsubscribe } from '~/components/settings/SettingsCalendarParts'
import { CalendarMiniMonth } from './CalendarMiniMonth'
import { CalendarSubscribeModal } from './CalendarSubscribeModal'

/** 데스크톱 캘린더 사이드바 */
export function CalendarSidebar() {
  const { t } = useI18n()
  const {
    calendars, selectedDate, loadingCalendars,
    fetchCalendars, createCalendar, updateCalendar, deleteCalendar,
    toggleCalendarVisibility, soloCalendar, selectDate, openCreateModal, openShareModal,
    CALENDAR_COLORS,
  } = useCalendar()

  const myCalendars = calendars.filter(c => !c.is_shared && !c.is_subscription)
  const subscriptions = calendars.filter(c => !c.is_shared && c.is_subscription)
  const [subscribeOpen, setSubscribeOpen] = useState(false)
  const sharedCalendars = calendars.filter(c => c.is_shared)

  const [showNewForm, setShowNewForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(CALENDAR_COLORS[0])

  function setFormOpen(open: boolean) {
    // 새 캘린더 기본 색은 순번대로 범주 1→8 순환
    if (open && !showNewForm) {
      const mine = calendarStore.getState().calendars.filter(c => !c.is_shared)
      setNewColor(CAT_HEX[catForIndex(mine.length).cat - 1])
    }
    setShowNewForm(open)
  }

  useEffect(() => {
    if (calendarStore.getState().calendars.length === 0) fetchCalendars()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleCreate() {
    if (!newName.trim()) return
    try {
      await createCalendar(newName.trim(), newColor)
      setNewName('')
      setShowNewForm(false)
    } catch (e: any) {
      console.error('create calendar failed:', e)
      // 실패를 삼키면 아무 반응이 없다(모바일 시트와 같은 문구)
      addToast('error', t('calendar.sidebar.createFailed'))
    }
  }

  async function handleDelete(cal: CalendarInfo) {
    if (!await confirmBox(t('calendar.sidebar.deleteConfirm', { name: cal.name }), { danger: true, confirmLabel: t('common.delete') })) return
    await deleteCalendar(cal.id)
  }

  // 구독 ⋮ 메뉴 — 설정 › 캘린더 ⋮ 와 같은 한 벌(subscriptionMenuItems)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  async function onSubMenu(cal: CalendarInfo, key: string) {
    if (key === 'refresh') { void refreshSubscriptionNow(t, cal); return }
    if (key === 'share') { openShareModal(cal); return }
    const color = subscriptionColorOf(key)
    if (color) {
      await updateCalendar(cal.id, { color })
      return
    }
    if (key === 'remove') {
      if (!await confirmUnsubscribe(t, cal.name)) return
      await deleteCalendar(cal.id)
    }
  }

  // 내 캘린더·구독 한 줄(체크 · 색 견본 · 이름 · hover 시 공유·삭제 — 구독은 ⋮ 하나)
  const ownRow = (cal: CalendarInfo) => (
    <div
      key={cal.id}
      className="group flex h-[34px] items-center gap-2.5 rounded-sm px-1 hover:bg-accent/40 focus-within:bg-accent/40"
    >
      <UiCheckbox
        modelValue={cal.is_visible}
        size={16}
        ariaLabel={t('calendar.sidebar.toggleVisible', { name: cal.name })}
        className="min-h-0"
        onUpdateModelValue={() => toggleCalendarVisibility(cal.id)}
      />
      <span className={cn('h-2.5 w-2.5 shrink-0 rounded-[3px]', cal.hatched ? 'bg-cat-hatch' : '')} style={{ backgroundColor: eventBar(cal.color) }} aria-hidden="true" />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-foreground focus-visible:outline-hidden focus-visible:underline"
        title={t('calendar.sidebar.soloTitle', { name: cal.name })}
        onClick={() => soloCalendar(cal.id)}
      >{cal.name}</button>
      <span className={cn('flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100', menuOpenId === cal.id && 'opacity-100')}>
        {cal.is_subscription
          ? (
            <UiMenu
              items={subscriptionMenuItems(t, cal)}
              label={t('settings.calendarPrefs.menu', { name: cal.name })}
              align="end"
              onOpen={() => setMenuOpenId(cal.id)}
              onClose={() => setMenuOpenId(id => (id === cal.id ? null : id))}
              onSelect={k => { void onSubMenu(cal, k) }}
              trigger={({ toggle, open, controls }) => (
                <UiIconButton
                  label={t('settings.calendarPrefs.menu', { name: cal.name })}
                  icon="more-vertical"
                  aria-haspopup="menu"
                  aria-expanded={open}
                  aria-controls={controls}
                  noTooltip
                  className="h-7 w-7"
                  onClick={toggle}
                />
              )}
            />
          )
          : (
            <>
              <UiIconButton label={t('calendar.sidebar.shareTitle')} icon="share" className="h-7 w-7" onClick={() => openShareModal(cal)} />
              <UiIconButton label={t('common.delete')} icon="trash" className="h-7 w-7" onClick={() => handleDelete(cal)} />
            </>
          )}
      </span>
    </div>
  )

  return (
    <div className="flex flex-col p-3 text-[13px]">
      <UiButton className="mb-3.5 h-10 w-full gap-1.5 font-semibold" onClick={() => openCreateModal()}>
        <UiIcon name="plus" className="h-4 w-4" strokeWidth={2.4} />
        {t('calendar.event.newButton')}
      </UiButton>

      <CalendarMiniMonth selectedDate={selectedDate} onSelect={selectDate} />

      <div className="flex items-center justify-between px-1 pb-1.5 pt-4">
        <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('calendar.sidebar.myCalendars')}</h3>
        <UiIconButton label={t('calendar.sidebar.addCalendar')} icon="plus" className="-my-1 h-7 w-7" pressed={showNewForm} onClick={() => setFormOpen(!showNewForm)} />
      </div>

      {loadingCalendars
        ? <UiSkeleton preset="list" rows={3} />
        : (
          <>
            {myCalendars.map(ownRow)}

            {/* 새 캘린더 인라인 폼 */}
            {showNewForm && (
              <div className="mt-1.5 flex flex-col gap-2 rounded-md border border-border p-2.5">
                <UiInput
                  modelValue={newName}
                  onUpdateModelValue={setNewName}
                  placeholder={t('calendar.sidebar.calendarNamePlaceholder')}
                  onKeyUp={(e) => { if (e.key === 'Enter') handleCreate() }}
                />
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('calendar.sidebar.colorLabel')}>
                  {CALENDAR_COLORS.map((c, ci) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={newColor === c}
                      aria-label={t(catNameKey(ci + 1))}
                      title={t(catNameKey(ci + 1))}
                      className={cn(
                        "relative h-5 w-5 rounded-full ring-offset-2 ring-offset-card transition-transform after:absolute after:-inset-2.5 after:content-[''] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                        newColor === c ? 'scale-110 ring-2 ring-foreground' : '',
                      )}
                      style={{ backgroundColor: eventBar(c) }}
                      onClick={() => setNewColor(c)}
                    />
                  ))}
                </div>
                <div className="flex justify-end gap-1.5">
                  <UiButton variant="ghost" size="xs" onClick={() => setShowNewForm(false)}>{t('common.cancel')}</UiButton>
                  <UiButton size="xs" disabled={!newName.trim()} onClick={handleCreate}>{t('common.add')}</UiButton>
                </div>
              </div>
            )}

            {/* 구독(외부 .ics) — 묶음 끝 "+ 구독 추가" */}
            <h3 className="px-1 pb-1.5 pt-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('calendar.sidebar.subscriptions')}</h3>
            {subscriptions.map(ownRow)}
            <button
              type="button"
              className="flex h-8 items-center gap-2 rounded-sm px-2 text-left text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setSubscribeOpen(true)}
            >
              <UiIcon name="plus" className="h-3.5 w-3.5" />
              {t('calendar.sidebar.addSubscription')}
            </button>

            {sharedCalendars.length > 0 && (
              <>
                <h3 className="px-1 pb-1.5 pt-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('calendar.sidebar.sharedCalendars')}</h3>
                {sharedCalendars.map(cal => (
                  <div
                    key={cal.id}
                    className="flex h-[34px] items-center gap-2.5 rounded-sm px-1 text-muted-foreground hover:bg-accent/40"
                  >
                    <UiCheckbox
                      modelValue={cal.is_visible}
                      size={16}
                      ariaLabel={t('calendar.sidebar.toggleVisible', { name: cal.name })}
                      className="min-h-0"
                      onUpdateModelValue={() => toggleCalendarVisibility(cal.id)}
                    />
                    <span className={cn('h-2.5 w-2.5 shrink-0 rounded-[3px]', cal.hatched ? 'bg-cat-hatch' : '')} style={{ backgroundColor: eventBar(cal.color) }} aria-hidden="true" />
                    <button type="button" className="min-w-0 flex-1 truncate text-left" title={t('calendar.sidebar.soloTitle', { name: cal.name })} onClick={() => soloCalendar(cal.id)}>{cal.name}</button>
                    {cal.can_write === false && <span className="shrink-0 text-[11px]">· {t('calendar.sidebar.readOnly')}</span>}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      {subscribeOpen && (
        <CalendarSubscribeModal
          existingCount={subscriptions.length}
          onAdded={() => { void fetchCalendars() }}
          onClose={() => setSubscribeOpen(false)}
        />
      )}
    </div>
  )
}

export default CalendarSidebar
