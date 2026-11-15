/**
 * 캘린더 공유 대화 상자(시안 반영 전 예전 마크업 그대로).
 * 이메일 + "쓰기 허용" 으로 추가, 현재 공유 목록에서 권한 토글·해제. showShareModal 이 켜지면 공유 목록을 읽는다.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useCalendar, calendarStore, type CalendarShareInfo } from '~/composables/useCalendar'
import { eventBar } from '~/utils/calendarLayout'

/** 캘린더 공유 대화 상자(showShareModal · sharingCalendar) */
export function CalendarShareModal() {
  const {
    showShareModal, sharingCalendar,
    fetchCalendarShares, setCalendarShares, removeCalendarShare, closeShareModal,
  } = useCalendar()

  const { t } = useI18n()
  const [shares, setShares] = useState<CalendarShareInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newCanWrite, setNewCanWrite] = useState(false)
  const [error, setError] = useState('')

  // watch(showShareModal) — immediate 아님
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const cal = calendarStore.getState().sharingCalendar
    if (showShareModal && cal) {
      setLoading(true)
      setError('')
      fetchCalendarShares(cal.id).then(setShares).finally(() => setLoading(false))
    } else {
      setShares([])
      setNewEmail('')
      setNewCanWrite(false)
      setError('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showShareModal])

  async function handleAdd() {
    const email = newEmail.trim()
    if (!email || !sharingCalendar) return
    if (shares.some(s => s.email === email)) {
      setError(t('calendar.share.alreadyShared'))
      return
    }
    setError('')

    const updated = [...shares, { email, can_write: newCanWrite }]
    try {
      await setCalendarShares(sharingCalendar.id, updated)
      // 서버가 실제로 저장한 목록으로(보낸 목록을 그대로 믿지 않는다)
      setShares(await fetchCalendarShares(sharingCalendar.id))
      setNewEmail('')
      setNewCanWrite(false)
    } catch (e: any) {
      // 없는 사용자·본인이면 서버가 400 으로 이유를 준다
      setError((typeof e?.data?.detail === 'string' && e.data.detail) || t('calendar.share.setError'))
    }
  }

  async function handleRemove(email: string) {
    if (!sharingCalendar) return
    try {
      await removeCalendarShare(sharingCalendar.id, email)
      setShares(prev => prev.filter(s => s.email !== email))
    } catch {
      setError(t('calendar.share.removeError'))
    }
  }

  async function toggleWrite(share: CalendarShareInfo) {
    if (!sharingCalendar) return
    const updated = shares.map(s =>
      s.email === share.email ? { ...s, can_write: !s.can_write } : s,
    )
    try {
      await setCalendarShares(sharingCalendar.id, updated)
      setShares(updated)
    } catch {
      setError(t('calendar.share.permissionError'))
    }
  }

  if (!showShareModal) return null

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-end justify-center bg-scrim sm:items-center sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) closeShareModal() }}
    >
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-lg w-full max-w-md overflow-hidden pb-[env(safe-area-inset-bottom)] sm:pb-0" role="dialog">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-[15px] font-semibold text-foreground">{t('calendar.share.title')}</h2>
            {sharingCalendar && (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-0.5">
                <span
                  className="w-2.5 h-2.5 rounded-full inline-block"
                  style={{ backgroundColor: eventBar(sharingCalendar.color) }}
                />
                {sharingCalendar.name}
              </p>
            )}
          </div>
          <button onClick={closeShareModal} className="p-1.5 rounded-md hover:bg-accent">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Add new share */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('calendar.share.addUser')}</label>
            <div className="flex gap-2">
              <input
                autoComplete="off"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                type="email"
                placeholder={t('calendar.share.emailPlaceholder')}
                className="flex-1 px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-hidden focus:ring-2 focus:ring-ring"
                onKeyUp={(e) => { if (e.key === 'Enter') handleAdd() }}
              />
              <button
                onClick={handleAdd}
                disabled={!newEmail.trim()}
                className="px-3 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {t('common.add')}
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input checked={newCanWrite} onChange={e => setNewCanWrite(e.target.checked)} type="checkbox" className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-2 focus:ring-ring" />
              {t('calendar.share.grantWrite')}
            </label>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {/* Current shares */}
          <div>
            <h3 className="text-sm font-medium text-foreground mb-2">{t('calendar.share.currentShares')}</h3>
            {loading
              ? <div className="text-sm text-muted-foreground py-2">{t('common.loading')}</div>
              : shares.length === 0
                ? (
                  <div className="text-sm text-muted-foreground py-2">
                    {t('calendar.share.noShares')}
                  </div>
                )
                : (
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {shares.map(share => (
                      <div
                        key={share.email}
                        className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/40 group"
                      >
                        <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium shrink-0">
                          {share.email[0].toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{share.email}</p>
                          <button
                            onClick={() => toggleWrite(share)}
                            className={cn('text-xs transition-colors', share.can_write ? 'text-success' : 'text-muted-foreground hover:text-foreground')}
                          >
                            {share.can_write ? t('calendar.share.readWrite') : t('calendar.share.readOnly')}
                          </button>
                        </div>
                        <button
                          onClick={() => handleRemove(share.email)}
                          className="opacity-100 md:opacity-0 md:group-hover:opacity-100 p-1 rounded hover:bg-accent text-muted-foreground hover:text-destructive transition-all"
                          title={t('calendar.share.unshare')}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border bg-muted/20 flex justify-end">
          <button
            onClick={closeShareModal}
            className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default CalendarShareModal
