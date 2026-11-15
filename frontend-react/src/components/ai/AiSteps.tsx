/**
 * AI 답변 진행 단계(S6a · 시안 C1 "4단계 완료 · 메일 검색 → … · 18초", C2-1 작성 중 펼침, C2-2 단계 하나 실패).
 *  카드 r12 · card · border(실패 있으면 warning/45). 머리 = 상태 아이콘 + 요약 + ▾/▴ (aria-expanded).
 *  받는 중에는 펼침이 기본, 끝나면 접힘(사용자가 누르면 그 선택을 따른다). 숫자·시간은 JetBrains Mono.
 *  모바일은 요약에서 단계 이름 사슬을 숨긴다("4단계 완료 · 18초", 시안 C2-9).
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'
import { UiTrans } from '~/components/ui/Trans'
import type { AiStep } from '~/utils/aiAssist'
import { aiStepSecs, aiStepsSummary } from '~/utils/aiAssist'

export interface AiStepsProps {
  steps: AiStep[]
  /** 답변을 받는 중 */
  streaming?: boolean
  startedAt?: string | null
  endedAt?: string | null
  className?: string
}

const KIND_ICON: Record<string, string> = { search: 'search', read: 'file-text', tool: 'zap', write: 'edit', think: 'sparkles', ask: 'help-circle' }

/** 사슬용 짧은 이름 — "메일 검색 “VPN”" → "메일 검색", "파일 읽기 — a.log" → "파일 읽기" */
function shortLabel(label: string) {
  return label.split(' — ')[0].replace(/\s*“.*”\s*$/, '').trim()
}

export function AiSteps({ steps, streaming, startedAt, endedAt, className }: AiStepsProps) {
  const { t } = useI18n()
  const listId = useId()
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? !!streaming
  // 받는 중이면 1초마다 다시 그려 걸린 시간을 올린다
  const [now, setNow] = useState(() => Date.now())
  const live = !!streaming && steps.some(s => s.status === 'running')
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])

  if (!steps.length) return null
  const sum = aiStepsSummary(steps, startedAt, streaming ? null : endedAt, live ? now : undefined)
  const chain = steps.map(s => shortLabel(s.label)).join(' → ')
  const secs = sum.secs != null ? <><span className="font-mono">{sum.secs}</span>{t('ai.steps.secUnit')}</> : null

  let icon: ReactNode
  let summary: ReactNode
  if (sum.running) {
    icon = <UiIcon name="loader" className="h-4 w-4 animate-spin text-primary" />
    summary = <>{sum.running.label} · <span className="font-mono">{sum.doneCount + 1}/{sum.total}</span></>
  } else if (sum.failed) {
    icon = <UiIcon name="alert-triangle" className="h-4 w-4 text-warning" />
    summary = (
      <>
        <UiTrans k="ai.steps.failedSummary" slots={{ total: <span className="font-mono">{sum.total}</span>, failed: <span className="font-mono">{sum.failed}</span> }} />
        {secs && <> · {secs}</>}
      </>
    )
  } else {
    icon = <UiIcon name="check-circle" className="h-4 w-4 text-success" />
    summary = (
      <>
        <span className="font-mono">{sum.total}</span>{t('ai.steps.doneSummary')}
        <span className="hidden md:inline"> · {chain}</span>
        {secs && <> · {secs}</>}
      </>
    )
  }

  return (
    <div className={cn('rounded-xl border bg-card', sum.failed ? 'border-warning/45' : 'border-border', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3.5 py-2.5 text-left text-[13px] text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:min-h-0"
        onClick={() => setUserOpen(!open)}
      >
        {icon}
        <span className="min-w-0 flex-1" role={sum.running ? 'status' : undefined}>{summary}</span>
        <UiIcon name={open ? 'chevron-up' : 'chevron-down'} className="h-4 w-4" />
      </button>
      {open && (
        <ol id={listId} aria-label={t('ai.steps.listLabel')} className="m-0 flex list-none flex-col gap-2 border-t border-border px-3.5 pb-3 pt-1">
          {steps.map(s => (
            <li key={s.id} className="flex items-start gap-2.5 pt-2 text-[13px] leading-5">
              {s.status === 'running'
                ? <UiIcon name="loader" className="mt-0.5 h-4 w-4 animate-spin text-primary" />
                : s.status === 'failed'
                  ? <UiIcon name="alert-circle" className="mt-0.5 h-4 w-4 text-danger" />
                  : <UiIcon name={KIND_ICON[s.kind] || 'check'} className="mt-0.5 h-4 w-4 text-muted-foreground" />}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-foreground">
                  {s.label}
                  {s.status === 'failed' && <span className="sr-only"> — {t('ai.steps.failed')}</span>}
                </span>
                {(s.detail || s.status === 'failed') && (
                  <span className="text-xs text-muted-foreground">
                    {s.detail}
                    {s.status === 'failed' && <>{s.detail ? ' · ' : ''}{t('ai.steps.continuedWithout')}</>}
                  </span>
                )}
              </span>
              {aiStepSecs(s, now) && <span className="font-mono text-xs text-muted-foreground">{aiStepSecs(s, now)}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export default AiSteps
