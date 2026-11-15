/**
 * 메일 읽기 화면 안 AI(시안 E1) — 요약 패널(요점·내가 할 일 → 고른 n개 할일에 등록)과 답장 초안(말투 정중하게|짧게).
 *  - 요약: 데스크톱은 읽기 판 오른쪽 aside 340(카드 바탕·왼쪽 경계선·패딩 20·간격 18), 모바일은 본문 위 카드.
 *  - 내가 할 일: 체크박스(제목 + "기한 11-07(금) · 박준호에게" / "기한 없음"). 기한이 있는 것만 처음에 체크(시안 그대로).
 *    [고른 n개 할일에 등록] → /api/ai/inline/tasks(쓰기 승인 체계 — 버튼이 곧 승인), 등록 뒤 되돌리기.
 *  - 답장 초안: 본문 아래 카드(테두리 primary/50, 머리 = ✦ 답장 초안 + 말투 세그먼트, 꼬리 = 안내 + [버리기][편집기로 옮기기]).
 *    [편집기로 옮기기] = 작성 창(모바일은 전체 화면 작성)에 채운다. 보내기는 사람이 — 보내면 X-AI-Generated 가 붙는다.
 *  - 결과는 메일마다 기억(같은 메일을 다시 열면 다시 부르지 않음). 진행·오류·외부 AI 안내는 공용 조각.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiSegment } from '~/components/ui/Segment'
import { UiTrans } from '~/components/ui/Trans'
import { AiInlineErrorLine, AiInlineFoot, AiInlineLoading, AiInlinePrivacy } from '~/components/aiInline/AiInlineParts'
import { TodoRegisteredLine, useTodoRegister } from '~/components/aiInline/useTodoRegister'
import { draftMailReply, inlineError, shortDue, summarizeMail, type AiInlineStatus, type AiTone, type MailReply, type MailSummary } from '~/utils/aiInline'

export interface MailRef { id: string; mailboxId: string | null; accountId: string | null }

const sumCache = new Map<string, MailSummary>()
const draftCache = new Map<string, MailReply>()
const keyOf = (m: MailRef, extra = '') => `${m.accountId || ''}|${m.mailboxId || ''}|${m.id}${extra}`

/** 테스트용 */
export function _clearMailAiCache() { sumCache.clear(); draftCache.clear() }

// ─── 요약 ────────────────────────────────────────────────
export interface MailAiSummaryProps {
  mail: MailRef
  status: AiInlineStatus | null
  /** aside(데스크톱 오른쪽 340) · inline(모바일 본문 위) */
  variant?: 'aside' | 'inline'
  onClose: () => void
}

