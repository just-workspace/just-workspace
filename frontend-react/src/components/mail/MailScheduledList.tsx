/**
 * 예약함 — Vue 판 components/mail/MailScheduledList.vue.
 * 보내기 ▾ "예약 보내기"로 걸어 둔 메일(GET /api/mail/scheduled). 메일 목록 자리(가운데 열·모바일 목록)에 뜬다.
 * 시안엔 예약함 그림이 없어 메일 목록 행 규격(2줄 56 · 위 줄 44 · mono 시각)과 행 끝 아이콘 버튼으로 구성했다.
 * 행 끝: 시각 변경 · 예약 취소. 보내는 중이면 둘 다 막음(서버 409), 실패는 danger 틴트 배지 + 사유(다시 시각을 잡으면 재시도).
 */
import { useState } from 'react'
import { useI18n } from '~/i18n'
import { useMail, type ScheduledMail } from '~/composables/useMail'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { formatMailDate } from '~/utils/mailQuery'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiBadge } from '~/components/ui/Badge'
import { MailScheduleDialog } from '~/components/mail/MailScheduleDialog'

export interface MailScheduledListProps {
  /** 폴더 드로어 열기(≡) */
  onOpenFolders?: () => void
}

/** 예약 보내기 목록 */
export function MailScheduledList({ onOpenFolders }: MailScheduledListProps) {
  const { t } = useI18n()
  const { scheduled, loadingScheduled, fetchScheduled, rescheduleMail, cancelScheduled } = useMail()

  const [editing, setEditing] = useState<ScheduledMail | null>(null)
  const [busy, setBusy] = useState(false)

  function recipients(m: ScheduledMail) {
    return m.to.map(a => a.name || a.email).join(', ') || t('mail.list.noRecipients')
  }
  function errorMessage(e: any, fallback: string) {
    return e?.statusCode === 409 || e?.status === 409 ? t('mail.scheduled.busy') : (e?.data?.detail || fallback)
  }

  async function confirmReschedule(iso: string) {
    if (!editing) return
    setBusy(true)
    try {
      await rescheduleMail(editing.id, iso)
      addToast('success', t('mail.scheduled.rescheduled', { when: formatMailDate(iso, true) }))
      setEditing(null)
    } catch (e: any) {
      addToast('error', errorMessage(e, t('mail.scheduled.rescheduleFailed')))
      await fetchScheduled()
    } finally {
      setBusy(false)
    }
  }

  async function cancel(m: ScheduledMail) {
    if (!await confirmBox(t('mail.scheduled.cancelConfirm', { subject: m.subject || t('mail.subject.none') }), {
      title: t('mail.scheduled.cancelTitle'), confirmLabel: t('mail.scheduled.cancel'), danger: true,
    })) return
    try {
      await cancelScheduled(m.id)
      addToast('info', t('mail.scheduled.cancelled'))
    } catch (e: any) {
      addToast('error', errorMessage(e, t('mail.scheduled.cancelFailed')))
      await fetchScheduled()
    }
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 모바일 상단 56 */}
      <header className="flex h-14 shrink-0 items-center border-b border-border px-1 md:hidden">
        <UiIconButton label={t('mail.list.foldersSwipe')} icon="menu" size="lg" className="text-foreground" onClick={() => onOpenFolders?.()} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-semibold">{t('mail.scheduled.title')}</h1>
          <p className="text-xs text-muted-foreground"><span className="font-mono">{scheduled.length}</span></p>
        </div>
        <UiIconButton label={t('common.refresh')} icon="refresh" size="lg" onClick={fetchScheduled} />
      </header>
      {/* 위 줄 44 */}
      <div className="hidden h-11 shrink-0 items-center gap-2 border-b border-border bg-card pl-2.5 pr-2 md:flex">
        <UiIconButton label={t('mail.list.folders')} icon="menu" className="lg:hidden" onClick={() => onOpenFolders?.()} />
        <UiIcon name="clock" className="ml-1 h-4 w-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{`${t('mail.scheduled.title')} `}<span className="font-mono font-normal text-muted-foreground">{scheduled.length}</span></h2>
        <UiIconButton label={t('common.refresh')} icon="refresh" onClick={fetchScheduled} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="region" aria-label={t('mail.scheduled.title')}>
        {loadingScheduled && !scheduled.length
          ? <UiSkeleton preset="list" rows={4} />
          : !scheduled.length
            ? <UiEmptyState variant="panel" icon="clock" title={t('mail.scheduled.empty')} description={t('mail.scheduled.emptyDesc')} className="py-10" />
            : (
              <ul>
                {scheduled.map(m => (
                  <li key={m.id} className="flex items-center gap-2 border-b border-border px-4 py-3 md:min-h-row-2 md:py-[9px] md:pl-3 md:pr-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline gap-1.5 text-[15px] md:text-[13.5px]">
                        <span className="truncate">{recipients(m)}</span>
                        <span className="flex-1" />
                        <span className="shrink-0 font-mono text-xs md:text-[11px]">{formatMailDate(m.send_at, true)}</span>
                      </div>
                      <div className="flex min-w-0 items-center gap-1.5 text-sm text-foreground/80 md:text-[13px]">
                        {m.status === 'failed'
                          ? <UiBadge tone="danger" tint size={18} className="shrink-0" title={m.error || undefined}>{t('mail.scheduled.failed')}</UiBadge>
                          : m.status === 'sending' && <UiBadge tone="primary" tint size={18} className="shrink-0">{t('mail.scheduled.sending')}</UiBadge>}
                        <span className="truncate">{m.subject || t('mail.subject.none')}</span>
                      </div>
                      {m.status === 'failed' && m.error && <p className="mt-0.5 truncate text-xs text-danger">{m.error}</p>}
                    </div>
                    <UiIconButton label={t('mail.scheduled.reschedule')} disabled={m.status === 'sending'} size="md" onClick={() => setEditing(m)}><UiIcon name="clock" /></UiIconButton>
                    <UiIconButton label={t('mail.scheduled.cancel')} disabled={m.status === 'sending'} size="md" className="text-danger hover:text-danger" onClick={() => cancel(m)}><UiIcon name="close" /></UiIconButton>
                  </li>
                ))}
              </ul>
            )}
      </div>

      {editing && (
        <MailScheduleDialog
          title={t('mail.scheduled.reschedule')}
          confirmLabel={t('mail.scheduled.rescheduleConfirm')}
          initial={editing.send_at}
          busy={busy}
          onClose={() => setEditing(null)}
          onConfirm={confirmReschedule}
        />
      )}
    </div>
  )
}

export default MailScheduledList
