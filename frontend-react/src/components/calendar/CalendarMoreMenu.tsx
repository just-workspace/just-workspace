/**
 * 커맨드 바 ⋯(Vue components/calendar/CalendarMoreMenu.vue · 시안 CL1 "캘린더 메뉴 — 가져오기·내보내기·CalDAV 주소").
 * 공용 UiMenu(드롭다운 224 · 항목 36). 가져오기·내보내기(.ics)는 CalendarIcsModal 을 연다(캘린더 고르기).
 */
import { useI18n } from '~/i18n'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { setIcsMode } from '~/composables/useCalendar'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { writeClipboard } from '~/lib/clipboard'

/** 캘린더 커맨드 바 ⋯ 메뉴(CalDAV 주소 복사 · .ics 가져오기 · 내보내기) */
export function CalendarMoreMenu() {
  const { t } = useI18n()
  const { user } = useAuth()

  const items: UiMenuItem[] = [
    { key: 'caldav', label: t('calendar.menu.copyCaldav'), icon: 'link' },
    { key: 'import', label: t('calendar.menu.import'), icon: 'upload' },
    { key: 'export', label: t('calendar.menu.export'), icon: 'download' },
  ]

  async function copyCaldav() {
    const url = `${window.location.origin}/dav/calendars/${user?.username || ''}/`
    try { await writeClipboard(url); addToast('success', t('calendar.menu.caldavCopied')) }
    catch { addToast('error', t('calendar.menu.copyFailed')) }
  }

  function onSelect(key: string) {
    if (key === 'caldav') copyCaldav()
    else if (key === 'import' || key === 'export') setIcsMode(key)
  }

  return <UiMenu label={t('calendar.menu.label')} items={items} onSelect={onSelect} />
}

export default CalendarMoreMenu
