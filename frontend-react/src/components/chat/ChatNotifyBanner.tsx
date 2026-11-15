// 알림 권한 배너(채팅 시안 — 대화 위). 첫 메시지를 보낸 뒤에만 뜨고, 브라우저 프롬프트는
// "알림 켜기"를 눌렀을 때만 나간다. "나중에"는 7일 동안 다시 묻지 않는다.
import { useStore } from 'zustand'
import { useI18n } from '~/i18n'
import { acceptNotifyBanner, chatStore, snoozeNotifyBanner } from '~/composables/useChat'

/** 알림 권한 배너 — [알림 켜기] [나중에] */
export function ChatNotifyBanner() {
  const { t } = useI18n()
  const showNotifyBanner = useStore(chatStore, s => s.showNotifyBanner)
  if (!showNotifyBanner) return null
  return (
    <div
      role="region"
      aria-label={t('chat.banner.notifyRegion')}
      className="mx-5 mt-2.5 flex items-center gap-2.5 rounded-[10px] border border-primary/35 bg-primary/[0.08] py-2 pl-3 pr-2 text-[13px]"
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-primary"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
      <span className="min-w-0 flex-1">
        <b className="font-semibold">{t('chat.banner.notifyTitle')}</b>
        {' '}<span className="text-muted-foreground">{t('chat.banner.notifyBody')}</span>
      </span>
      <button
        type="button"
        className="inline-flex h-[30px] shrink-0 items-center rounded-[10px] bg-primary px-3 text-xs font-semibold text-primary-foreground"
        onClick={() => { void acceptNotifyBanner() }}
      >{t('chat.banner.notifyEnable')}</button>
      <button
        type="button"
        className="inline-flex h-[30px] shrink-0 items-center rounded-[10px] px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent"
        onClick={snoozeNotifyBanner}
      >{t('chat.banner.notifyLater')}</button>
    </div>
  )
}

export default ChatNotifyBanner
