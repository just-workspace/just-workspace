/**
 * 모바일 ⋯ 시트 — Vue 판 components/contacts/ContactsMobileMenu.vue ("주소록·그룹·가져오기·내보내기"): 항목 48.
 * 범위(모든 연락처 · 즐겨찾기 · 워크스페이스 사용자 · 주소록 · 그룹) 선택 + 새 주소록 + vCard 가져오기/내보내기 + 연동 계정.
 * 페이지가 mobileMenuOpen 일 때만 마운트한다(닫기 = setMobileMenuOpen(false)).
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '~/i18n'
// Vue 의 class 묶음처럼 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지워 Vue 와 달라진다)
import { clsx as cx } from 'clsx'
import { useContacts, type ContactScope } from '~/composables/useContacts'
import { addToast } from '~/composables/useToast'
import { groupDotColor } from '~/utils/contactsIndex'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiInput } from '~/components/ui/Input'
import { UiButton } from '~/components/ui/Button'
import { ContactsTransferPanel } from '~/components/contacts/ContactsTransferPanel'

const row = 'flex h-12 w-full items-center gap-3 border-b border-border text-left text-[15px]'

/** 연락처 모바일 범위·가져오기 시트(body 로 포털) */
export function ContactsMobileMenu() {
  const { t } = useI18n()
  const { addressBooks, groups, scope, setMobileMenuOpen, selectScope, createAddressBook } = useContacts()

  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')

  function close() { setMobileMenuOpen(false) }
  function pick(s: ContactScope) { selectScope(s); close() }
  function isOn(s: ContactScope) {
    const c = scope
    if (c.kind !== s.kind) return false
    if (c.kind === 'book' && s.kind === 'book') return c.id === s.id
    if (c.kind === 'group' && s.kind === 'group') return c.name === s.name
    return true
  }
  const tops = [
    { s: { kind: 'all' } as ContactScope, label: t('contacts.sidebar.allContacts') },
    { s: { kind: 'favorite' } as ContactScope, label: t('contacts.sidebar.favorites') },
    { s: { kind: 'workspace' } as ContactScope, label: t('contacts.sidebar.workspaceUsers') },
  ]

  async function create() {
    if (!newName.trim()) return
    try {
      await createAddressBook(newName.trim())
      setNewName('')
      setShowNew(false)
    } catch { addToast('error', t('contacts.sidebar.createFailed')) }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setMobileMenuOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setMobileMenuOpen])

  return createPortal(
    <div className="fixed inset-0 z-modal flex flex-col justify-end bg-scrim" onClick={(e) => { if (e.target === e.currentTarget) close() }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('contacts.mobile.menu')}
        className="max-h-[80dvh] overflow-y-auto rounded-t-sheet border-t border-border bg-card px-4 pt-2.5 animate-slide-up"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 24px)' }}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-muted" aria-hidden="true" />
        <div className="mb-1 flex items-center">
          <span className="flex-1 text-[17px] font-semibold text-foreground">{t('contacts.sidebar.addressBooks')}</span>
          <UiIconButton label={t('common.close')} icon="close" size="md" noTooltip onClick={close} />
        </div>

        {tops.map(it => (
          <button
            key={it.s.kind}
            type="button"
            className={cx(row, isOn(it.s) ? 'font-semibold text-foreground' : 'text-foreground')}
            aria-current={isOn(it.s) ? 'true' : undefined}
            onClick={() => pick(it.s)}
          >
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {isOn(it.s) && <UiIcon name="check" className="h-[18px] w-[18px] text-primary" />}
          </button>
        ))}
        {addressBooks.map(b => (
          <button
            key={b.id}
            type="button"
            className={cx(row, isOn({ kind: 'book', id: b.id }) ? 'font-semibold text-foreground' : 'text-foreground')}
            aria-current={isOn({ kind: 'book', id: b.id }) ? 'true' : undefined}
            onClick={() => pick({ kind: 'book', id: b.id })}
          >
            <span className="min-w-0 flex-1 truncate">{b.name}</span>
            {isOn({ kind: 'book', id: b.id }) && <UiIcon name="check" className="h-[18px] w-[18px] text-primary" />}
          </button>
        ))}

        {!showNew
          ? (
            <button type="button" className={cx(row, 'text-foreground')} onClick={() => setShowNew(true)}>
              <UiIcon name="plus" className="h-[18px] w-[18px] text-muted-foreground" />{t('contacts.sidebar.addAddressBook')}
            </button>
          )
          : (
            <div className="flex flex-col gap-2.5 border-b border-border py-3">
              <UiInput
                modelValue={newName}
                onUpdateModelValue={setNewName}
                size="lg"
                aria-label={t('contacts.sidebar.addressBookNamePlaceholder')}
                placeholder={t('contacts.sidebar.addressBookNamePlaceholder')}
                onKeyUp={(e) => { if (e.key === 'Enter') void create() }}
              />
              <div className="flex justify-end gap-2">
                <UiButton variant="ghost" size="sm" onClick={() => setShowNew(false)}>{t('common.cancel')}</UiButton>
                <UiButton size="sm" disabled={!newName.trim()} onClick={create}>{t('common.add')}</UiButton>
              </div>
            </div>
          )}

        {groups.length > 0 && (
          <>
            <div className="pb-1 pt-4 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('contacts.sidebar.groups')}</div>
            {groups.map(g => (
              <button
                key={g.name}
                type="button"
                className={cx(row, isOn({ kind: 'group', name: g.name }) ? 'font-semibold text-foreground' : 'text-foreground')}
                aria-current={isOn({ kind: 'group', name: g.name }) ? 'true' : undefined}
                onClick={() => pick({ kind: 'group', name: g.name })}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: groupDotColor(g.name) }} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                {isOn({ kind: 'group', name: g.name }) && <UiIcon name="check" className="h-[18px] w-[18px] text-primary" />}
              </button>
            ))}
          </>
        )}

        <div className="pb-1 pt-4 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('contacts.transfer.title')}</div>
        <ContactsTransferPanel touch className="-mx-2.5" />
      </div>
    </div>,
    document.body,
  )
}

export default ContactsMobileMenu
