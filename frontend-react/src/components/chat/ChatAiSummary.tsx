/**
 * 채팅방 요약(시안 E2 왼쪽 칸) — 대화 목록 맨 위(머리 아래, 여백 12) 카드.
 *  카드: 테두리 primary/45 · 바탕 primary/6 · 반지름 10 · 패딩 12×14 · 간격 8.
 *   머리 = ✦ "읽지 않은 48개 요약"(숫자 mono) + [요약 닫기] / 목록 13·21 = 요점, "나를 부름: …(10:31)" 은 굵게 /
 *   꼬리 = [나를 부른 메시지로] 링크 · 오른쪽 "AI 생성 · 09:02–10:44"(mono).
 *  범위: 안 읽은 것 = 목록이 잡아 둔 첫 안읽음부터 끝까지(채널을 열면 바로 읽음 처리돼서 서버 last_read 로는 못 센다),
 *        고른 범위 = 메시지 ⋯ "여기부터 요약"(requestChatAiSummary).
 *  안 읽은 것이 MIN_UNREAD 개 이상일 때만 접힌 버튼 한 줄을 먼저 보여 준다(누르면 요약) — 시안에 진입 그림이 없어 정한 값.
 */
import { useEffect, useRef, useState } from 'react'
import { createStore, useStore } from 'zustand'
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiTrans } from '~/components/ui/Trans'
import { jumpTo } from '~/composables/useChatUi'
import { useAiInline } from '~/composables/useAiInline'
import { AiInlineButton, AiInlineErrorLine, AiInlineLoading, AiInlinePrivacy } from '~/components/aiInline/AiInlineParts'
import { hhmm, inlineError, summarizeChat, type ChatSummary } from '~/utils/aiInline'

/** 이 수 이상 안 읽었을 때 "요약" 버튼 줄을 띄운다 */
export const MIN_UNREAD = 10

// ─── ⋯ "여기부터 요약" 요청(메시지 메뉴 → 목록 위 카드) ───
export const chatAiStore = createStore<{ request: { channelId: string; fromMessageId: string; nonce: number } | null }>()(() => ({ request: null }))
export function requestChatAiSummary(channelId: string, fromMessageId: string) {
  chatAiStore.setState({ request: { channelId, fromMessageId, nonce: (chatAiStore.getState().request?.nonce ?? 0) + 1 } })
}

export interface ChatAiSummaryProps {
  channelId: string | null
  /** 목록이 채널을 열 때 잡아 둔 첫 안읽음 메시지 */
  firstUnreadId: string | null
  /** 그때의 안 읽은 수 */
  unreadCount: number
}

type Mode = { kind: 'unread' } | { kind: 'range'; from: string }

export function ChatAiSummary({ channelId, firstUnreadId, unreadCount }: ChatAiSummaryProps) {
  const { t } = useI18n()
  const { status, state } = useAiInline()
  const request = useStore(chatAiStore, s => s.request)
  const [mode, setMode] = useState<Mode | null>(null)
  const [data, setData] = useState<ChatSummary | null>(null)
  const [error, setError] = useState('')
  const [dismissed, setDismissed] = useState(false)
  const seq = useRef(0)

  // 채널이 바뀌면 처음부터
  useEffect(() => {
    seq.current++
    setMode(null); setData(null); setError(''); setDismissed(false)
  }, [channelId])

  async function run(m: Mode) {
    if (!channelId) return
    const my = ++seq.current
    setMode(m); setData(null); setError('')
    try {
      const from = m.kind === 'range' ? m.from : firstUnreadId
      const res = await summarizeChat(from
        ? { channel_id: channelId, scope: 'range', from_message_id: from }
        : { channel_id: channelId, scope: 'unread' })
      if (my === seq.current) setData(res)
    } catch (e) {
      if (my === seq.current) setError(inlineError(e, t('aiInline.failed')).message)
    }
  }

  // ⋯ "여기부터 요약"
  const lastNonce = useRef(0)
  useEffect(() => {
    if (!request || request.nonce === lastNonce.current) return
    lastNonce.current = request.nonce
    if (request.channelId !== channelId) return
    setDismissed(false)
    void run({ kind: 'range', from: request.fromMessageId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, channelId])

  function close() {
    seq.current++
    setMode(null); setData(null); setError(''); setDismissed(true)
  }

  if (!channelId || state === 'hidden') return null

  // 접힌 줄 — 안 읽은 것이 많을 때만
  if (!mode) {
    if (dismissed || unreadCount < MIN_UNREAD || !firstUnreadId) return null
    return (
      <div className="mx-3 mt-3 flex shrink-0 items-center">
        <AiInlineButton status={status} variant="outline" size="xs" icon="sparkles" onClick={() => { void run({ kind: 'unread' }) }}>
          <UiTrans k="aiInline.chat.summarizeUnread" slots={{ n: <span className="font-mono">{unreadCount}</span> }} />
        </AiInlineButton>
      </div>
    )
  }

  const count = mode.kind === 'unread' ? unreadCount : (data?.count ?? 0)
  const headKey = mode.kind === 'unread' ? 'aiInline.chat.summaryUnread' : 'aiInline.chat.summaryRange'
  return (
    <section aria-label={t('aiInline.chat.region')} className="mx-3 mt-3 flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto rounded-[10px] border border-primary/45 bg-primary/[0.06] px-3.5 py-3">
      <div className="flex items-center gap-2">
        <UiIcon name="sparkles" className="h-4 w-4 text-primary" />
        <span className="flex-1 text-[13.5px] font-semibold">
          {data || mode.kind === 'unread'
            ? <UiTrans k={headKey} slots={{ n: <span className="font-mono">{count}</span> }} />
            : t('aiInline.chat.summaryRangePending')}
        </span>
        <UiIconButton label={t('aiInline.chat.close')} icon="close" size="sm" variant="ghost" onClick={close} />
      </div>
      <AiInlinePrivacy status={status} />
      {error
        ? <AiInlineErrorLine message={error} onRetry={() => { void run(mode) }} />
        : !data
          ? <AiInlineLoading label={t('aiInline.chat.loading')} rows={3} />
          : (
            <>
              <ul className="m-0 flex list-disc flex-col gap-[3px] pl-[18px] text-[13px] leading-[21px]">
                {data.points.map((p, i) => <li key={i}>{p}</li>)}
                {data.called_me.map(c => (
                  <li key={c.message_id}>
                    <strong className="font-semibold">{t('aiInline.chat.calledMe')}</strong>: {c.text}{c.at && <> (<span className="font-mono">{hhmm(c.at)}</span>)</>}
                  </li>
                ))}
              </ul>
              {data.clipped && <p className="m-0 text-xs text-warning">{t('aiInline.chat.clipped')}</p>}
              <div className="flex items-center gap-2">
                {data.called_me[0] && (
                  <button type="button" className="text-[12.5px] text-primary hover:underline" onClick={() => jumpTo(channelId, data.called_me[0].message_id)}>
                    {t('aiInline.chat.jump')}
                  </button>
                )}
                <span className="flex-1" />
                <span className="text-[11.5px] text-muted-foreground">
                  {t('aiInline.generated')} · <span className="font-mono">{hhmm(data.from_at)}–{hhmm(data.to_at)}</span>
                </span>
              </div>
            </>
          )}
    </section>
  )
}
