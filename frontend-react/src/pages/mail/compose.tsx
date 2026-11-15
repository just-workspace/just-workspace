// Vue 원본: frontend/pages/mail/compose.vue
// 메일 쓰기 전체 화면(메일 1 "모바일은 전체 화면 페이지"). 레이아웃 없음(routes.ts layout:false).
// 데스크톱에서 이 주소로 들어오면(대시보드 링크·예전 팝업 북마크) 메일 화면의 떠 있는 작성 창으로 넘긴다.
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useRoute, useRouter, navigateTo, queryString } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { isMobileNow } from '~/composables/useIsMobile'
import type { ComposeMode } from '~/composables/useMail'
import { MailComposer } from '~/components/mail/MailComposer'
import { takeAiDraft } from '~/composables/useMailCompose'

export default function MailComposePage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('mail.compose.new')} | ${appName}` })

  const route = useRoute()
  const router = useRouter()

  const mode = (queryString(route.query.mode) as ComposeMode) || 'new'
  const msgId = queryString(route.query.msgId) || null
  const draftId = queryString(route.query.draftId) || null
  /** 받는 사람 미리 채우기(새 메일만) */
  const to = (mode === 'new' && queryString(route.query.to)) || null
  /** 화면 안 AI 답장 초안 — 메일 읽기에서 맡겨 둔 것을 한 번 꺼낸다 */
  const [aiDraft] = useState(() => (queryString(route.query.ai) ? takeAiDraft(msgId) : undefined))

  // 데스크톱이면 첫 그리기 전에 넘긴다(Vue: onMounted 에서 redirecting=true — 첫 그리기에는 작성기가 잠깐 마운트됐다)
  const [redirecting] = useState(() => !isMobileNow())
  useEffect(() => {
    if (!redirecting) return
    const p = new URLSearchParams()
    p.set('mode', mode)
    if (msgId) p.set('msgId', msgId)
    if (draftId) p.set('draftId', draftId)
    if (to) p.set('to', to)
    void navigateTo(`/mail?compose=${encodeURIComponent(p.toString())}`, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function done() {
    if (window.history.length > 1) router.back()
    else void navigateTo('/mail', { replace: true })
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {!redirecting && (
        <MailComposer
          variant="page"
          mode={mode}
          msgId={msgId}
          draftId={draftId}
          to={to}
          aiDraft={aiDraft}
          onClose={done}
        />
      )}
    </div>
  )
}