export function MailAiSummary({ mail, status, variant = 'aside', onClose }: MailAiSummaryProps) {
  const { t, locale } = useI18n()
  const [data, setDataRaw] = useState<MailSummary | null>(() => sumCache.get(keyOf(mail)) || null)
  const [error, setError] = useState('')
  // 기한이 있는 할 일만 처음에 고른다(시안: 기한 없음은 해제)
  const initialPicked = (d: MailSummary | null) => new Set((d?.todos || []).map((td, i) => (td.due ? i : -1)).filter(i => i >= 0))
  const [picked, setPicked] = useState<Set<number>>(() => initialPicked(sumCache.get(keyOf(mail)) || null))
  function setData(d: MailSummary | null) {
    setDataRaw(d)
    setPicked(initialPicked(d))
  }
  const reg = useTodoRegister('mail')
  const seq = useRef(0)

  async function load() {
    const my = ++seq.current
    setError('')
    setData(null)
    try {
      const res = await summarizeMail({ message_id: mail.id, mailbox_id: mail.mailboxId, account_id: mail.accountId })
      if (my !== seq.current) return
      sumCache.set(keyOf(mail), res)
      setData(res)
    } catch (e) {
      if (my === seq.current) setError(inlineError(e, t('aiInline.failed')).message)
    }
  }

  useEffect(() => {
    const cached = sumCache.get(keyOf(mail))
    if (cached) setData(cached)
    else void load()
    const s = seq
    return () => { s.current++ }
    // 메일이 바뀔 때마다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mail.id, mail.mailboxId, mail.accountId])

  function toggle(i: number, v: boolean) {
    setPicked((s) => {
      const n = new Set(s)
      if (v) n.add(i)
      else n.delete(i)
      return n
    })
  }

  function desc(td: MailSummary['todos'][number]) {
    const due = td.due ? t('aiInline.mail.due', { date: shortDue(td.due, locale) }) : t('aiInline.mail.noDue')
    return td.who ? `${due} · ${td.who}` : due
  }

  async function registerPicked() {
    if (!data) return
    const items = data.todos.filter((_, i) => picked.has(i)).map(td => ({
      title: td.title,
      due_date: td.due,
      description: [td.who, t('aiInline.mail.fromMail')].filter(Boolean).join(' · '),
    }))
    await reg.register(items)
  }

  const isAside = variant === 'aside'
  return (
    <aside
      aria-label={t('aiInline.mail.summary')}
      className={cn(
        'flex flex-col gap-[18px] bg-card',
        isAside ? 'w-[340px] min-w-[280px] shrink-0 overflow-y-auto border-l border-border p-5' : 'mb-4 rounded-xl border border-border p-4',
      )}
    >
      <div className="flex items-center gap-2">
        <UiIcon name="sparkles" className="h-4 w-4 text-primary" />
        <h2 className="m-0 flex-1 text-[15px] font-semibold">{t('aiInline.mail.summary')}</h2>
        <UiIconButton label={t('aiInline.mail.closeSummary')} icon="close" size="sm" variant="ghost" onClick={onClose} />
      </div>

      <AiInlinePrivacy status={status} />

      {error
        ? <AiInlineErrorLine message={error} onRetry={() => { void load() }} />
        : !data
          ? <AiInlineLoading label={t('aiInline.mail.loading')} rows={5} />
          : (
            <>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-muted-foreground">{t('aiInline.mail.points')}</span>
                {data.points.length
                  ? (
                    <ul className="m-0 flex list-disc flex-col gap-1 pl-[18px] text-[13.5px] leading-[22px]">
                      {data.points.map((p, i) => <li key={i}>{p}</li>)}
                    </ul>
                  )
                  : <p className="m-0 text-[13px] text-muted-foreground">{t('aiInline.mail.noPoints')}</p>}
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-muted-foreground">{t('aiInline.mail.myTodos')}</span>
                {data.todos.length
                  ? (
                    <>
                      <div className="flex flex-col gap-2.5">
                        {data.todos.map((td, i) => (
                          <UiCheckbox key={i} label={td.title} description={desc(td)} modelValue={picked.has(i)} onUpdateModelValue={v => toggle(i, v)} />
                        ))}
                      </div>
                      {reg.done
                        ? <TodoRegisteredLine count={reg.done.count} onUndo={() => { void reg.undo() }} />
                        : (
                          <UiButton variant="outline" size="sm" icon="check-square" className="self-start" disabled={!picked.size || reg.busy} aria-busy={reg.busy || undefined} onClick={() => { void registerPicked() }}>
                            <UiTrans k="aiInline.mail.register" slots={{ num: <span className="font-mono">{picked.size}</span> }} />
                          </UiButton>
                        )}
                      {reg.error && <AiInlineErrorLine message={reg.error} />}
                    </>
                  )
                  : <p className="m-0 text-[13px] text-muted-foreground">{t('aiInline.mail.noTodos')}</p>}
              </div>

              {data.clipped && <p className="m-0 text-xs text-warning">{t('aiInline.clipped')}</p>}
              <AiInlineFoot model={data.model} />
            </>
          )}
    </aside>
  )
}

// ─── 답장 초안 ───────────────────────────────────────────
export interface MailAiDraftProps {
  mail: MailRef
  onClose: () => void
  /** [편집기로 옮기기] — 초안 글을 넘긴다 */
  onUse: (draft: string) => void
}

export function MailAiDraft({ mail, onClose, onUse }: MailAiDraftProps) {
  const { t } = useI18n()
  const [tone, setTone] = useState<AiTone>('polite')
  const [data, setData] = useState<MailReply | null>(() => draftCache.get(keyOf(mail, ':polite')) || null)
  const [error, setError] = useState('')
  const seq = useRef(0)

  async function load(tn: AiTone) {
    const k = keyOf(mail, `:${tn}`)
    const cached = draftCache.get(k)
    if (cached) { setData(cached); setError(''); return }
    const my = ++seq.current
    setError('')
    setData(null)
    try {
      const res = await draftMailReply({ message_id: mail.id, mailbox_id: mail.mailboxId, account_id: mail.accountId, tone: tn })
      if (my !== seq.current) return
      draftCache.set(k, res)
      setData(res)
    } catch (e) {
      if (my === seq.current) setError(inlineError(e, t('aiInline.failed')).message)
    }
  }

  useEffect(() => {
    void load(tone)
    const s = seq
    return () => { s.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tone, mail.id])

  return (
    <section aria-label={t('aiInline.mail.draftTitle')} className="overflow-hidden rounded-xl border border-primary/50 bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5 text-[13px]">
        <UiIcon name="sparkles" className="h-4 w-4 text-primary" />
        <span className="flex-1 font-semibold">{t('aiInline.mail.draftTitle')}</span>
        <UiSegment
          ariaLabel={t('aiInline.mail.tone')}
          size="sm"
          items={[{ value: 'polite', label: t('aiInline.mail.polite') }, { value: 'short', label: t('aiInline.mail.short') }]}
          modelValue={tone}
          onUpdateModelValue={v => setTone((v as AiTone) || 'polite')}
        />
      </header>
      <div className="px-4 py-3.5 text-sm leading-6">
        {error
          ? <AiInlineErrorLine message={error} onRetry={() => { draftCache.delete(keyOf(mail, `:${tone}`)); void load(tone) }} />
          : data
            ? <div className="whitespace-pre-line">{data.draft}</div>
            : <AiInlineLoading label={t('aiInline.mail.drafting')} rows={4} />}
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2.5">
        <span className="min-w-[200px] flex-1 text-xs text-muted-foreground">{t('aiInline.mail.draftNote')}</span>
        <UiButton variant="ghost" size="sm" onClick={onClose}>{t('aiInline.mail.discard')}</UiButton>
        <UiButton size="sm" icon="edit" disabled={!data} onClick={() => { if (data) onUse(data.draft) }}>{t('aiInline.mail.toEditor')}</UiButton>
      </footer>
    </section>
  )
}
