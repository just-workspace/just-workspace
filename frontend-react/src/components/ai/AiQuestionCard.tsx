/**
 * AI 질문 카드 — Claude Code 의 AskUserQuestion · ExitPlanMode.
 *
 * ask : 질문별 선택지(단일 선택 · 복수 선택) + '기타(직접 입력)'. 질문이 복수이면 상단 칩으로 전환한다.
 *       숫자 키로 선택하고 Enter 로 다음·전송. [건너뛰기] = 응답하지 않음(모델은 기본값으로 진행하고 가정을 명시한다).
 * plan: 계획(마크다운) + 1 예·편집 자동 수락으로 진행 / 2 예·하나씩 승인하며 진행 / 3 아니요·계속 계획(피드백).
 * 응답하면 대기 중이던 답변이 이어서 진행된다. 응답 후에는 한 줄 요약으로 접힌다.
 */
import { useState, type KeyboardEvent } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { $fetch } from '~/lib/api'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiKeycap } from '~/components/ui/Keycap'
import { UiTextarea } from '~/components/ui/Textarea'
import { AiMessage } from '~/components/ai/AiMessage'
import { addToast } from '~/composables/useToast'
import { permissionStore, type PermissionMode } from '~/composables/usePermissionMode'
import type { AiQuestion } from '~/utils/aiAssist'

interface Pick { selected: string[]; other: string; otherOn: boolean }

