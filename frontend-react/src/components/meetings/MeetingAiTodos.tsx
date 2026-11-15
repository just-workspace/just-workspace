/**
 * 회의 끝난 뒤 요약 → 할 일(시안 E2 가운데 칸) — 회의 종료 화면 오른쪽(데스크톱 aside)·버튼 줄 아래(모바일) 카드.
 *  머리 = 🎥 "회의가 끝났습니다 — {제목}" + 시각(mono) / 진행 줄 = 요약 → 할 일 뽑기 → 골라서 등록(끝난 단계 success ✓, 지금 단계 굵게) /
 *  본문 = "요약 · 참석 n명 · 회의 채팅 기준" 목록 + "뽑은 할 일 — 체크한 것만 할일에 등록" 체크박스(담당 · 기한 · 배정 알림) /
 *  꼬리 = "담당자가 다른 사람이면 그 사람에게 ‘할일 배정’ 알림이 갑니다." + [할일에 n개 등록].
 *  ※ 시안의 "녹취 기준"은 받아쓰기를 만들지 않기로 해서(2026-11-05 결정) "회의 채팅 기준"으로 — 회의 채팅·채널 메시지·안건으로 요약.
 *  ※ AI 를 회의마다 자동으로 부르지 않는다(비용) — 처음엔 [요약·할 일 뽑기] 버튼, 누르면 진행 줄이 움직인다.
 *  회의 안 채팅(채널 없는 회의)은 나가면 지워지므로 이 모듈이 마지막 채팅을 붙잡아 둔다(lastMeetingChat).
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { useAuth } from '~/composables/useAuth'
import { meetingsStore } from '~/composables/useMeetings'
import { useAiInline } from '~/composables/useAiInline'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { AiInlineButton, AiInlineErrorLine, AiInlineFoot, AiInlineLoading, AiInlinePrivacy } from '~/components/aiInline/AiInlineParts'
import { TodoRegisteredLine, useTodoRegister } from '~/components/aiInline/useTodoRegister'
import { inlineError, shortDue, summarizeMeeting, type MeetingSummaryResult, type MeetingTodo } from '~/utils/aiInline'

// ─── 회의 안 채팅 붙잡아 두기(나가면 store 가 비운다) ───
let lastChat: { room: string | null; lines: { name: string; text: string }[] } = { room: null, lines: [] }
meetingsStore.subscribe((s, p) => {
  if (s.currentRoomName && s.currentRoomName !== lastChat.room) lastChat = { room: s.currentRoomName, lines: [] }
  if (s.chatMessages !== p.chatMessages && s.chatMessages.length) {
    lastChat = { room: s.currentRoomName || lastChat.room, lines: s.chatMessages.map(m => ({ name: m.sender, text: m.text })) }
  }
})
/** 이 방에서 마지막으로 본 회의 안 채팅 */
export function lastMeetingChat(room: string) { return lastChat.room === room ? lastChat.lines : [] }
/** 테스트용 */
export function _setLastMeetingChat(room: string, lines: { name: string; text: string }[]) { lastChat = { room, lines } }

export interface MeetingAiTodosProps {
  room: string
  title: string
  /** "10:00–10:52" */
  timeRange?: string
  /** 이 화면이 들어간 시각(서버에 시작 시각이 없을 때 채널 메시지 범위) */
  startedAt?: number
  className?: string
}

type Step = 'idle' | 'loading' | 'done'

