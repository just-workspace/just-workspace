/**
 * .ics 가져오기·내보내기(Vue components/calendar/CalendarIcsModal.vue · 시안 CL1 ⋯ 메뉴 항목 — 대화 상자 그림은 없어 P4 PatForm 규격:
 * UiModal 기본 폭, 라벨 12/600 필드 + [취소][확인]).
 * 가져오기: 쓸 수 있는 캘린더 고르기 + 파일(.ics, 10MB) → 결과 토스트 "새 n · 갱신 n · 건너뜀 n".
 * 내보내기: 캘린더 고르기 → 파일 다운로드(반복 규칙·회차 예외·참석자 포함 — 서버 직렬화).
 */
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { useCalendar } from '~/composables/useCalendar'
import { eventBar } from '~/utils/calendarLayout'
import { UiModal } from '~/components/ui/Modal'
import { UiSelect } from '~/components/ui/Select'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'

export interface CalendarIcsModalProps {
  mode: 'import' | 'export'
  onClose?: () => void
}

/** .ics 가져오기·내보내기 대화 상자 */
export function CalendarIcsModal({ mode, onClose }: CalendarIcsModalProps) {
  const { t } = useI18n()
  const { calendars, importIcs, exportIcs } = useCalendar()

  const list = mode === 'import' ? calendars.filter(c => c.can_write !== false) : calendars
  const options = list.map(c => ({ value: c.id, label: c.name, swatch: eventBar(c.color) }))
  const [calendarId, setCalendarId] = useState<string | number | null>(() => list[0]?.id ?? null)
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null
    setError('')
    if (f && f.size > 10 * 1024 * 1024) { setError(t('calendar.ics.tooLarge')); setFile(null); return }
    setFile(f)
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (busyRef.current || !calendarId) return
    setError('')
    busyRef.current = true
    setBusy(true)
    try {
      if (mode === 'import') {
        if (!file) { setError(t('calendar.ics.fileRequired')); return }
        const r = await importIcs(String(calendarId), file)
        addToast('success', t('calendar.ics.imported', { created: r.created, updated: r.updated, skipped: r.skipped }))
      } else {
        await exportIcs({ calendarId: String(calendarId) })
      }
      onClose?.()
    } catch (err: any) {
      setError((typeof err?.data?.detail === 'string' && err.data.detail)
        || (mode === 'import' ? t('calendar.ics.importError') : t('calendar.ics.exportError')))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <UiModal
      title={mode === 'import' ? t('calendar.menu.import') : t('calendar.menu.export')}
      persistent={busy}
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="outline" size="sm" disabled={busy} onClick={() => onClose?.()}>{t('common.cancel')}</UiButton>
          <UiButton type="submit" form="cal-ics-form" size="sm" className="font-semibold" disabled={busy || !calendarId || (mode === 'import' && !file)}>
            {busy ? t('common.loading') : mode === 'import' ? t('calendar.ics.importBtn') : t('calendar.ics.exportBtn')}
          </UiButton>
        </>
      )}
    >
      <form id="cal-ics-form" className="flex flex-col gap-3.5" noValidate onSubmit={submit}>
        <UiSelect modelValue={calendarId} onUpdateModelValue={setCalendarId} options={options} label={t('calendar.event.calendarLabel')} />
        {mode === 'import'
          ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground">{t('calendar.ics.file')}</span>
              <div className="flex items-center gap-2">
                <UiButton type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>{t('calendar.ics.choose')}</UiButton>
                <span className={cn('min-w-0 flex-1 truncate text-[13px]', file ? 'text-foreground' : 'text-muted-foreground')}>{file?.name || t('calendar.ics.noFile')}</span>
                <input ref={fileInput} type="file" accept=".ics,text/calendar" className="sr-only" aria-label={t('calendar.ics.file')} onChange={onFile} />
              </div>
              <span className="text-xs text-muted-foreground">{t('calendar.ics.importHint')}</span>
            </div>
          )
          : <p className="text-[13px] text-muted-foreground">{t('calendar.ics.exportHint')}</p>}
        {error && (
          <p role="alert" className="flex items-center gap-1.5 text-xs text-danger">
            <UiIcon name="alert-circle" className="h-3.5 w-3.5 shrink-0" />{error}
          </p>
        )}
      </form>
    </UiModal>
  )
}

export default CalendarIcsModal
