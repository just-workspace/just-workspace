/**
 * 새 채널 만들기 모달(이름 · 종류 · 공개/비공개 · 설명 · 멤버). Vue 원본: frontend/components/chat/ChatCreateModal.vue
 * 원본이 공용 UiModal 이 아닌 자체 오버레이라 그대로 옮긴다.
 * 종류(handover-22 §5.1): 텍스트 · 음성(handover-20) · 포럼(= 게시판 데이터의 채팅 보기 — 같은 이름 새 게시판 / 기존 게시판 연결,
 *   chatApi22.createForumChannel). categoryId 를 주면 만든 뒤 그 카테고리 맨 아래로 옮긴다(PATCH /layout — useChatLayout).
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '~/i18n'
import { chatStore, createChannel, fetchChannels, searchUsers, selectChannel } from '~/composables/useChat'
import { createForumChannel } from '~/composables/chatApi22'
import { patchLayout } from '~/composables/useChatLayout'
import { $fetch } from '~/lib/api'
import { UiButton } from '~/components/ui/Button'
import { UiSelect } from '~/components/ui/Select'

export interface ChatCreateModalProps {
  onClose?: () => void
  /** 이 카테고리로 만든다(사이드바 카테고리 +). null·없음 = 분류 없음 */
  categoryId?: string | null
}

type Kind = 'text' | 'voice' | 'forum'
type BoardLite = { id: string; name: string }

type Picked = { id: string; username: string; display_name: string | null }