export function MeetingAiTodos({ room, title, timeRange, startedAt, className }: MeetingAiTodosProps) {
  const { t, locale } = useI18n()
  const { user } = useAuth()
  const { status, state } = useAiInline()
  const [step, setStep] = useState<Step>('idle')
  const [data, setData] = useState<MeetingSummaryResult | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Set<number>>(() => new Set())
  const reg = useTodoRegister('meeting', room)
  const seq = useRef(0)
  useEffect(() => () => { seq.current++ }, [])

  async function run() {
    const my = ++seq.current
    setStep('loading'); setError(''); setData(null)
    try {
      const res = await summarizeMeeting({ room, chat_lines: lastMeetingChat(room), started_at: startedAt ? new Date(startedAt).toISOString() : null })
      if (my !== seq.current) return
      setData(res)
      setPicked(new Set(res.todos.map((td, i) => (td.assignee_id ? i : -1)).filter(i => i >= 0)))
      setStep('done')
    } catch (e) {
      if (my !== seq.current) return
      setError(inlineError(e, t('aiInline.failed')).message)
      setStep('idle')
    }
  }

  if (state === 'hidden' || !user) return null

  function desc(td: MeetingTodo) {
    const parts = [td.assignee_name || t('aiInline.meeting.unassigned')]
    if (td.due) parts.push(shortDue(td.due, locale))
    else if (td.note) parts.push(td.note)
    if (td.assignee_id && td.assignee_id !== user!.id) parts.push(t('aiInline.meeting.assignAlert'))
    return parts.join(' · ')
  }
  function toggle(i: number, v: boolean) {
    setPicked((s) => { const n = new Set(s); if (v) n.add(i); else n.delete(i); return n })
  }
  async function registerPicked() {
    if (!data) return
    await reg.register(data.todos.filter((_, i) => picked.has(i)).map(td => ({
      title: td.title, due_date: td.due, assignee_id: td.assignee_id,
      description: [t('aiInline.meeting.fromMeeting', { title: data.title }), td.note].filter(Boolean).join(' · '),
    })))
  }

  const steps: { key: string; label: string; done: boolean; current: boolean }[] = [
    { key: 'sum', label: t('aiInline.meeting.stepSummary'), done: step === 'done', current: step === 'loading' },
    { key: 'todo', label: t('aiInline.meeting.stepTodos'), done: step === 'done', current: false },
    { key: 'reg', label: t('aiInline.meeting.stepRegister'), done: !!reg.done, current: step === 'done' && !reg.done },
  ]

  return (
    <section aria-label={t('aiInline.meeting.region')} className={cn('overflow-hidden rounded-xl border border-border bg-card text-left', className)}>
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <UiIcon name="video" className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t('aiInline.meeting.title', { title })}</span>
        {timeRange && <span className="font-mono text-xs text-muted-foreground">{timeRange}</span>}
      </header>
      <ol aria-label={t('aiInline.meeting.progress')} className="m-0 flex list-none flex-wrap gap-1.5 border-b border-border px-4 py-3 text-xs">
        {steps.map((s, i) => (
          <li key={s.key} className="contents">
            {i > 0 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
            <span className={cn('inline-flex items-center gap-1', s.done ? 'text-success' : s.current ? 'font-semibold' : 'text-muted-foreground')} aria-current={s.current ? 'step' : undefined}>
              {s.done && <UiIcon name="check" className="h-3.5 w-3.5" />}{s.label}
            </span>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-3.5 px-4 py-3.5">
        <AiInlinePrivacy status={status} />
        {error && <AiInlineErrorLine message={error} onRetry={() => { void run() }} />}
        {step === 'idle' && !error && (
          <div className="flex flex-col items-start gap-2.5">
            <p className="m-0 text-[13px] text-muted-foreground">{t('aiInline.meeting.idle')}</p>
            <AiInlineButton status={status} size="sm" icon="sparkles" onClick={() => { void run() }}>{t('aiInline.meeting.start')}</AiInlineButton>
          </div>
        )}
        {step === 'loading' && <AiInlineLoading label={t('aiInline.meeting.loading')} rows={4} />}
        {step === 'done' && data && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground">
                {t(data.source === 'chat' ? 'aiInline.meeting.summaryHead' : 'aiInline.meeting.summaryHeadAgenda', { n: data.participants })}
              </span>
              <ul className="m-0 list-disc pl-[18px] text-[13px] leading-[21px]">
                {data.points.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </div>
            <div className="flex flex-col gap-2.5">
              <span className="text-xs font-semibold text-muted-foreground">{t('aiInline.meeting.todosHead')}</span>
              {data.todos.length
                ? data.todos.map((td, i) => (
                  <UiCheckbox key={i} label={td.title} description={desc(td)} modelValue={picked.has(i)} onUpdateModelValue={v => toggle(i, v)} />
                ))
                : <p className="m-0 text-[13px] text-muted-foreground">{t('aiInline.meeting.noTodos')}</p>}
            </div>
            {reg.error && <AiInlineErrorLine message={reg.error} />}
            <AiInlineFoot model={data.model} />
          </>
        )}
      </div>

      {step === 'done' && data && data.todos.length > 0 && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          {reg.done
            ? <TodoRegisteredLine count={reg.done.count} onUndo={() => { void reg.undo() }} />
            : (
              <>
                <span className="min-w-[160px] flex-1 text-xs text-muted-foreground">{t('aiInline.meeting.assignNote')}</span>
                <UiButton size="sm" icon="check-square" disabled={!picked.size || reg.busy} aria-busy={reg.busy || undefined} onClick={() => { void registerPicked() }}>
                  {t('aiInline.meeting.register', { n: picked.size })}
                </UiButton>
              </>
            )}
        </footer>
      )}
    </section>
  )
}
