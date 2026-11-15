/**
 * 카테고리 대화 상자·인라인 편집(#cat-rename · #cat-del) + DM 구역 + 의 새 메시지 고르기.
 *  · 만들기(440): 제목 · 설명 · "카테고리 이름" 입력 · 비공개 카테고리 스위치(+ 설명) · [취소][만들기].
 *    비공개면 @everyone 에 VIEW_CHANNEL 거부 덮어쓰기를 넣고 채팅 설정 category-perm 을 연다(고른 역할·멤버를 거기서 더한다).
 *  · 이름 바꾸기: 제목 줄 자리에 28 높이 입력(2px ring) + 오른쪽 "Enter 저장 · Esc 취소". 빈 값·같은 값이면 취소.
 *  · 삭제(alertdialog 440): 안의 채널 이름 목록을 보여 주고 "분류 없음"으로 옮겨진다고 알린다. 채널 목록은 지운 뒤 다시 읽는다.
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { chatStore, fetchChannels, openDM, presenceOf } from '~/composables/useChat'
import { createCategory, deleteCategory, renameCategory, type SidebarSection } from '~/composables/useChatLayout'
import { loadRoles, putOverwrite, PERM } from '~/composables/useChatRoles'
import { openChatSettings, initialOf } from '~/composables/useChatUi'
import { addToast } from '~/composables/useToast'
import { UiModal } from '~/components/ui/Modal'
import { UiButton } from '~/components/ui/Button'
import { UiInput } from '~/components/ui/Input'
import { UiSwitch } from '~/components/ui/Switch'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { channelLabel } from '~/utils/chatSidebarDnd'

const errText = (e: unknown, fallback: string) => {
  const d = (e as { data?: { detail?: unknown } })?.data?.detail
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string') return (d as { message: string }).message
  return fallback
}

/** 카테고리 만들기(#cat-new) */
export function ChatCategoryCreateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [priv, setPriv] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    setError('')
    try {
      const c = await createCategory(n)
      if (priv) {
        try {
          const roles = await loadRoles(true)
          const everyone = roles.find(r => r.is_default)
          if (everyone) await putOverwrite('categories', c.id, 'role', everyone.id, 0, PERM.VIEW_CHANNEL)
          openChatSettings('category-perm', c.id)
        } catch {
          addToast('warning', t('chat.side.dlg.privateFailed'))
        }
      }
      onClose()
    } catch (e) {
      setError(errText(e, t('chat.side.dlg.createFailed')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <UiModal
      size="440"
      title={t('chat.side.dlg.newTitle')}
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton size="sm" disabled={!name.trim() || busy} onClick={() => { void submit() }}>{t('chat.side.dlg.create')}</UiButton>
        </>
      )}
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <p className="text-[14px] leading-relaxed text-muted-foreground">{t('chat.side.dlg.newDesc')}</p>
        <UiInput
          label={t('chat.side.dlg.name')}
          modelValue={name}
          onUpdateModelValue={setName}
          maxLength={100}
          error={error || undefined}
          data-autofocus=""
        />
        <UiSwitch
          label={t('chat.side.dlg.private')}
          description={t('chat.side.dlg.privateHint')}
          modelValue={priv}
          onUpdateModelValue={setPriv}
        />
      </form>
    </UiModal>
  )
}

/** 카테고리 삭제 확인(#cat-del) */
export function ChatCategoryDeleteDialog({ section, onClose }: { section: SidebarSection; onClose: () => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const names = section.channels.map(channelLabel)

  async function submit() {
    if (!section.category || busy) return
    setBusy(true)
    try {
      await deleteCategory(section.category.id)
      await fetchChannels()
      onClose()
    } catch (e) {
      addToast('error', errText(e, t('chat.side.dlg.deleteFailed')))
      setBusy(false)
    }
  }

  return (
    <UiModal
      size="440"
      confirm
      danger
      title={t('chat.side.dlg.delTitle', { name: section.name })}
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton variant="danger" size="sm" disabled={busy} onClick={() => { void submit() }}>{t('chat.side.dlg.delOk')}</UiButton>
        </>
      )}
    >
      <p className="text-[14px] leading-relaxed text-muted-foreground">
        {names.length
          ? t('chat.side.dlg.delDesc', { n: names.length, list: names.join(' · ') })
          : t('chat.side.dlg.delDescEmpty')}
      </p>
    </UiModal>
  )
}