export function AiQuestionCard({ q, onChange }: { q: AiQuestion; onChange?: (q: AiQuestion) => void }) {
  const { t } = useI18n()
  const items = q.questions || []
  const [tab, setTab] = useState(0)
  const [picks, setPicks] = useState<Pick[]>(() => items.map(() => ({ selected: [], other: '', otherOn: false })))
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [feedbackOn, setFeedbackOn] = useState(false)

  async function send(body: Record<string, unknown>) {
    if (busy) return
    setBusy(true)
    try {
      const r = await $fetch<{ question: AiQuestion; mode: PermissionMode | null }>(`/api/ai/questions/${encodeURIComponent(q.id)}/answer`, { method: 'POST', body })
      if (r.mode) permissionStore.setState({ mode: r.mode, loaded: true })
      onChange?.({ ...q, ...r.question })
    } catch (e: any) {
      addToast('error', t('ai.ask.failed', { msg: e?.data?.detail || e?.message || '' }))
    } finally { setBusy(false) }
  }

  // ── 응답 후·종료 후 — 한 줄 요약 ──
  if (q.status !== 'pending') {
    let text = t(`ai.ask.status.${q.status}`)
    if (q.status === 'answered' && q.kind === 'ask') {
      text = (q.answer?.answers || []).map(a => [...a.selected, ...(a.other ? [a.other] : [])].join(', ')).join(' · ')
    } else if (q.status === 'answered' && q.kind === 'plan') {
      text = t(`ai.ask.planChoice.${q.answer?.choice || 'default'}`) + (q.answer?.feedback ? ` — ${q.answer.feedback}` : '')
    }
    return (
      <section aria-label={t(q.kind === 'plan' ? 'ai.ask.planTitle' : 'ai.ask.title')} className="rounded-xl border border-border bg-card px-4 py-3 text-[13px]">
        <div className="flex items-center gap-2 text-muted-foreground">
          <UiIcon name={q.kind === 'plan' ? 'clipboard-list' : 'help-circle'} className="h-4 w-4" />
          <span className="font-medium text-foreground">{t(q.kind === 'plan' ? 'ai.ask.planTitle' : 'ai.ask.title')}</span>
          <span className="min-w-0 flex-1 truncate">{q.kind === 'ask' ? items.map(i => i.header || i.question).join(' · ') : ''}</span>
        </div>
        <div className={cn('mt-1 pl-6', q.status === 'answered' ? 'text-foreground' : 'text-muted-foreground')}>→ {text}</div>
      </section>
    )
  }

  // ── 계획 승인(ExitPlanMode) ──
  if (q.kind === 'plan') {
    const opts = [
      { key: '1', label: t('ai.ask.planChoice.acceptEdits'), run: () => { void send({ choice: 'acceptEdits', feedback: feedback.trim() || null }) } },
      { key: '2', label: t('ai.ask.planChoice.default'), run: () => { void send({ choice: 'default', feedback: feedback.trim() || null }) } },
      { key: '3', label: t('ai.ask.planChoice.keep_planning'), run: () => setFeedbackOn(true) },
    ]
    const onKey = (e: KeyboardEvent) => {
      if (busy || (e.target as HTMLElement).closest('textarea,input')) return
      const o = opts.find(x => x.key === e.key)
      if (o) { e.preventDefault(); o.run() }
    }
    return (
      <section aria-label={t('ai.ask.planTitle')} onKeyDown={onKey} className="overflow-hidden rounded-xl border border-primary/50 bg-card">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <UiIcon name="clipboard-list" className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">{t('ai.ask.planTitle')}</span>
        </header>
        <div className="max-h-[420px] overflow-y-auto px-4 py-3 text-[14px] leading-[1.65]"><AiMessage content={q.plan || ''} /></div>
        <div className="border-t border-border px-3 py-2.5" role="group" aria-label={t('ai.ask.planQuestion')}>
          <div className="px-1 pb-1.5 text-[13px] font-medium">{t('ai.ask.planQuestion')}</div>
          {opts.map(o => (
            <button key={o.key} type="button" disabled={busy} onClick={o.run} aria-label={o.label} aria-keyshortcuts={o.key}
              className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                o.key === '1' && 'font-medium text-primary', o.key === '3' && feedbackOn && 'bg-muted')}>
              <UiKeycap size={18}>{o.key}</UiKeycap><span className="flex-1">{o.label}</span>
            </button>
          ))}
          {feedbackOn && (
            <div className="mt-2 flex flex-col gap-2 px-1">
              <UiTextarea modelValue={feedback} onUpdateModelValue={setFeedback} rows={2} autoFocus aria-label={t('ai.ask.planFeedback')}
                placeholder={t('ai.ask.planFeedbackPlaceholder')}
                onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send({ choice: 'keep_planning', feedback: feedback.trim() || null }) } }} />
              <div className="flex justify-end gap-2">
                <UiButton size="sm" variant="ghost" onClick={() => setFeedbackOn(false)}>{t('approvals.card.back')}</UiButton>
                <UiButton size="sm" icon="send" disabled={busy} onClick={() => { void send({ choice: 'keep_planning', feedback: feedback.trim() || null }) }}>{t('ai.ask.sendFeedback')}</UiButton>
              </div>
            </div>
          )}
        </div>
      </section>
    )
  }

  // ── 질문(AskUserQuestion) ──
  const cur = items[tab]
  const p = picks[tab]
  const answered = (i: number) => picks[i].selected.length > 0 || (picks[i].otherOn && !!picks[i].other.trim())
  const allDone = items.every((_, i) => answered(i))
  const setPick = (i: number, f: (x: Pick) => Pick) => setPicks(ps => ps.map((x, j) => (j === i ? f(x) : x)))
  const toggle = (label: string) => setPick(tab, x => (cur.multiSelect
    ? { ...x, selected: x.selected.includes(label) ? x.selected.filter(l => l !== label) : [...x.selected, label] }
    : { ...x, selected: [label], otherOn: false }))
  const toggleOther = () => setPick(tab, x => (cur.multiSelect ? { ...x, otherOn: !x.otherOn } : { ...x, selected: [], otherOn: true }))
  const next = () => {
    if (!answered(tab)) return
    const nxt = items.findIndex((_, i) => i > tab && !answered(i))
    if (nxt >= 0) setTab(nxt)
    else if (allDone) submit()
  }
  function submit() {
    void send({ answers: picks.map(x => ({ selected: x.selected, other: x.otherOn ? (x.other.trim() || null) : null })) })
  }
  const onKey = (e: KeyboardEvent) => {
    if (busy) return
    if ((e.target as HTMLElement).closest('textarea,input')) {
      if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) { e.preventDefault(); next() }
      return
    }
    const n = Number(e.key)
    if (n >= 1 && n <= cur.options.length) { e.preventDefault(); toggle(cur.options[n - 1].label) }
    else if (n === cur.options.length + 1) { e.preventDefault(); toggleOther() }
    else if (e.key === 'Enter') { e.preventDefault(); next() }
  }

  return (
    <section aria-label={t('ai.ask.title')} onKeyDown={onKey} className="overflow-hidden rounded-xl border border-primary/50 bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <UiIcon name="help-circle" className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">{t('ai.ask.title')}</span>
        <span className="flex-1" />
        {items.length > 1 && items.map((it, i) => (
          <button key={i} type="button" onClick={() => setTab(i)} aria-current={i === tab ? 'step' : undefined}
            className={cn('inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11.5px] font-medium',
              i === tab ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground', answered(i) && i !== tab && 'text-foreground')}>
            {answered(i) && <UiIcon name="check" className="h-3 w-3" />}{it.header || t('ai.ask.nth', { n: i + 1 })}
          </button>
        ))}
      </header>
      <div className="px-3 py-3">
        <div className="px-1 pb-2 text-[14px] font-medium">{cur.question}{cur.multiSelect && <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">{t('ai.ask.multi')}</span>}</div>
        <div role={cur.multiSelect ? 'group' : 'radiogroup'} aria-label={cur.question} className="flex flex-col gap-0.5">
          {cur.options.map((o, i) => {
            const on = p.selected.includes(o.label)
            return (
              <button key={o.label} type="button" disabled={busy} onClick={() => toggle(o.label)}
                role={cur.multiSelect ? 'checkbox' : 'radio'} aria-checked={on} aria-keyshortcuts={String(i + 1)} aria-label={o.label}
                className={cn('flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', on && 'bg-primary/10')}>
                <UiKeycap size={18} className="mt-px shrink-0">{i + 1}</UiKeycap>
                <span className="min-w-0 flex-1">
                  <span className={cn(on && 'font-medium text-primary')}>{o.label}</span>
                  {o.description && <span className="block text-[12px] text-muted-foreground">{o.description}</span>}
                </span>
                {on && <UiIcon name="check" className="mt-0.5 h-4 w-4 text-primary" />}
              </button>
            )
          })}
          <button type="button" disabled={busy} onClick={toggleOther} role={cur.multiSelect ? 'checkbox' : 'radio'} aria-checked={p.otherOn}
            aria-keyshortcuts={String(cur.options.length + 1)} aria-label={t('ai.ask.other')}
            className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', p.otherOn && 'bg-primary/10')}>
            <UiKeycap size={18}>{cur.options.length + 1}</UiKeycap><span className="flex-1">{t('ai.ask.other')}</span>
          </button>
          {p.otherOn && (
            <div className="px-1 pt-1">
              <UiTextarea modelValue={p.other} onUpdateModelValue={v => setPick(tab, x => ({ ...x, other: v }))} rows={2} autoFocus
                aria-label={t('ai.ask.other')} placeholder={t('ai.ask.otherPlaceholder')} />
            </div>
          )}
        </div>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-background/40 px-4 py-2 text-[12.5px] text-muted-foreground">
        <span className="flex-1 basis-56">{t('ai.ask.hint')}</span>
        <UiButton size="sm" variant="ghost" disabled={busy} onClick={() => { void send({ skip: true }) }}>{t('ai.ask.skip')}</UiButton>
        {items.length > 1 && !allDone
          ? <UiButton size="sm" disabled={busy || !answered(tab)} onClick={next}>{t('ai.ask.next')}</UiButton>
          : <UiButton size="sm" icon="send" disabled={busy || !allDone} onClick={submit}>{t('ai.ask.submit')}</UiButton>}
      </footer>
    </section>
  )
}
