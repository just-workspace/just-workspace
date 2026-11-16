/**
 * 메일 오른쪽 상세 패널 — 보낸 사람.
 * 공간이 충분할 때(상세 칸 ≥ 1400, 가로 화면)만 pages/mail 이 펼친 상태로 유지한다. 폭 360, border-l, px-5 py-6.
 *  ① 보낸 사람 카드: 아바타 48 · 이름 · 주소 · [채팅][통화](보낸 사람이 본 워크스페이스 사용자일 때만 — GET /api/mail/sender)
 *  ② 최근 주고받은 메일: 현재 메일함에서 해당 주소로 검색한 최근 5통(현재 메일 제외) — 선택 시 해당 메일을 연다
 *  ③ 함께 온 파일: 현재 메일의 첨부 — 선택 시 다운로드
 */
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { useI18n } from '~/i18n'
import { mailStore, openMessage, downloadAttachment, type MessageDetail } from '~/composables/useMail'
import { openRoom } from '~/composables/useMeetingCall'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'

interface SenderUser { id: string; username: string; display_name: string | null; avatar_url: string | null }
interface Summary { id: string; subject: string | null; received_at: string | null }

function shortDate(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso), now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * @param msg 현재 열린 메일
 * @param overlay 공간 부족 시 읽기 판 위에 표시(바탕 bg-card — 채팅 오른쪽 패널 오버레이와 동일 방식: 오른쪽 정렬·그림자·Esc·바깥 클릭 닫힘은 pages/mail 이 담당)
 */
export function MailSenderPanel({ msg, overlay = false }: { msg: MessageDetail; overlay?: boolean }) {
  const { t } = useI18n()
  const from = msg.from_?.[0]
  const email = from?.email ?? ''
  const name = from?.name || email || t('mail.unknownSender')
  const mailboxId = useStore(mailStore, s => s.selectedMailboxId)
  const accountId = useStore(mailStore, s => s.selectedAccountId)

  const [user, setUser] = useState<SenderUser | null>(null)
  const [recent, setRecent] = useState<Summary[]>([])
  useEffect(() => {
    let alive = true
    setUser(null); setRecent([])
    if (!email) return
    $fetch<{ user: SenderUser | null }>('/api/mail/sender', { params: { email } })
      .then(r => { if (alive) setUser(r.user) }).catch(() => {})
    if (mailboxId) {
      const params: Record<string, unknown> = { mailbox_id: mailboxId, page: 0, limit: 6, q: email }
      if (accountId) params.account_id = accountId
      $fetch<{ messages: Summary[] }>('/api/mail/messages', { params })
        .then(r => { if (alive) setRecent((r.messages || []).filter(m => m.id !== msg.id).slice(0, 5)) }).catch(() => {})
    }
    return () => { alive = false }
  }, [email, msg.id, mailboxId, accountId])

  async function dm(): Promise<string | null> {
    if (!user) return null
    try { return (await $fetch<{ id: string }>('/api/chat/dm', { method: 'POST', body: { user_id: user.id } })).id } catch { return null }
  }
  async function chat() { const id = await dm(); if (id) void navigateTo(`/chat?channel=${encodeURIComponent(id)}`) }
  async function call() { const id = await dm(); if (id) openRoom(`chan-${id}`) }

  const files = msg.attachments ?? []
  const H = 'mb-2 text-xs font-semibold text-muted-foreground'
  const ROW = 'flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring'

  return (
    <aside aria-label={t('mail.side.label')} className={`hidden h-full w-[360px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-border px-5 py-6 md:flex${overlay ? ' bg-card' : ''}`}>
      <section className="flex flex-col items-start gap-3">
        <UiAvatar src={user?.avatar_url} fallback={name.charAt(0).toUpperCase()} className="h-12 w-12" textSize={18} />
        <div className="min-w-0 max-w-full">
          <div className="truncate text-[15px] font-semibold text-foreground">{user?.display_name || name}</div>
          {email && <div className="truncate text-[13px] text-muted-foreground">{email}</div>}
        </div>
        {user && (
          <div className="flex gap-2">
            <UiButton variant="outline" size="xs" icon="message-square" onClick={() => { void chat() }}>{t('mail.side.chat')}</UiButton>
            <UiButton variant="outline" size="xs" icon="video" onClick={() => { void call() }}>{t('mail.side.call')}</UiButton>
          </div>
        )}
      </section>

      <section>
        <h3 className={H}>{t('mail.side.recent')}</h3>
        {recent.length
          ? (
            <ul className="-mx-2">
              {recent.map(m => (
                <li key={m.id}>
                  <button type="button" className={ROW} onClick={() => { void openMessage(m.id) }}>
                    <span className="min-w-0 flex-1 truncate">{m.subject || t('mail.noSubject')}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{shortDate(m.received_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
          : <p className="text-[13px] text-muted-foreground">{t('mail.side.noRecent')}</p>}
      </section>

      <section>
        <h3 className={H}>{t('mail.side.files')}</h3>
        {files.length
          ? (
            <ul className="-mx-2">
              {files.map(f => (
                <li key={f.blob_id}>
                  <button type="button" className={ROW} onClick={() => downloadAttachment(f.blob_id, f.name || 'attachment')}>
                    <UiIcon name="paperclip" className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{f.name || t('mail.side.unnamed')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
          : <p className="text-[13px] text-muted-foreground">{t('mail.side.noFiles')}</p>}
      </section>
    </aside>
  )
}

export default MailSenderPanel
