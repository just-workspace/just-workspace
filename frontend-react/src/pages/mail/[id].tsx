// 모바일 메일 본문: /mail/:id 푸시 + 데스크톱과 같은 MailReader.
// 상단 56 = ‹ 폴더 · n / N(mono) · 보관 · ⋯(읽지 않음·스팸·삭제·원문 보기), 별표는 제목 옆, 하단 고정 답장·전체 답장·전달.
// 데스크톱에서 이 주소로 오면 목록 화면의 읽기 판으로 연다.
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useRoute, useRouter, navigateTo, queryString } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { isMobileNow } from '~/composables/useIsMobile'
import { useMail } from '~/composables/useMail'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { MAILBOX_ROLE_KEYS } from '~/utils/mailQuery'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { MailReader, type MailReaderHandle } from '~/components/mail/MailReader'

export default function MailMessagePage() {
  const route = useRoute()
  const router = useRouter()
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const { openMessageAt, selectedMessage, selectedMailbox, selectedIndex, currentPage, limit, totalMessages, clearSelectedMessage, isPop3 } = useMail()

  const id = String(route.params.id || '')
  const mailbox = queryString(route.query.mailbox) || null
  const account = queryString(route.query.account) || null

  const folderLabel = !selectedMailbox
    ? t('nav.mail')
    : selectedMailbox.role && MAILBOX_ROLE_KEYS[selectedMailbox.role] ? t(MAILBOX_ROLE_KEYS[selectedMailbox.role]) : selectedMailbox.name
  useBreadcrumb(folderLabel)
  useHead({ title: `${selectedMessage?.subject || t('nav.mail')} | ${appName}` })

  const position = selectedIndex ? `${currentPage * limit + selectedIndex} / ${totalMessages.toLocaleString()}` : ''

  const readerRef = useRef<MailReaderHandle | null>(null)
  const [moreItems, setMoreItems] = useState<UiMenuItem[]>([])

  const latest = useRef({ mailbox, account })
  latest.current = { mailbox, account }
  // onMounted(load) + watch(id, load)
  useEffect(() => {
    if (!id) return
    if (!isMobileNow()) {
      const q: Record<string, string> = { open: id }
      if (latest.current.mailbox) q.mailbox = latest.current.mailbox
      if (latest.current.account) q.account = latest.current.account
      void navigateTo({ path: '/mail', query: q }, { replace: true })
      return
    }
    void openMessageAt(id, latest.current.mailbox, latest.current.account)
  }, [id, openMessageAt])

  function goBack() {
    clearSelectedMessage()
    if (window.history.length > 1) router.back()
    else void navigateTo('/mail', { replace: true })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <LayoutMobileDetailBar
        title={folderLabel}
        subtitle={position}
        subtitleMono
        backLabel={t('mail.reader.backTo', { folder: folderLabel })}
        onBack={clearSelectedMessage}
        actions={(
          <>
            {/* POP3 는 서버 폴더가 없어 보관이 없다 */}
            {!isPop3 && <UiIconButton label={t('mail.list.archive')} size="lg" onClick={() => { void readerRef.current?.archive() }}><UiIcon name="archive" /></UiIconButton>}
            <UiMenu
              label={t('mail.reader.mobileMoreMenu')}
              items={moreItems}
              width={200}
              onSelect={key => readerRef.current?.onMore(key)}
              trigger={({ toggle, open, controls }) => (
                <UiIconButton label={t('mail.reader.mobileMoreMenu')} icon="more-horizontal" size="lg" aria-haspopup="menu" aria-expanded={open} aria-controls={controls} onClick={toggle} />
              )}
            />
          </>
        )}
      />
      <MailReader ref={readerRef} variant="page" onArchived={goBack} onDeleted={goBack} onMobileMoreItems={setMoreItems} />
    </div>
  )
}
