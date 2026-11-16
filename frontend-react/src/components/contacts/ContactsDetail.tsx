/**
 * 연락처 상세.
 * 데스크톱: 본문 패딩 28/40, 폭 680. 헤더 = 이니셜 72 · 이름 24/700(-0.02em) · 보조 13.5 muted · [편집] 36 outline · ⋯ 36.
 *   행동 행 4칸(64, rounded-lg card, 아이콘 18 primary + 12/600): 메일 쓰기 · 채팅 · 통화 · 일정 잡기 — mailto 폐지.
 *   정보 카드(rounded-lg card): 행 48 = 라벨 100(12 muted) | 값 13.5 | 행동(복사 12/600 primary).
 * 모바일: 상세 상단 바(‹ 연락처 목록으로 · 편집 · ⋯) + 가운데 정렬 헤더(80 · 22/700 · 14) + 행동 4칸 + 정보 카드(행 60, 라벨 위 값 아래 15).
 * 채팅·통화는 이메일이 워크스페이스 사용자에 해당할 때만 활성화(시안 문구).
 * 사진(있으면 이미지, 없으면 이니셜) · 보조 행 "회사 직함 · 그룹" · ⋯ 메뉴(즐겨찾기 · vCard 내보내기 · 삭제, 모바일은 바텀시트).
 * "워크스페이스 사용자" 범위의 행은 주소록 연락처가 아니므로 편집·⋯ 메뉴 없이 행동 행만 표시한다.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
// class 를 단순 연결한다(tailwind-merge 를 사용하는 cn 은 leading-[1.35]+text-xl 같은 조합을 제거한다)
import { clsx as cx } from 'clsx'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { useIsMobile } from '~/composables/useIsMobile'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { openRoom } from '~/composables/useMeetingCall'
import { openCompose } from '~/composables/useMailCompose'
import { useContacts } from '~/composables/useContacts'
import { initialsOf } from '~/utils/contactsIndex'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { writeClipboard } from '~/lib/clipboard'

interface InfoRow { k: string; v: string; copy?: boolean; mono?: boolean; multiline?: boolean }

const actionBtn = 'flex h-16 flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-card text-xs font-semibold text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-card'

/** 연락처 상세 패널(선택 전이면 빈 상태). props 없음 — 상태는 useContacts. */
export function ContactsDetail() {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const {
    selectedContact, addressBooks, openEditModal, deleteContact, findWorkspaceUserId, toggleFavorite, exportOneVcard, setSelectedContact,
  } = useContacts()

  const c = selectedContact
  const primaryEmail = c?.emails?.[0]?.value || ''
  const isWsUser = !!c?.workspace_user_id

  // 워크스페이스 사용자 여부(채팅·통화 활성)
  const [wsUserId, setWsUserId] = useState<string | null>(null)
  const [, setLookingUp] = useState(false)
  const direct = c?.workspace_user_id
  useEffect(() => {
    let alive = true
    setWsUserId(direct || null)
    if (direct || !primaryEmail) return
    setLookingUp(true)
    void findWorkspaceUserId(primaryEmail).then((id) => {
      // 그 사이 다른 연락처로 전환되었으면 결과 폐기
      if (alive) setWsUserId(id)
      setLookingUp(false)
    })
    return () => { alive = false }
  }, [primaryEmail, direct, findWorkspaceUserId])

  /** 보조 행(시안 "Acme 디자인 리드 · 파트너") */
  const subline = (() => {
    const x = c
    if (!x) return ''
    const head = [x.organization, x.title].filter(Boolean).join(' ')
    return [head, ...(x.groups || [])].filter(Boolean).join(' · ')
  })()

  function typeLabel(type: string) {
    const map: Record<string, string> = { home: t('contacts.type.home'), work: t('contacts.type.work'), other: t('contacts.type.other'), cell: t('contacts.type.cell') }
    return map[type?.toLowerCase()] || type
  }

  const bookName = addressBooks.find(b => b.id === c?.address_book_id)?.name ?? ''

  const info: InfoRow[] = (() => {
    const x = c
    if (!x) return []
    const rows: InfoRow[] = []
    for (const e of x.emails ?? []) rows.push({ k: `${t('contacts.detail.emailSection')} · ${typeLabel(e.type)}`, v: e.value, copy: true })
    for (const p of x.phones ?? []) rows.push({ k: `${t('contacts.detail.phoneSection')} · ${typeLabel(p.type)}`, v: p.value, copy: true, mono: true })
    if (x.organization || x.title) rows.push({ k: t('contacts.detail.organization'), v: [x.organization, x.title].filter(Boolean).join(' · ') })
    for (const a of x.addresses ?? []) rows.push({ k: `${t('contacts.detail.addressSection')} · ${typeLabel(a.type)}`, v: a.value, multiline: true })
    if (bookName || x.groups?.length) {
      const g = x.groups?.length ? t('contacts.detail.groupsValue', { names: x.groups.join(', ') }) : ''
      rows.push({ k: t('contacts.sidebar.addressBooks'), v: [bookName, g].filter(Boolean).join(' · ') })
    }
    if (isWsUser) rows.push({ k: t('contacts.sidebar.addressBooks'), v: t('contacts.sidebar.workspaceUsers') })
    if (x.notes) rows.push({ k: t('contacts.detail.notesSection'), v: x.notes, multiline: true })
    return rows
  })()

  async function copy(v: string) {
    try { await writeClipboard(v); addToast('success', t('common.copied')) }
    catch { addToast('error', t('contacts.detail.copyFailed')) }
  }

  // ── 행동 ──
  function composeMail() {
    // 앱 내 작성 창(mailto 폐지) — 데스크톱은 현재 화면의 플로팅 창, 모바일은 /mail/compose?mode=new&to=…
    if (!primaryEmail) return
    openCompose('new', null, null, { to: primaryEmail })
  }

  async function dmChannelId(): Promise<string | null> {
    if (!wsUserId) return null
    try {
      const r = await $fetch<{ id: string }>('/api/chat/dm', { method: 'POST', body: { user_id: wsUserId } })
      return r.id
    } catch { addToast('error', t('contacts.detail.dmFailed')); return null }
  }

  async function openChat() {
    const id = await dmChannelId()
    if (id) void navigateTo({ path: '/chat', query: { channel: id } })
  }

  async function startCall() {
    // 채팅 헤더의 드롭인 통화와 동일한 방(chan-<DM id>)
    const id = await dmChannelId()
    // 동일 탭 회의 화면 — 다른 화면으로 이동하면 미니 통화 창
    if (id) openRoom(`chan-${id}`)
  }

  function schedule() {
    // 캘린더 새 일정 폼 — 해당 사용자를 참석자로 사전 입력
    const query: Record<string, string> = { new: '1' }
    if (primaryEmail) {
      query.attendee = primaryEmail
      if (c?.name) query.name = c.name
    }
    void navigateTo({ path: '/calendar', query })
  }

  const actions = [
    { key: 'mail', icon: 'mail', label: isMobile ? t('contacts.action.mailShort') : t('contacts.action.mail'), run: composeMail, disabled: !primaryEmail, why: t('contacts.action.noEmail') },
    { key: 'chat', icon: 'message-square', label: t('contacts.action.chat'), run: openChat, disabled: !wsUserId, why: t('contacts.action.notMember') },
    { key: 'call', icon: 'video', label: t('contacts.action.call'), run: startCall, disabled: !wsUserId, why: t('contacts.action.notMember') },
    { key: 'event', icon: 'calendar', label: isMobile ? t('contacts.action.eventShort') : t('contacts.action.event'), run: schedule, disabled: false, why: '' },
  ]

  // ── ⋯ 메뉴: 즐겨찾기 · vCard 내보내기 · 삭제 ──
  const menuItems: UiMenuItem[] = [
    { key: 'favorite', label: c?.is_favorite ? t('contacts.detail.unfavorite') : t('contacts.detail.favorite'), icon: 'star' },
    { key: 'vcard', label: t('contacts.detail.exportVcard'), icon: 'download' },
    { key: 'delete', label: t('common.delete'), icon: 'trash', danger: true, separated: true },
  ]
  async function onMenu(key: string) {
    const x = c
    if (!x) return
    if (key === 'favorite') {
      try { await toggleFavorite(x) } catch { addToast('error', t('contacts.detail.favoriteFailed')) }
    } else if (key === 'vcard') {
      try { await exportOneVcard(x) } catch { addToast('error', t('contacts.detail.exportFailed')) }
    } else if (key === 'delete') await handleDelete()
  }
  async function handleDelete() {
    const x = c
    if (!x) return
    if (!await confirmBox(t('contacts.detail.deleteConfirm', { name: x.name }), { danger: true, confirmLabel: t('common.delete') })) return
    await deleteContact(x.id)
  }

  function edit() { if (c) openEditModal(c) }
  function back() { setSelectedContact(null) }

  return (
    <div className="flex h-full flex-col">
      {/* 모바일 상세 상단 바 */}
      {c && (
        <LayoutMobileDetailBar
          title={c.name}
          backLabel={t('contacts.mobile.back')}
          navigate={false}
          onBack={back}
          actions={!isWsUser
            ? (
              <>
                <button type="button" className="h-11 px-3 text-[15px] font-semibold text-primary" onClick={edit}>{t('contacts.detail.editAction')}</button>
                <UiMenu label={t('contacts.detail.moreLabel')} title={c.name} items={menuItems} triggerSize="lg" onSelect={onMenu} />
              </>
            )
            : undefined}
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 선택 전: 메일 읽기 패널과 동일하게 세로 가운데 정렬 */}
        {!c
          ? (
            <div className="flex h-full items-center justify-center">
              <UiEmptyState variant="panel" icon="users" title={t('contacts.detail.empty')} />
            </div>
          )
          : (
            <div className="flex max-w-[680px] flex-col gap-5 px-4 pb-8 pt-5 md:px-10 md:pt-7">
              {/* 헤더 */}
              <div className="flex flex-col items-center gap-1.5 text-center md:flex-row md:gap-[18px] md:text-left">
                {c.photo
                  ? <img src={c.photo} alt="" className="h-20 w-20 shrink-0 rounded-full object-cover md:h-[72px] md:w-[72px]" />
                  : <span className="grid h-20 w-20 shrink-0 place-items-center rounded-full bg-muted text-[28px] font-semibold text-foreground md:h-[72px] md:w-[72px] md:text-[26px]" aria-hidden="true">{initialsOf(c.name || c.first_name)}</span>}
                <div className="min-w-0 md:flex-1">
                  <h1 className="flex items-center gap-2 text-[22px] font-bold text-foreground max-md:justify-center md:text-2xl md:tracking-[-0.02em]">
                    <span className="truncate">{c.name}</span>
                    {c.is_favorite && <UiIcon name="star" filled className="h-4 w-4 shrink-0 text-warning" aria-label={t('contacts.detail.favorited')} />}
                  </h1>
                  {subline && <p className="truncate text-sm text-muted-foreground md:text-[13.5px]">{subline}</p>}
                </div>
                {!isWsUser && (
                  <div className="hidden shrink-0 items-center gap-1 md:flex">
                    <UiButton variant="outline" size="sm" className="h-9 bg-transparent px-3.5 text-[13px] font-normal" onClick={edit}>{t('contacts.detail.editAction')}</UiButton>
                    <UiMenu label={t('contacts.detail.moreLabel')} items={menuItems} triggerSize="md" onSelect={onMenu} />
                  </div>
                )}
              </div>

              {/* 행동 행 4칸 */}
              <div className="grid grid-cols-4 gap-2">
                {actions.map(a => (
                  <button
                    key={a.key}
                    type="button"
                    className={actionBtn}
                    disabled={a.disabled}
                    title={a.disabled ? a.why : undefined}
                    onClick={() => a.run()}
                  >
                    <UiIcon name={a.icon} className="h-[18px] w-[18px] text-primary max-md:h-5 max-md:w-5" />
                    <span>{a.label}</span>
                  </button>
                ))}
              </div>

              {/* 정보 카드 */}
              {info.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                  {info.map((r, i) => (
                    <div
                      key={i}
                      className="border-b border-border px-4 last:border-b-0 max-md:flex max-md:min-h-[60px] max-md:flex-col max-md:justify-center max-md:py-2 md:grid md:min-h-12 md:grid-cols-[100px_1fr_auto] md:items-center md:gap-3"
                    >
                      <span className="text-xs text-muted-foreground">{r.k}</span>
                      <span
                        className={cx('min-w-0 text-[15px] text-foreground md:py-3 md:text-[13.5px]', r.mono ? 'font-mono' : '', r.multiline ? 'whitespace-pre-wrap break-words' : 'truncate')}
                      >{r.v}</span>
                      {r.copy
                        ? (
                          <button
                            type="button"
                            className="hidden h-8 items-center rounded-sm px-1 text-xs font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
                            aria-label={t('contacts.detail.copyAria', { v: r.v })}
                            onClick={() => copy(r.v)}
                          >{t('common.copy')}</button>
                        )
                        : <span className="hidden md:block" />}
                    </div>
                  ))}
                </div>
              )}

              <p className="hidden text-xs text-muted-foreground md:block">{t('contacts.detail.actionsNote')}</p>
            </div>
          )}
      </div>
    </div>
  )
}

export default ContactsDetail
