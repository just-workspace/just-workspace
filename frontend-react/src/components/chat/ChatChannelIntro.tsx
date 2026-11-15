/**
 * 채널 소개 — 대화 기록 맨 위. 새 채널에서는 컴포저 바로 위에 보인다.
 * 원 64(bg-muted, # 32) + 제목 26/700 "#채널 채널의 시작입니다" + 만든 사람·날짜·설명 16 muted + 첫 행동 3개(멤버 초대 primary · 파일 올리기 · 설명 수정).
 * 버튼은 첫 메시지 20개 이후 숨긴다. 설명 수정은 채널 소유자·관리자만(PATCH /channels/{id} 권한).
 */
import { useStore } from 'zustand'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { authStore } from '~/composables/useAuth'
import { promptBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'
import { chatStore, fetchChannels, type Channel } from '~/composables/useChat'
import { openFilePicker, setInviteOpen } from '~/composables/useChatUi'
import { UiIcon } from '~/components/ui/Icon'

export interface ChatChannelIntroProps {
  channel: Channel
  /** 지금까지 메시지 수 — 20 이상이면 첫 행동 버튼을 숨긴다 */
  messageCount: number
}

/** 채널 소개(# 타일 · 제목 · 만든 사람·날짜·설명 · 첫 행동) */
export function ChatChannelIntro({ channel, messageCount }: ChatChannelIntroProps) {
  const { t } = useI18n()
  const allUsers = useStore(chatStore, s => s.allUsers)
  const members = useStore(chatStore, s => s.members)
  const user = useStore(authStore, s => s.user)

  const creator = (() => {
    const u = allUsers.find(x => x.id === channel.created_by)
    if (u) return u.display_name || u.username
    if (channel.created_by === user?.id) return user?.display_name || user?.username || ''
    return '—'
  })()
  const dateLabel = (() => {
    const d = new Date(channel.created_at)
    if (d.toDateString() === new Date().toDateString()) return t('chat.intro.today')
    return t('chat.intro.onDate', { date: d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }) })
  })()
  const showActions = messageCount < 20
  const canEditDesc = (() => {
    const me = members.find(m => m.user_id === user?.id)
    return me?.role === 'owner' || me?.role === 'admin'
  })()

  async function editDescription() {
    const next = await promptBox(t('chat.intro.editDescPrompt'), {
      title: t('chat.intro.editDesc'),
      defaultValue: channel.description || '',
    })
    if (next === null) return
    try {
      await $fetch(`/api/chat/channels/${channel.id}`, { method: 'PATCH', body: { description: next.trim() } })
      await fetchChannels()
      addToast('success', t('chat.intro.descUpdated'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('chat.intro.descFailed'))
    }
  }

  return (
    <section className="flex max-w-[720px] flex-col items-start gap-3 px-3 pb-4 pt-4 md:px-4" aria-label={t('chat.shell.empty.title', { channel: '#' + channel.name })}>
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-foreground" aria-hidden="true">
        <UiIcon name={channel.type === 'private' ? 'lock' : 'hash'} className="h-8 w-8" />
      </span>
      <h2 className="text-[26px] font-bold leading-tight text-foreground">{t('chat.shell.empty.title', { channel: '#' + channel.name })}</h2>
      <p className="text-[16px] leading-[22px] text-muted-foreground [word-break:keep-all]">
        {t('chat.intro.body', { creator, date: dateLabel })}
        {channel.description ? ' ' + channel.description : null}
        {showActions ? ' ' + t('chat.intro.hint') : null}
      </p>
      {showActions && (
        <div className="mt-1 flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex h-10 items-center gap-1.5 rounded-[10px] bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90 md:h-9"
            onClick={() => setInviteOpen(true)}
          >
            <UiIcon name="user-plus" className="h-[15px] w-[15px]" />{t('chat.intro.invite')}
          </button>
          <button
            type="button"
            className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-border bg-card px-3.5 text-[13px] font-medium text-foreground hover:bg-accent md:h-9"
            onClick={openFilePicker}
          >{t('chat.intro.upload')}</button>
          {canEditDesc && (
            <button
              type="button"
              className="inline-flex h-10 items-center gap-1.5 rounded-[10px] border border-border bg-card px-3.5 text-[13px] font-medium text-foreground hover:bg-accent md:h-9"
              onClick={() => { void editDescription() }}
            >{t('chat.intro.editDesc')}</button>
          )}
        </div>
      )}
    </section>
  )
}

export default ChatChannelIntro