/** 인라인 이름 바꾸기(#cat-rename) — Enter 저장 · Esc 취소 · 포커스 잃으면 저장 */
export function ChatCategoryRename({ section, onDone }: { section: SidebarSection; onDone: () => void }) {
  const { t } = useI18n()
  const [v, setV] = useState(section.name)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])

  async function save() {
    if (done.current) return
    done.current = true
    const n = v.trim()
    if (n && n !== section.name && section.category) {
      try { await renameCategory(section.category.id, n) } catch (e) { addToast('error', errText(e, t('chat.side.dlg.renameFailed'))) }
    }
    onDone()
  }
  function cancel() {
    done.current = true
    onDone()
  }

  return (
    <div className="flex h-7 items-center gap-1 rounded-md border-2 border-ring bg-card px-1.5 text-[12px] font-semibold">
      <input
        ref={ref}
        value={v}
        maxLength={100}
        aria-label={t('chat.side.dlg.name')}
        className="min-w-0 flex-1 bg-transparent outline-hidden"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void save() }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() }
        }}
        onBlur={() => { void save() }}
      />
      <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{t('chat.side.renameHint')}</span>
    </div>
  )
}

/** DM 구역 + — 사람 골라 1:1 대화 열기(채널|사용자 탭을 없앤 자리) */
export function ChatNewDmDialog({ onClose, onOpened }: { onClose: () => void; onOpened?: () => void }) {
  const { t } = useI18n()
  const me = useStore(authStore, s => s.user)
  const users = useStore(chatStore, s => s.allUsers)
  const [q, setQ] = useState('')
  const term = q.trim().toLowerCase()
  const list = users
    .filter(u => u.id !== me?.id)
    .filter(u => !term || (u.display_name || '').toLowerCase().includes(term) || u.username.toLowerCase().includes(term))
    .slice(0, 50)

  async function pick(id: string) {
    try {
      await openDM(id)
      onClose()
      onOpened?.()
    } catch (e) {
      addToast('error', errText(e, t('chat.side.actionFailed')))
    }
  }

  return (
    <UiModal size="440" title={t('chat.side.dlg.dmTitle')} onClose={onClose}>
      <div className="flex flex-col gap-2">
        <UiInput modelValue={q} onUpdateModelValue={setQ} placeholder={t('chat.side.dlg.dmSearch')} aria-label={t('chat.side.dlg.dmSearch')} data-autofocus="" />
        <ul className="flex max-h-[50dvh] flex-col overflow-y-auto">
          {list.map(u => (
            <li key={u.id}>
              <DmPick id={u.id} name={u.display_name || u.username} username={u.username} avatar={u.avatar_url} onPick={pick} />
            </li>
          ))}
          {list.length === 0 && <li className="px-2 py-3 text-[14px] text-muted-foreground">{t('chat.sidebar.noUsers')}</li>}
        </ul>
      </div>
    </UiModal>
  )
}

function DmPick({ id, name, username, avatar, onPick }: { id: string; name: string; username: string; avatar: string | null; onPick: (id: string) => void }) {
  const state = useStore(chatStore, s => presenceOf(id, s).state)
  return (
    <button type="button" className="flex h-11 w-full items-center gap-3 rounded-lg px-2 text-left text-[15px] hover:bg-overlay-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => onPick(id)}>
      <span className="relative shrink-0">
        <UiAvatar src={avatar} alt={name} fallback={initialOf(name)} className="h-8 w-8" textSize={12} />
        <UiStatusDot status={state} size={10} ring="background" className="absolute -bottom-0.5 -right-0.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 font-mono text-[12px] text-muted-foreground">@{username}</span>
    </button>
  )
}