/** 새 채널 만들기 */
export function ChatCreateModal({ onClose, categoryId = null }: ChatCreateModalProps) {
  const { t } = useI18n()

  const [name, setName] = useState('')
  const [type, setType] = useState<'public' | 'private'>('public')
  // 종류 — 음성(handover-20, 글 대신 소리로 모이는 방) · 포럼(게시판 글을 채팅에서)
  const [kind, setKind] = useState<Kind>('text')
  // 포럼 게시판: '' = 같은 이름으로 새 게시판, 그 밖 = 기존 게시판 id
  const [boardId, setBoardId] = useState('')
  const [boards, setBoards] = useState<BoardLite[]>([])
  useEffect(() => {
    if (kind !== 'forum' || boards.length) return
    $fetch<BoardLite[]>('/api/board/boards').then(r => setBoards(Array.isArray(r) ? r : [])).catch(() => setBoards([]))
  }, [kind, boards.length])
  const [description, setDescription] = useState('')
  const [memberQuery, setMemberQueryState] = useState('')
  // 디바운스 타이머는 "그 순간" 값을 읽는다(Vue memberQuery.value)
  const queryRef = useRef('')
  const setMemberQuery = (v: string) => { queryRef.current = v; setMemberQueryState(v) }
  const [memberResults, setMemberResults] = useState<Array<{ id: string; username: string; display_name: string | null; avatar_url: string | null }>>([])
  const [selectedMembers, setSelectedMembers] = useState<Picked[]>([])
  const [creating, setCreating] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  function onSearchInput(v: string) {
    setMemberQuery(v)
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(async () => {
      if (queryRef.current.trim().length < 1) {
        setMemberResults([])
        return
      }
      setMemberResults(await searchUsers(queryRef.current))
    }, 300)
  }

  function addMember(u: Picked) {
    if (!selectedMembers.find(m => m.id === u.id)) {
      setSelectedMembers([...selectedMembers, { id: u.id, username: u.username, display_name: u.display_name }])
    }
    setMemberQuery('')
    setMemberResults([])
  }

  function removeMember(id: string) {
    setSelectedMembers(selectedMembers.filter(m => m.id !== id))
  }

  async function onSubmit() {
    if (!name.trim()) return
    setCreating(true)
    setErrorMessage('')
    try {
      const desc = description.trim() || undefined
      const ids = selectedMembers.map(m => m.id)
      let id: string
      if (kind === 'forum') {
        const r = await createForumChannel(name.trim(), type, { description: desc, member_ids: ids, ...(boardId ? { board_id: boardId } : {}) }) as { id: string }
        await fetchChannels()
        id = r.id
      } else {
        id = (await createChannel(name.trim(), type, desc, ids, kind === 'voice')).id
      }
      if (categoryId) {
        const pos = chatStore.getState().channels.filter(c => c.category_id === categoryId && c.id !== id).length
        try { await patchLayout({ channels: [{ id, category_id: categoryId, position: pos }] }); await fetchChannels() } catch { /* 분류 없음에 남는다 */ }
      }
      await selectChannel(id)
      onClose?.()
    } catch (e: any) {
      const detail = e?.data?.detail || e?.message || t('chat.create.error')
      setErrorMessage(typeof detail === 'string' ? detail : t('chat.create.error'))
    } finally {
      setCreating(false)
    }
  }

  // body 로 포털 — 세로 화면에서는 채널 목록이 서랍(z-drawer) 안이라, 안에서 그리면 모달이 그 층에 갇혀 셸 메뉴가 막 위에 남는다
  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }} role="dialog" aria-modal="true">
      <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md mx-3 max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-base font-semibold text-foreground">{t('chat.create.title')}</h3>
          <button type="button" onClick={() => onClose?.()} className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-accent" aria-label={t('common.close')}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void onSubmit() }} className="p-5 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium mb-1 text-foreground">{t('chat.create.name')}</label>
            <input
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              type="text"
              placeholder={t('chat.create.namePlaceholder')}
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-hidden focus:ring-2 focus:ring-ring"
              maxLength={100}
              required
            />
          </div>

          {/* Type */}
          <div>
            <label className="block text-sm font-medium mb-1 text-foreground">{t('chat.create.type')}</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" checked={type === 'public'} onChange={() => setType('public')} value="public" className="accent-primary" />
                {t('chat.create.public')}
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" checked={type === 'private'} onChange={() => setType('private')} value="private" className="accent-primary" />
                {t('chat.create.private')}
              </label>
            </div>
          </div>

          {/* 종류 — 텍스트 · 음성(handover-20) · 포럼(handover-22 §5.1). 공개/비공개와 별개 */}
          <fieldset>
            <legend className="block text-sm font-medium mb-1 text-foreground">{t('chat.side.create.kind')}</legend>
            <div role="radiogroup" aria-label={t('chat.side.create.kind')} className="flex gap-4">
              {(['text', 'voice', 'forum'] as const).map(k => (
                <label key={k} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="chat-create-kind" checked={kind === k} onChange={() => setKind(k)} value={k} className="accent-primary" />
                  {t(`chat.side.create.kind_${k}`)}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t(`chat.side.create.hint_${kind}`)}</p>
          </fieldset>
          {kind === 'forum' && (
            <UiSelect
              label={t('chat.side.create.board')}
              modelValue={boardId}
              onUpdateModelValue={(v) => setBoardId(String(v ?? ''))}
              placeholder=""
              options={[{ value: '', label: t('chat.side.create.newBoard') }, ...boards.map(b => ({ value: b.id, label: b.name }))]}
            />
          )}


          {/* Description */}
          <div>
            <label className="block text-sm font-medium mb-1 text-foreground">{t('chat.create.description')}</label>
            <input
              autoComplete="off"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              type="text"
              placeholder={t('chat.create.descriptionPlaceholder')}
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-hidden focus:ring-2 focus:ring-ring"
              maxLength={500}
            />
          </div>

          {/* Members */}
          <div>
            <label className="block text-sm font-medium mb-1 text-foreground">{t('chat.create.members')}</label>
            <input
              autoComplete="off"
              value={memberQuery}
              onChange={(e) => onSearchInput(e.target.value)}
              type="text"
              placeholder={t('chat.create.memberSearch')}
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            {/* Search results */}
            {memberResults.length > 0 && (
              <div className="mt-1 border border-border rounded-md bg-card max-h-32 overflow-y-auto">
                {memberResults.map(u => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => addMember(u)}
                    className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent transition-colors"
                  >
                    {u.display_name || u.username}{' '}
                    <span className="text-muted-foreground ml-1">@{u.username}</span>
                  </button>
                ))}
              </div>
            )}
            {/* Selected members */}
            {selectedMembers.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {selectedMembers.map(m => (
                  <span
                    key={m.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border border-border bg-accent text-foreground"
                  >
                    {m.display_name || m.username}
                    <button type="button" onClick={() => removeMember(m.id)} className="hover:text-destructive">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Error */}
          {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}

          {/* Submit */}
          <div className="flex justify-end gap-2 pt-2">
            <UiButton type="button" variant="outline" onClick={() => onClose?.()}>
              {t('common.cancel')}
            </UiButton>
            <UiButton
              type="submit"
              disabled={!name.trim() || creating}
            >
              {creating ? t('chat.create.creating') : t('chat.create.submit')}
            </UiButton>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}

export default ChatCreateModal
