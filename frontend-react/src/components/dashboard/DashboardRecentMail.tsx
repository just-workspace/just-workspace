/**
 * 최근 메일: 받은편지함 최근 메일, 두 줄 행 56 = 아바타(발신자 첫 글자) + 제목(안 읽음 semibold) /
 * 발신자 + 시각. 헤더 개수 = 받은편지함 안 읽음(요약), "메일 보기 ›". 행 수 = min(4, 상한 − 1).
 * 연결된 계정이 없으면 빈 카드(맨 아래 그룹 "메일 계정 없음 · 메일 연결" — 메일함은 조회하지 않는다).
 * 계정 로그인 실패(sync_error)이면 카드 내 경고 타일 "{계정} 로그인 실패 · 다시 연결"(→ 설정 › 메일).
 */
import { useEffect, useState } from 'react'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { useI18n } from '~/i18n'
import { useDashSummary } from '~/composables/useDashSummary'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { DashCard, DashRow, DashRows, DashRowsSkeleton, shortTime, useCardStatus, useDash } from './DashCard'

interface MailPreview {
  id: string
  from_: { name: string | null; email: string }[]
  subject: string | null
  received_at: string | null
  is_unread: boolean
}
interface Account { email: string; sync_error?: string | null }

/** 대시보드 최근 메일 카드 */
export function DashboardRecentMail() {
  const { t } = useI18n()
  const { maxRows } = useDash()
  const { summary } = useDashSummary()
  const limit = Math.min(4, maxRows - 1)
  const [mails, setMails] = useState<MailPreview[]>([])
  const [failedAccount, setFailedAccount] = useState<Account | null>(null)
  const [inboxId, setInboxId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  // 연결된 메일 계정 없음 — 오류가 아닌 빈 카드로 처리한다. 이 경우 메일함을 조회하지 않는다(불필요한 404 방지).
  const [noAccount, setNoAccount] = useState(false)

  async function load() {
    setLoading(true); setError(false); setNoAccount(false)
    try {
      // 계정 목록을 먼저 조회한다 — 계정이 없으면 /api/mail/mailboxes 는 404 이므로 호출하지 않는다.
      const accounts = await $fetch<Account[]>('/api/mail/accounts')
      if (!accounts.length) { setNoAccount(true); setMails([]); setFailedAccount(null); return }
      setFailedAccount(accounts.find(a => a.sync_error) ?? null)
      const mb = await $fetch<{ mailboxes: { id: string; role: string | null }[] }>('/api/mail/mailboxes')
      const inbox = mb.mailboxes.find(m => m.role === 'inbox')
      if (!inbox) { setMails([]); return }
      setInboxId(inbox.id)
      const data = await $fetch<{ messages: MailPreview[] }>('/api/mail/messages', { params: { mailbox_id: inbox.id, page: 0, limit } })
      setMails(data.messages || [])
    } catch { setError(true) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [limit]) // eslint-disable-line react-hooks/exhaustive-deps
  useCardStatus(
    'mail',
    loading && !mails.length ? 'loading' : error || failedAccount ? 'error' : mails.length ? 'ready' : 'empty',
    noAccount ? { text: t('dashboard.d17.empty.mailNoAccount'), linkLabel: t('mail.onboarding.connect'), to: '/mail/accounts?add=1' } : undefined,
  )

  function sender(m: MailPreview) { return m.from_?.[0]?.name || m.from_?.[0]?.email || t('mail.unknownSender') }

  return (
    <DashCard cardKey="mail" title={t('dashboard.recentMail.title')} count={summary?.mail_unread} link={{ label: t('dashboard.d17.mail.link'), to: '/mail' }}>
      {failedAccount && (
        <UiErrorTile
          placement="card"
          title={t('dashboard.recentMail.loginFailed', { email: failedAccount.email })}
          retryLabel={t('dashboard.recentMail.reconnect')}
          className="m-3.5"
          onRetry={() => { void navigateTo('/settings/mail') }}
        />
      )}
      {loading && !mails.length ? <DashRowsSkeleton rows={3} />
        : error ? <UiErrorTile placement="card" title={t('dashboard.recentMail.loadFailed')} className="m-3.5" onRetry={() => { void load() }} />
          : mails.length ? (
            <DashRows>
              {mails.slice(0, limit).map(m => (
                <DashRow
                  key={m.id}
                  avatar={(sender(m).trim().charAt(0) || '?').toUpperCase()}
                  title={m.subject || t('mail.noSubject')}
                  titleClass={m.is_unread ? 'font-semibold' : undefined}
                  srPrefix={m.is_unread ? t('dashboard.unreadSr') : undefined}
                  meta={sender(m)}
                  time={shortTime(m.received_at, t('common.yesterday'))}
                  to={`/mail/${encodeURIComponent(m.id)}?mailbox=${encodeURIComponent(inboxId)}`}
                />
              ))}
            </DashRows>
          ) : null}
    </DashCard>
  )
}

export default DashboardRecentMail
