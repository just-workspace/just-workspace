// 연결 끊김 띠(머리 바로 아래 전체 폭 40, warning/10 + 아래 선 warning/60). 3초 넘게 끊겼을 때만 보인다:
// 짧은 끊김(서버 재시작·네트워크 전환)마다 깜빡이지 않게.
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { useI18n } from '~/i18n'
import { chatStore, retryNow } from '~/composables/useChat'
import { UiTrans } from '~/components/ui/Trans'
import { UiIcon } from '~/components/ui/Icon'

/** 연결 끊김 배너 — 남은 재시도 초 + [다시 연결] */
export function ChatConnectionBanner() {
  const { t } = useI18n()
  const disconnectedAt = useStore(chatStore, s => s.disconnectedAt)
  const reconnectAt = useStore(chatStore, s => s.reconnectAt)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])

  const visible = disconnectedAt !== null && now - disconnectedAt >= 3000
  const seconds = reconnectAt ? Math.max(0, Math.ceil((reconnectAt - now) / 1000)) : 0
  if (!visible) return null

  return (
    <div
      role="alert"
      data-testid="chat-offline-band"
      className="flex h-10 shrink-0 items-center gap-2 border-b border-warning/60 bg-warning/10 px-4 text-[13px]"
    >
      <UiIcon name="wifi-off" className="h-4 w-4 shrink-0 text-warning" />
      <b className="shrink-0 font-semibold text-foreground">{t('chat.shell.offline.title')}</b>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {seconds > 0
          ? <UiTrans k="chat.shell.offline.retryIn" as="span" slots={{ n: <span className="font-mono">{seconds}</span> }} />
          : t('chat.shell.offline.reconnecting')}
        {' · '}{t('chat.shell.offline.keep')}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md px-2 text-[13px] font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        onClick={retryNow}
      >{t('chat.banner.retry')}</button>
    </div>
  )
}

export default ChatConnectionBanner
