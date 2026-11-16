/**
 * 메일 사이드바.
 * 계정 줄 32 · "새 메일 C" 40 · 폴더 34 · 예약함(예약이 있을 때) · 라벨(서버가 키워드를 지원할 때만) · 최하단 "메일 설정 · 필터 · 서명".
 * 라벨 줄: 34 · 색점 8(좌우 4) · muted 글자. 선택 시 폴더와 동일한 primary/13 + 600, 재선택 시 해제.
 * 기존 기능 유지: 다계정 트리(계정별 폴더 지연 조회), 폴더 생성·이름 변경·삭제(사용자 폴더만).
 * 필터 모달은 /settings/mail 필터 탭으로 이전함 — 여기서는 링크만 제공.
 * 최하단 "연락처"는 레일에 없는 연락처의 데스크톱 진입점.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
// class 를 단순 연결(tailwind-merge 를 사용하는 cn 은 leading-[1.35]+text-xl 같은 조합을 제거함)
import { clsx as cx } from 'clsx'
import { useMail, mailStore } from '~/composables/useMail'
import { usePlatform } from '~/composables/usePlatform'
import { confirmBox, promptBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'
import { labelTone } from '~/utils/mailQuery'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiBadge } from '~/components/ui/Badge'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiInput } from '~/components/ui/Input'
import { UiMenu } from '~/components/ui/Menu'
import { MailSidebarFolder } from '~/components/mail/MailSidebarFolder'

const PROTECTED_ROLES = new Set(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive'])
function isProtected(mb: any) { return mb.role && PROTECTED_ROLES.has(mb.role) }

export interface MailSidebarProps {
  /** 폴더·라벨·링크 선택 후 호출(드로어 닫기) */
  onNavigate?: () => void
}

