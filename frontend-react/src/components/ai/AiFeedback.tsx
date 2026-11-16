/**
 * AI 답변 추천(엄지 올림)/비추천(엄지 내림) 평가("별로예요 → 이유 받기" + 수정 요청 a2fix).
 *  추천 = 즉시 저장(재클릭 시 취소). 비추천 = 즉시 저장 후 이유 카드 표시 — 이유 칩·한 줄 의견·
 *  "이 대화 내용도 함께 보내기"(기본 비활성). 개인정보: 기본은 이유만 저장, 대화 내용은 활성화한 경우에만 첨부.
 *  POST /api/ai/messages/{id}/feedback {rating, reasons, comment, include_conversation}
 */
import { useId, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { addToast } from '~/composables/useToast'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { UiChip } from '~/components/ui/Chip'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiCheckbox } from '~/components/ui/Checkbox'
import type { AiFeedback as AiFeedbackValue } from '~/utils/aiAssist'
import { AI_FEEDBACK_REASONS } from '~/utils/aiAssist'

export interface AiFeedbackButtonsProps {
  /** 답변 메시지 id(없으면 버튼 비활성화 — 저장 전 상태) */
  messageId?: string
  value?: AiFeedbackValue | null
  onChange?: (v: AiFeedbackValue | null) => void
}

interface Body { rating: 'up' | 'down' | null; reasons?: string[]; comment?: string; include_conversation?: boolean }

export function AiFeedbackButtons({ messageId, value, onChange }: AiFeedbackButtonsProps) {
  const { t } = useI18n()
  const panelId = useId()
  const titleId = useId()
  const [panel, setPanel] = useState(false)
  const [reasons, setReasons] = useState<string[]>([])
  const [comment, setComment] = useState('')
  const [include, setInclude] = useState(false)
  const [busy, setBusy] = useState(false)
  const rating = value?.rating ?? null

  async function post(body: Body): Promise<boolean> {
    if (!messageId) return false
    setBusy(true)
    try {
      const r = await $fetch<{ feedback: AiFeedbackValue | null }>(`/api/ai/messages/${encodeURIComponent(messageId)}/feedback`, {
        method: 'POST', credentials: 'include',
        body: { reasons: [], comment: '', include_conversation: false, ...body },
      })
      onChange?.(r?.feedback ?? null)
      return true
    } catch (e: any) {
      addToast('error', t('ai.feedback.failed', { msg: e?.data?.detail || e?.message || String(e) }))
      return false
    } finally { setBusy(false) }
  }

  function up() {
    setPanel(false)
    void post({ rating: rating === 'up' ? null : 'up' })
  }
  function down() {
    if (rating === 'down') { setPanel(false); void post({ rating: null }); return }
    setReasons([]); setComment(''); setInclude(false)
    setPanel(true)
    void post({ rating: 'down' })
  }
  async function send() {
    const ok = await post({ rating: 'down', reasons, comment: comment.trim(), include_conversation: include })
    if (ok) { setPanel(false); addToast('success', t('ai.feedback.thanks')) }
  }
  function toggleReason(r: string, on: boolean) {
    setReasons(list => (on ? [...new Set([...list, r])] : list.filter(x => x !== r)))
  }

  const btn = 'inline-flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
  return (
    <>
      <button
        type="button"
        aria-label={t('ai.feedback.up')}
        aria-pressed={rating === 'up'}
        disabled={!messageId || busy}
        className={cn(btn, rating === 'up' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
        onClick={up}
      ><UiIcon name="thumbs-up" className="h-4 w-4" /></button>
      <button
        type="button"
        aria-label={t('ai.feedback.down')}
        aria-pressed={rating === 'down'}
        aria-expanded={panel}
        aria-controls={panel ? panelId : undefined}
        disabled={!messageId || busy}
        className={cn(btn, rating === 'down' ? 'bg-danger/[0.12] text-danger' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
        onClick={down}
      ><UiIcon name="thumbs-down" className="h-4 w-4" /></button>
      {panel && (
        // 행동 줄(flex-wrap) 아래 한 줄 전체를 차지하는 카드
        <div
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          className="order-last mt-1.5 flex w-full basis-full flex-col gap-3 rounded-xl border border-border bg-popover px-4 py-3.5"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setPanel(false) } }}
        >
          <span id={titleId} className="text-sm font-semibold text-foreground">{t('ai.feedback.title')}</span>
          <div className="flex flex-wrap gap-1.5">
            {AI_FEEDBACK_REASONS.map(r => (
              <UiChip key={r} variant="toggle" surface="raised" label={t(`ai.feedback.reasons.${r}`)} modelValue={reasons.includes(r)} onUpdateModelValue={v => toggleReason(r, v)} />
            ))}
          </div>
          <UiTextarea modelValue={comment} onUpdateModelValue={setComment} label={t('ai.feedback.detail')} placeholder={t('ai.feedback.detailPlaceholder')} rows={2} maxLength={1000} />
          <p className="text-xs text-muted-foreground">{t('ai.feedback.privacy')}</p>
          <UiCheckbox modelValue={include} onUpdateModelValue={setInclude} label={t('ai.feedback.includeConversation')} />
          <div className="flex items-center justify-end gap-2">
            <UiButton variant="ghost" size="sm" onClick={() => setPanel(false)}>{t('ai.feedback.close')}</UiButton>
            <UiButton size="sm" disabled={busy} onClick={() => { void send() }}>{t('ai.feedback.send')}</UiButton>
          </div>
        </div>
      )}
    </>
  )
}

export default AiFeedbackButtons
