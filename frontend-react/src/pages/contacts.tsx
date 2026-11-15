// Vue 원본: frontend/pages/contacts.vue
// 연락처.
// ≥1024: 사이드바 236 + 목록 340 + 상세(패딩 28/40, 폭 680).
// 768~1023: 목록 340 + 상세, 사이드바 대신 목록 줄의 ⋯ 시트. <768: 목록 → 상세 전체 화면(탭바 숨김), FAB(새 연락처).
// 연락처는 메일 모듈의 하위: 레일 활성 = 메일, 상단바 경로 = 메일 / 연락처. 진입은 메일 사이드바·전체 시트·Ctrl+K.
// 모바일 목록 머리는 ContactsList 범위 줄, 상세는 LayoutMobileDetailBar — 공용 상단바는 쓰지 않는다(routes.ts ownMobileHeader)
import { useEffect } from 'react'
import { useI18n } from '~/i18n'
// Vue 의 class 묶음처럼 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지워 Vue 와 달라진다)
import { clsx as cx } from 'clsx'
import { useHead } from '~/lib/head'
import { setSharedState } from '~/lib/state'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useIsMobile } from '~/composables/useIsMobile'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useContacts, setMobileMenuOpen } from '~/composables/useContacts'
import { ContactsSidebar } from '~/components/contacts/ContactsSidebar'
import { ContactsList } from '~/components/contacts/ContactsList'
import { ContactsDetail } from '~/components/contacts/ContactsDetail'
import { ContactsMobileMenu } from '~/components/contacts/ContactsMobileMenu'
import { ContactsEditModal } from '~/components/contacts/ContactsEditModal'
import { UiFab } from '~/components/ui/Fab'
import { UiIcon } from '~/components/ui/Icon'

export default function ContactsPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('nav.contacts')} | ${appName}` })

  const {
    fetchAddressBooks, fetchContacts, fetchGroups, fetchCounts, selectedContact, mobileMenuOpen, openCreateModal,
  } = useContacts()
  const isMobile = useIsMobile()

  // 상단바 3단 경로: 워크스페이스 / 메일 / 연락처. 범위(주소록·즐겨찾기·그룹)는 목록 머리가 보여 준다.
  useBreadcrumb(t('nav.contacts'))

  // 모바일에서 상세가 열리면 하단 탭바 숨김(목록에선 유지)
  const detailOpen = !!(isMobile && selectedContact)
  useEffect(() => { setSharedState('mobile-detail-open', detailOpen) }, [detailOpen])
  useEffect(() => () => { setSharedState('mobile-detail-open', false); setMobileMenuOpen(false) }, [])

  useEffect(() => {
    void (async () => {
      await fetchAddressBooks()
      await fetchContacts()
      fetchGroups()
      fetchCounts()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full overflow-hidden bg-background">
      <aside className="hidden w-[236px] shrink-0 overflow-y-auto border-r border-border bg-card lg:block">
        <ContactsSidebar />
      </aside>

      <section
        className={cx('w-full shrink-0 border-border md:w-[340px] md:border-r', selectedContact ? 'hidden md:block' : 'block')}
        aria-label={t('nav.contacts')}
      >
        <ContactsList />
      </section>

      <main className={cx('min-w-0 flex-1 overflow-hidden', selectedContact ? 'block' : 'hidden md:block')}>
        <ContactsDetail />
      </main>

      {/* 1024 미만 1차 행동: 목록에서만 FAB(새 연락처). 768~1023 은 사이드바가 없으므로 그 폭에서도 보이게 */}
      {!selectedContact && <UiFab label={t('contacts.sidebar.newContact')} onClick={() => openCreateModal()} />}
      {!isMobile && (
        <button
          type="button"
          className="fixed bottom-4 right-4 z-drawer hidden h-14 w-14 place-items-center rounded-sheet bg-primary text-primary-foreground shadow-[0_6px_16px_hsl(var(--scrim)/0.45)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background md:grid lg:hidden"
          aria-label={t('contacts.sidebar.newContact')}
          title={t('contacts.sidebar.newContact')}
          onClick={() => openCreateModal()}
        >
          <UiIcon name="plus" className="h-[22px] w-[22px]" strokeWidth={2.4} />
        </button>
      )}

      {mobileMenuOpen && <ContactsMobileMenu />}
      <ContactsEditModal />
    </div>
  )
}
