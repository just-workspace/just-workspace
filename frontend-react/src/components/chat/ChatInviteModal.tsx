/**
 * 멤버 초대(채널 소개 D7 "멤버 초대"). Vue 원본: frontend/components/chat/ChatInviteModal.vue
 * 시안에 화면이 없어 공용 Modal(md) + 입력 + 체크 목록(P4 폼 규격)으로 구성.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { addMembers, chatStore, fetchChannels, searchUsers, selectSelectedChannel, useChat } from '~/composables/useChat'
import { setInviteOpen } from '~/composables/useChatUi'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiEmptyState } from '~/components/ui/EmptyState'

type UserRow = { id: string; username: string; display_name: string | null; avatar_url: string | null }

/** 채널 멤버 초대 모달 */
export function ChatInviteModal() {
  const { t } = useI18n()
  const { members } = useChat()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserRow[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const queryRef = useRef('')
  queryRef.current = query

  const memberIds = new Set(members.map(m => m.user_id))
  const candidates = results.filter(u => !memberIds.has(u.id))

  async function search() {
    setResults(await searchUsers(queryRef.current.trim()))
  }
  // watch(query) 250ms 디바운스(첫 값은 onMounted 의 search 가)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const timer = setTimeout(() => { void search() }, 250)
    return () => clearTimeout(timer)
  }, [query])
  useEffect(() => { void search() }, [])

  function toggle(id: string) {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }

  function close() { setInviteOpen(false) }

  async function submit() {
    const ch = selectSelectedChannel(chatStore.getState())
    if (!ch || picked.size === 0 || busy) return
    setBusy(true)
    try {
      await addMembers(ch.id, [...picked])
      await fetchChannels()
      addToast('success', t('chat.invite.done', { n: picked.size }))
      close()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('chat.invite.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <UiModal
      title={t('chat.invite.title')}
      size="md"
      onClose={close}
      footer={(
        <>
          <button type="button" className="inline-flex h-9 items-center rounded-[10px] border border-border px-3.5 text-[13px] font-medium hover:bg-accent" onClick={close}>{t('common.cancel')}</button>
          <button
            type="button"
            className="inline-flex h-9 items-center rounded-[10px] bg-primary px-4 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            disabled={picked.size === 0 || busy}
            onClick={() => { void submit() }}
          >{t('chat.invite.submit')}{picked.size > 0 && <span className="ml-1 font-mono">{picked.size}</span>}</button>
        </>
      )}
    >
      <UiInput modelValue={query} onUpdateModelValue={setQuery} icon="search" placeholder={t('chat.invite.search')} autocomplete="off" />
      <ul className="-mx-1 flex max-h-72 flex-col overflow-y-auto">
        {candidates.map(u => (
          <li key={u.id}>
            <UiCheckbox modelValue={picked.has(u.id)} className="w-full rounded-md px-1 hover:bg-accent/40" onUpdateModelValue={() => toggle(u.id)}>
              <span className="flex items-center gap-2">
                <UiAvatar src={u.avatar_url} alt={u.display_name || u.username} fallback={(u.display_name || u.username).charAt(0).toUpperCase()} className="h-6 w-6 text-[11px]" />
                <span className="text-sm text-foreground">{u.display_name || u.username}</span>
                <span className="text-xs text-muted-foreground">@{u.username}</span>
              </span>
            </UiCheckbox>
          </li>
        ))}
        {candidates.length === 0 && (
          <li>
            <UiEmptyState variant="inline" title={t('chat.invite.noResults')} />
          </li>
        )}
      </ul>
    </UiModal>
  )
}

export default ChatInviteModal
