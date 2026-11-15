/**
 * 모바일 상단 ⋯ 시트("캘린더 목록 시트"):
 * 사이드바 대신 캘린더 표시 토글 + 새 캘린더 + CalDAV 주소 복사.
 * 가져오기·내보내기(.ics)는 시트를 닫고 CalendarIcsModal 을 연다.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { useCalendar, calendarStore } from '~/composables/useCalendar'
import { eventBar } from '~/utils/calendarLayout'
import { CAT_HEX, catForIndex, catNameKey } from '~/utils/categoryColor'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiInput } from '~/components/ui/Input'
import { UiButton } from '~/components/ui/Button'
import { writeClipboard } from '~/lib/clipboard'

/** 모바일 캘린더 목록 시트(mobileMenuOpen 일 때 페이지가 그린다) */
export function CalendarMobileMenu() {
  const { t } = useI18n()
  const { calendars, setMobileMenuOpen, setIcsMode, toggleCalendarVisibility, createCalendar, CALENDAR_COLORS } = useCalendar()
  const { user } = useAuth()

  const [showNew, setShowNewRaw] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(CALENDAR_COLORS[0])
  const [creating, setCreating] = useState(false)
  // 새 캘린더 기본 색은 순번대로 범주 1→8 순환
  function setShowNew(open: boolean) {
    if (open && !showNew) setNewColor(CAT_HEX[catForIndex(calendarStore.getState().calendars.filter(c => !c.is_shared).length).cat - 1])
    setShowNewRaw(open)
  }

  function close() { setMobileMenuOpen(false) }
  function openIcs(mode: 'import' | 'export') { close(); setIcsMode(mode) }

  async function create() {
    if (!newName.trim() || creating) return
    setCreating(true)
    try {
      await createCalendar(newName.trim(), newColor)
      setNewName('')
      setShowNewRaw(false)
    } catch { addToast('error', t('calendar.sidebar.createFailed')) }
    finally { setCreating(false) }
  }

  async function copyCaldav() {
    const url = `${window.location.origin}/dav/calendars/${user?.username || ''}/`
    try { await writeClipboard(url); addToast('success', t('calendar.menu.caldavCopied')) }
    catch { addToast('error', t('calendar.menu.copyFailed')) }
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex flex-col justify-end bg-scrim" onClick={close}>
      <div
        role="dialog"
        aria-label={t('calendar.mobile.menu')}
        className="max-h-[80dvh] overflow-y-auto rounded-t-sheet border-t border-border bg-card px-4 pt-2.5 animate-slide-up"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 28px)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-muted" aria-hidden="true" />
        <div className="mb-1 flex items-center">
          <span className="flex-1 text-[17px] font-semibold text-foreground">{t('calendar.mobile.calendars')}</span>
          <UiIconButton label={t('common.close')} icon="close" size="md" noTooltip onClick={close} />
        </div>

        {/* 캘린더 표시 토글: 항목 48 */}
        {calendars.map(cal => (
          <div key={cal.id} className="flex h-12 items-center gap-3 border-b border-border">
            <UiCheckbox
              modelValue={cal.is_visible}
              ariaLabel={t('calendar.sidebar.toggleVisible', { name: cal.name })}
              onUpdateModelValue={() => toggleCalendarVisibility(cal.id)}
            />
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-[3px]', cal.hatched ? 'bg-cat-hatch' : '')} style={{ backgroundColor: eventBar(cal.color) }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[15px] text-foreground">{cal.name}</span>
            {cal.is_shared && <span className="shrink-0 text-xs text-muted-foreground">{t('calendar.sidebar.sharedShort')}</span>}
          </div>
        ))}

        {/* 새 캘린더 */}
        {!showNew
          ? (
            <button
              type="button"
              className="flex h-12 w-full items-center gap-3 border-b border-border text-left text-[15px] text-foreground"
              onClick={() => setShowNew(true)}
            >
              <UiIcon name="plus" className="h-[18px] w-[18px] text-muted-foreground" />{t('calendar.mobile.newCalendar')}
            </button>
          )
          : (
            <div className="flex flex-col gap-2.5 border-b border-border py-3">
              <UiInput
                modelValue={newName}
                onUpdateModelValue={setNewName}
                size="lg"
                placeholder={t('calendar.sidebar.calendarNamePlaceholder')}
                onKeyUp={(e) => { if (e.key === 'Enter') create() }}
              />
              <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label={t('calendar.sidebar.colorLabel')}>
                {CALENDAR_COLORS.map((c, ci) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={newColor === c}
                    aria-label={t(catNameKey(ci + 1))}
                    className={cn("relative h-6 w-6 rounded-full ring-offset-2 ring-offset-card after:absolute after:-inset-2 after:content-['']", newColor === c ? 'ring-2 ring-foreground' : '')}
                    style={{ backgroundColor: eventBar(c) }}
                    onClick={() => setNewColor(c)}
                  />
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <UiButton variant="ghost" size="sm" onClick={() => setShowNew(false)}>{t('common.cancel')}</UiButton>
                <UiButton size="sm" disabled={!newName.trim() || creating} onClick={create}>{t('common.add')}</UiButton>
              </div>
            </div>
          )}

        <button type="button" className="flex h-12 w-full items-center gap-3 border-b border-border text-left text-[15px] text-foreground" onClick={copyCaldav}>
          <UiIcon name="link" className="h-[18px] w-[18px] text-muted-foreground" />{t('calendar.menu.copyCaldav')}
        </button>
        <button type="button" className="flex h-12 w-full items-center gap-3 border-b border-border text-left text-[15px] text-foreground" onClick={() => openIcs('import')}>
          <UiIcon name="upload" className="h-[18px] w-[18px] text-muted-foreground" />{t('calendar.menu.import')}
        </button>
        <button type="button" className="flex h-12 w-full items-center gap-3 text-left text-[15px] text-foreground" onClick={() => openIcs('export')}>
          <UiIcon name="download" className="h-[18px] w-[18px] text-muted-foreground" />{t('calendar.menu.export')}
        </button>
      </div>
    </div>,
    document.body,
  )
}

export default CalendarMobileMenu
