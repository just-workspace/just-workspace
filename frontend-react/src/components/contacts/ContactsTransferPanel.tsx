/**
 * vCard 가져오기·내보내기 + 연동 계정 주소록 가져오기.
 * 사이드바 링크·모바일 ⋯ 시트 공용. 항목 36(모바일 48).
 * 가져오기/내보내기 대상은 현재 선택한 주소록(없으면 첫 주소록).
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useI18n } from '~/i18n'
// class 를 단순 연결한다(tailwind-merge 를 사용하는 cn 은 leading-[1.35]+text-xl 같은 조합을 제거한다)
import { clsx as cx } from 'clsx'
import { useContacts, type ExternalAccount } from '~/composables/useContacts'
import { addToast } from '~/composables/useToast'
import { UiIcon } from '~/components/ui/Icon'

export interface ContactsTransferPanelProps {
  /** 터치 크기(모바일 시트 — 항목 48, 글자 15) */
  touch?: boolean
  /** 루트에 추가할 클래스 */
  className?: string
}

/** vCard 가져오기·내보내기 + 연동 계정 동기화 목록 */
export function ContactsTransferPanel({ touch = false, className }: ContactsTransferPanelProps) {
  const { t } = useI18n()
  const { addressBooks, selectedBookId, fetchExternalAccounts, syncExternalAccount, importVcf, exportVcf } = useContacts()

  const [accounts, setAccounts] = useState<ExternalAccount[]>([])
  const [loaded, setLoaded] = useState(false)
  const [syncing, setSyncing] = useState('')
  const fileInput = useRef<HTMLInputElement | null>(null)

  const targetId = selectedBookId || addressBooks[0]?.id
  const targetName = addressBooks.find(b => b.id === targetId)?.name ?? ''

  useEffect(() => {
    void (async () => { setAccounts(await fetchExternalAccounts()); setLoaded(true) })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onPicked(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    try {
      const r = await importVcf(file)
      if (!r) { addToast('error', t('contacts.import.needBook')); return }
      addToast('success', t('contacts.import.vcfDone', { n: r.imported }))
    } catch (err: any) {
      addToast('error', err?.data?.detail || t('contacts.import.vcfFailed'))
    }
  }

  function onExport() {
    if (!exportVcf()) addToast('error', t('contacts.import.needBook'))
  }

  async function sync(acc: ExternalAccount) {
    setSyncing(acc.id)
    try {
      const r = await syncExternalAccount(acc)
      addToast('success', t('contacts.import.synced', { name: r.address_book, created: r.created, updated: r.updated }))
    } catch (err: any) {
      // 대부분 스코프 재동의가 필요한 경우이므로 서버 문구를 그대로 표시
      addToast('error', err?.data?.detail || t('contacts.import.syncFailed'))
    } finally { setSyncing('') }
  }

  const item = cx(
    'flex w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-foreground transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-hidden disabled:opacity-50',
    touch ? 'h-12 text-[15px]' : 'h-9 text-[13px]',
  )

  return (
    <div className={cx('flex flex-col', className ?? '')}>
      <button type="button" className={item} onClick={() => fileInput.current?.click()}>
        <UiIcon name="upload" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{t('contacts.import.fromVcf')}</span>
      </button>
      <input ref={fileInput} type="file" accept=".vcf,text/vcard" className="hidden" onChange={onPicked} />
      <button type="button" className={item} onClick={onExport}>
        <UiIcon name="download" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{t('contacts.transfer.export')}</span>
      </button>
      {targetName && <p className="px-2.5 pb-1 text-[11px] text-muted-foreground">{t('contacts.transfer.target', { name: targetName })}</p>}

      {accounts.length > 0
        ? (
          <>
            <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('contacts.import.fromAccount')}</div>
            {accounts.map(acc => (
              <button
                key={acc.id}
                type="button"
                className={item}
                disabled={syncing === acc.id}
                onClick={() => sync(acc)}
              >
                <span className="min-w-0 flex-1 truncate">{acc.email}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{syncing === acc.id ? t('contacts.import.syncing') : acc.provider}</span>
              </button>
            ))}
          </>
        )
        : loaded && <p className="px-2.5 py-1 text-[11px] leading-relaxed text-muted-foreground">{t('contacts.import.noAccounts')}</p>}
    </div>
  )
}

export default ContactsTransferPanel
