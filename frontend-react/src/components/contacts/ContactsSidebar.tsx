/**
 * 연락처 사이드바 — Vue 판 components/contacts/ContactsSidebar.vue.
 * 236 bg-card, [+ 새 연락처] 40 primary,
 * 범위 행 34(선택 = primary/13 + 600, 개수 mono 12) — 모든 연락처 · 즐겨찾기 · 워크스페이스 사용자 /
 * 주소록(섹션 11/600 트래킹) / 그룹(점 8 + 이름) / "가져오기 · 내보내기 (vCard)".
 * 1024 미만에서는 페이지가 이 사이드바를 그리지 않고 FAB + ⋯ 시트(ContactsMobileMenu)를 쓴다.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
// Vue 의 class 묶음처럼 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지워 Vue 와 달라진다)
import { clsx as cx } from 'clsx'
import { useContacts } from '~/composables/useContacts'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { groupDotColor } from '~/utils/contactsIndex'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiInput } from '~/components/ui/Input'
import { ContactsTransferPanel } from '~/components/contacts/ContactsTransferPanel'

const row = 'flex h-[34px] w-full items-center gap-2.5 rounded-sm px-2.5 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
const on = 'bg-primary/[0.13] font-semibold text-foreground'
const off = 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'

/** 연락처 사이드바(데스크톱 ≥1024). props 없음 — 상태는 useContacts. */
export function ContactsSidebar() {
  const { t } = useI18n()
  const {
    addressBooks, selectedBookId, loadingBooks, totalContacts, scope, groups, counts,
    fetchAddressBooks, selectBook, selectScope, createAddressBook, deleteAddressBook, openCreateModal,
  } = useContacts()

  const isAll = scope.kind === 'all'
  const isFav = scope.kind === 'favorite'
  const isWs = scope.kind === 'workspace'
  function isGroup(name: string) { return scope.kind === 'group' && scope.name === name }

  const [showNewForm, setShowNewForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [showTransfer, setShowTransfer] = useState(false)

  useEffect(() => {
    if (addressBooks.length === 0) fetchAddressBooks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleCreate() {
    if (!newName.trim()) return
    try {
      await createAddressBook(newName.trim())
      setNewName('')
      setShowNewForm(false)
    } catch { addToast('error', t('contacts.sidebar.createFailed')) }
  }

  async function handleDelete(id: string, name: string) {
    if (!await confirmBox(t('contacts.sidebar.deleteConfirm', { name }), { danger: true, confirmLabel: t('common.delete') })) return
    await deleteAddressBook(id)
  }

  return (
    <div className="flex flex-col p-3 text-[13.5px]">
      <UiButton className="mb-3 h-10 w-full gap-1.5 text-[13px] font-semibold" onClick={() => openCreateModal()}>
        <UiIcon name="plus" className="h-4 w-4" strokeWidth={2.4} />{t('contacts.sidebar.newContact')}
      </UiButton>

      <button type="button" className={cx(row, isAll ? on : off)} aria-current={isAll ? 'page' : undefined} onClick={() => selectScope({ kind: 'all' })}>
        <span className="min-w-0 flex-1 truncate">{t('contacts.sidebar.allContacts')}</span>
        {(isAll || counts.all != null) && <span className="font-mono text-xs">{isAll ? totalContacts : counts.all}</span>}
      </button>
      <button type="button" className={cx(row, isFav ? on : off)} aria-current={isFav ? 'page' : undefined} onClick={() => selectScope({ kind: 'favorite' })}>
        <span className="min-w-0 flex-1 truncate">{t('contacts.sidebar.favorites')}</span>
        {(isFav || counts.favorite != null) && <span className="font-mono text-xs">{isFav ? totalContacts : counts.favorite}</span>}
      </button>
      <button type="button" className={cx(row, isWs ? on : off)} aria-current={isWs ? 'page' : undefined} onClick={() => selectScope({ kind: 'workspace' })}>
        <span className="min-w-0 flex-1 truncate">{t('contacts.sidebar.workspaceUsers')}</span>
        {(isWs || counts.workspace != null) && <span className="font-mono text-xs">{isWs ? totalContacts : counts.workspace}</span>}
      </button>

      <div className="flex items-center justify-between px-2.5 pb-1 pt-3.5">
        <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('contacts.sidebar.addressBooks')}</h3>
        <UiIconButton label={t('contacts.sidebar.addAddressBook')} icon="plus" className="-my-1 h-7 w-7" pressed={showNewForm} onClick={() => setShowNewForm(!showNewForm)} />
      </div>

      {loadingBooks
        ? <UiSkeleton preset="list" rows={2} />
        : addressBooks.map(book => (
          <div key={book.id} className="group relative">
            <button
              type="button"
              className={cx(row, 'pr-9', selectedBookId === book.id ? on : off)}
              aria-current={selectedBookId === book.id ? 'page' : undefined}
              onClick={() => selectBook(book.id)}
            >
              <span className="min-w-0 flex-1 truncate">{book.name}</span>
              {selectedBookId === book.id && <span className="font-mono text-xs group-hover:invisible group-focus-within:invisible">{totalContacts}</span>}
            </button>
            <UiIconButton
              label={t('contacts.sidebar.deleteBook', { name: book.name })}
              icon="trash"
              className="absolute right-0.5 top-0.5 h-7 w-7 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              onClick={() => handleDelete(book.id, book.name)}
            />
          </div>
        ))}

      {showNewForm && (
        <div className="mt-1.5 flex flex-col gap-2 rounded-md border border-border p-2.5">
          <UiInput
            modelValue={newName}
            onUpdateModelValue={setNewName}
            aria-label={t('contacts.sidebar.addressBookNamePlaceholder')}
            placeholder={t('contacts.sidebar.addressBookNamePlaceholder')}
            onKeyUp={(e) => { if (e.key === 'Enter') void handleCreate() }}
          />
          <div className="flex justify-end gap-1.5">
            <UiButton variant="ghost" size="xs" onClick={() => setShowNewForm(false)}>{t('common.cancel')}</UiButton>
            <UiButton size="xs" disabled={!newName.trim()} onClick={handleCreate}>{t('common.add')}</UiButton>
          </div>
        </div>
      )}

      {/* 그룹(연락처 편집 폼에서 붙인 이름) */}
      {groups.length > 0 && (
        <>
          <h3 className="px-2.5 pb-1 pt-3.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('contacts.sidebar.groups')}</h3>
          {groups.map(g => (
            <button
              key={g.name}
              type="button"
              className={cx(row, 'gap-2', isGroup(g.name) ? on : off)}
              aria-current={isGroup(g.name) ? 'page' : undefined}
              onClick={() => selectScope({ kind: 'group', name: g.name })}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: groupDotColor(g.name) }} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{g.name}</span>
              <span className="font-mono text-xs">{isGroup(g.name) ? totalContacts : g.count}</span>
            </button>
          ))}
        </>
      )}

      <button
        type="button"
        className="mt-3.5 self-start rounded-sm px-2.5 text-xs font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={showTransfer}
        onClick={() => setShowTransfer(!showTransfer)}
      >{t('contacts.transfer.link')}</button>
      {showTransfer && <ContactsTransferPanel className="mt-2 rounded-md border border-border p-1.5" />}
    </div>
  )
}

export default ContactsSidebar