/** 메일 폴더 사이드바 */
export function MailSidebar({ onNavigate }: MailSidebarProps) {
  const { t } = useI18n()
  const {
    mailboxes, selectedMailboxId, selectedAccountId, accounts,
    mailboxesByAccount, loadingAccountId, fetchMailboxesFor, selectAccountMailbox,
    selectMailbox, createMailbox, renameMailbox, deleteMailbox, openCompose,
    labelInfo, labelFilter, setLabelFilter, fetchLabels, scheduled, scheduledView, fetchScheduled, openScheduled,
    mailboxesError, fetchMailboxes, fetchMessages,
  } = useMail()
  const emit = () => onNavigate?.()

  // 메일함 조회 실패 — 폴더 영역이 빈 상태로 남지 않도록 오류 띠 + 재시도 표시
  async function retryMailboxes() {
    await fetchMailboxes()
    if (!mailStore.getState().mailboxesError) await fetchMessages()
  }
  const { isModuleEnabled } = usePlatform()
  const contactsEnabled = isModuleEnabled('contacts')

  const isMulti = accounts.length > 1
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const currentAccount = accounts.find(a => a.id === selectedAccountId) || accounts[0] || null

  async function toggleAccount(id: string) {
    const s = new Set(expanded)
    if (s.has(id)) s.delete(id)
    else { s.add(id); await fetchMailboxesFor(id) }
    setExpanded(s)
  }
  async function selectTreeFolder(accountId: string, mailboxId: string) {
    await selectAccountMailbox(accountId, mailboxId)
    emit()
  }
  // 라벨은 메일함 단위(IMAP FLAGS) — 폴더·계정 변경 시 재조회
  useEffect(() => { void fetchLabels() }, [selectedMailboxId, selectedAccountId, fetchLabels])
  const pendingScheduled = scheduled.filter(s => s.status !== 'sent' && s.status !== 'cancelled').length
  function pickLabel(l: string) {
    void setLabelFilter(l)
    emit()
  }
  function pickScheduled() {
    openScheduled()
    emit()
  }
  useEffect(() => {
    void fetchScheduled()
    const s = mailStore.getState()
    if (s.accounts.length > 1 && s.selectedAccountId) {
      setExpanded(new Set([s.selectedAccountId]))
      void fetchMailboxesFor(s.selectedAccountId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleSelect(id: string) {
    selectMailbox(id)
    emit()
  }
  function compose() {
    openCompose('new')
    emit()
  }

  async function addFolder() {
    const name = (await promptBox(t('mail.folder.newName'), { placeholder: t('mail.folder.namePlaceholder') }))?.trim()
    if (!name) return
    try { await createMailbox(name) } catch (e: any) { addToast('error', e?.data?.detail || t('mail.folder.createFailed')) }
  }

  // 사용자 폴더 메뉴(⋯) — 이름 변경 인라인 편집
  const [renaming, setRenaming] = useState<string | null>(null)
  const renamingRef = useRef<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  function startRename(id: string | null) { renamingRef.current = id; setRenaming(id) }
  function folderMenu() {
    return [
      { key: 'rename', label: t('mail.folder.rename'), icon: 'edit' },
      { key: 'delete', label: t('common.delete'), icon: 'trash', danger: true },
    ]
  }
  async function onFolderMenu(mb: any, key: string) {
    if (key === 'rename') { startRename(mb.id); setRenameValue(mb.name); return }
    if (!await confirmBox(t('mail.folder.deleteConfirm', { name: mb.name }), { title: t('mail.folder.deleteTitle'), confirmLabel: t('common.delete'), danger: true })) return
    try { await deleteMailbox(mb.id) } catch (e: any) { addToast('error', e?.data?.detail || t('mail.folder.deleteFailed')) }
  }
  async function handleRename(mb: any) {
    if (renamingRef.current !== mb.id) return // submit 후 blur 가 한 번 더 호출함
    const newName = renameValue.trim()
    startRename(null)
    if (!newName || newName === mb.name) return
    try { await renameMailbox(mb.id, newName) } catch (e: any) { addToast('error', e?.data?.detail || t('mail.folder.renameFailed')) }
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col gap-0.5 border-r border-border bg-card px-2.5 py-3 text-[13.5px]" aria-label={t('mail.folder.navLabel')}>
      {/* 계정 줄 */}
      {!isMulti && (
        <div className="flex h-8 items-center gap-2 pl-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{currentAccount?.email}</span>
          {/* POP3 는 서버에 폴더를 생성할 수 없음(받은편지함 하나) */}
          {currentAccount?.protocol !== 'pop3' && <UiIconButton label={t('mail.folder.addTitle')} icon="plus" className="h-7 w-7" onClick={addFolder} />}
        </div>
      )}

      {/* 새 메일 C */}
      <button
        type="button"
        className="mb-2.5 mt-1 flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary text-[13px] font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background"
        onClick={compose}
      >
        <UiIcon name="pen" strokeWidth="2.2" className="h-[15px] w-[15px]" />{t('mail.compose.new')}
        <span className="font-mono text-[11px] opacity-80" aria-hidden="true">C</span>
      </button>

      <nav className="min-h-0 flex-1 overflow-y-auto">
        {isMulti
          ? (
            // 다계정: 계정별 폴더 트리
            accounts.map(acct => (
              <div key={acct.id} className="mb-1">
                <button
                  type="button"
                  aria-expanded={expanded.has(acct.id)}
                  className="flex h-10 w-full items-center gap-2 rounded-sm px-2 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground md:h-8"
                  onClick={() => toggleAccount(acct.id)}
                >
                  <UiIcon name="chevron-right" className={cx('h-3 w-3 shrink-0 transition-transform', expanded.has(acct.id) ? 'rotate-90' : '')} strokeWidth={2.5} />
                  <span className="min-w-0 flex-1 truncate text-left">{acct.email || acct.display_name}</span>
                  {acct.is_builtin && <UiBadge tone="primary" tint size={18}>{t('mail.accounts.builtin')}</UiBadge>}
                </button>
                {expanded.has(acct.id) && (
                  <div className="mt-0.5 flex flex-col gap-0.5">
                    {loadingAccountId === acct.id && !mailboxesByAccount[acct.id] && <div className="py-1.5 pl-7 text-xs text-muted-foreground">{t('common.loading')}</div>}
                    {(mailboxesByAccount[acct.id] || []).map(mb => (
                      <MailSidebarFolder
                        key={mb.id}
                        mb={mb}
                        indent
                        active={!scheduledView && selectedAccountId === acct.id && selectedMailboxId === mb.id}
                        onSelect={() => selectTreeFolder(acct.id, mb.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))
          )
          : (
            // 단일 계정: 폴더 목록 + 폴더 관리
            <div className="flex flex-col gap-0.5">
              {mailboxesError && <UiErrorTile placement="card" title={t('mail.list.mailboxesFailed')} onRetry={retryMailboxes} />}
              {mailboxes.map(mb => (renaming === mb.id
                ? (
                  <form key={mb.id} className="px-1 py-0.5" onSubmit={(e) => { e.preventDefault(); void handleRename(mb) }}>
                    <UiInput
                      modelValue={renameValue}
                      onUpdateModelValue={setRenameValue}
                      aria-label={t('mail.folder.namePlaceholder')}
                      autoFocus
                      onKeyDown={(e) => { if (e.key === 'Escape') startRename(null) }}
                      onBlur={() => { void handleRename(mb) }}
                    />
                  </form>
                )
                : (
                  <MailSidebarFolder
                    key={mb.id}
                    mb={mb}
                    active={!scheduledView && selectedMailboxId === mb.id}
                    onSelect={() => handleSelect(mb.id)}
                    actions={!isProtected(mb) && currentAccount?.protocol !== 'pop3'
                      ? (
                        <UiMenu
                          label={t('mail.folder.menu', { name: mb.name })}
                          items={folderMenu()}
                          width={160}
                          onSelect={key => onFolderMenu(mb, key)}
                          trigger={({ toggle, open, controls }) => (
                            <UiIconButton
                              label={t('mail.folder.menu', { name: mb.name })}
                              icon="more-horizontal"
                              aria-haspopup="menu"
                              aria-expanded={open}
                              aria-controls={controls}
                              className={cx('h-10 w-10 md:h-7 md:w-7 md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100', open ? 'md:opacity-100' : '')}
                              onClick={(e) => { e.stopPropagation(); toggle() }}
                            />
                          )}
                        />
                      )
                      : undefined}
                  />
                )))}
            </div>
          )}

        {/* 예약함: 예약이 있거나 조회 중일 때만 표시 */}
        {(pendingScheduled > 0 || scheduledView) && (
          <MailSidebarFolder
            mb={{ id: '__scheduled', name: t('mail.scheduled.title'), role: 'scheduled', unread_count: pendingScheduled, total_count: pendingScheduled }}
            active={scheduledView}
            className="mt-0.5"
            onSelect={pickScheduled}
          />
        )}

        {/* 라벨 — 서버가 키워드를 지원할 때만 */}
        {labelInfo.supported && labelInfo.labels.length > 0 && (
          <>
            <h3 className="px-2 pb-1 pt-3.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('mail.labels.title')}</h3>
            {labelInfo.labels.map(l => (
              <button
                key={l}
                type="button"
                aria-pressed={labelFilter === l}
                className={cx(
                  'flex h-10 w-full min-w-0 items-center gap-2.5 rounded-sm px-2 text-left text-[13.5px] transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:h-[34px]',
                  labelFilter === l ? 'bg-primary/[0.13] font-semibold text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
                onClick={() => pickLabel(l)}
              >
                <span className="mx-1 h-2 w-2 shrink-0 rounded-full" style={{ background: `hsl(var(--${labelTone(l)}))` }} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{l}</span>
              </button>
            ))}
          </>
        )}
      </nav>

      {/* 연락처 — 메일 모듈의 하위(레일에는 없음) */}
      {contactsEnabled && (
        <NuxtLink
          to="/contacts"
          className="mt-auto flex h-10 shrink-0 items-center gap-2 rounded-sm px-2 text-[13px] text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:h-[34px]"
          onClick={emit}
        >
          <UiIcon name="users" className="h-[15px] w-[15px]" />{t('nav.contacts')}
        </NuxtLink>
      )}
      <NuxtLink
        to="/settings/mail"
        className={cx('flex h-10 shrink-0 items-center gap-2 rounded-sm px-2 text-[13px] text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:h-[34px]', contactsEnabled ? '' : 'mt-auto')}
        onClick={emit}
      >
        <UiIcon name="settings" className="h-[15px] w-[15px]" />{t('mail.sidebar.settingsLink')}
      </NuxtLink>
    </aside>
  )
}

export default MailSidebar
