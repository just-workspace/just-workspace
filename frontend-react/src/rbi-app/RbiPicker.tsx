/**
 * 대상 고르기(단독 앱, 세션이 없을 때) — 대상 카드(하나 고름) · 화면 방식 · [시작] · 내 최근 세션 목록.
 * 딥 링크 ?target=<key> 면 그 대상을 미리 고르고 [시작] 에 포커스(세션은 사용자가 눌러야 뜬다 — 링크만으로 컨테이너를 띄우지 않는다).
 * TODO: 카드 밀도·선택 표시·세션 목록 행 규격은 디자인 확정 뒤에. 기존 키트(UiCard·UiBadge·UiButton·UiSegment·UiEmptyState)만.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { fmtRbiTime, rbiPolicyKeys, type RbiMode, type RbiSession, type RbiTarget } from '~/composables/useRbi'
import { cn } from '~/lib/utils'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiCard } from '~/components/ui/Card'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'
import { UiSegment } from '~/components/ui/Segment'

export interface RbiPickerProps {
  targets: RbiTarget[]
  recent: RbiSession[]
  /** 딥 링크 대상 key */
  initialKey?: string | null
  starting: boolean
  onStart: (t: RbiTarget, mode: RbiMode) => void
  onResume: (s: RbiSession) => void
}

function statusTone(s: RbiSession['status']): 'success' | 'warning' | 'neutral' | 'danger' {
  return s === 'running' ? 'success' : s === 'starting' ? 'warning' : s === 'error' ? 'danger' : 'neutral'
}

export function RbiPicker({ targets, recent, initialKey, starting, onStart, onResume }: RbiPickerProps) {
  const { t } = useI18n()
  const initial = targets.find(x => x.key === initialKey) ?? (targets.length === 1 ? targets[0] : null)
  const [selId, setSelId] = useState<string | null>(initial?.id ?? null)
  const sel = targets.find(x => x.id === selId) ?? null
  const [mode, setMode] = useState<RbiMode>(sel?.mode ?? 'pixel')
  const startRef = useRef<HTMLElement>(null)

  useEffect(() => { if (sel) setMode(sel.mode ?? 'pixel') }, [sel?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // 딥 링크로 왔으면 [시작] 에 포커스
  useEffect(() => { if (initialKey && initial) startRef.current?.focus() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{t('rbi.title')}</h1>
        <p className="text-[13px] text-muted-foreground">{t('rbi.pageSubtitle')}</p>
      </header>

      {targets.length === 0 ? (
        <UiEmptyState variant="panel" icon="shield" title={t('rbi.noTargets')} description={t('rbi.noTargetsDesc')} />
      ) : (
        <section aria-label={t('rbi.targets')} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">{t('rbi.targets')}</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {targets.map(tg => {
              const on = tg.id === selId
              return (
                <li key={tg.id}>
                  <UiCard className={cn('h-full p-0', on ? 'ring-2 ring-primary' : '')}>
                    <button
                      type="button"
                      aria-pressed={on}
                      data-testid={`rbi-target-${tg.key}`}
                      onClick={() => setSelId(tg.id)}
                      className="flex h-full w-full flex-col gap-3 rounded-[inherit] p-4 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <UiIcon name="shield" className="h-5 w-5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-semibold text-foreground">{tg.name}</span>
                          <span className="block truncate font-mono text-xs text-muted-foreground">{tg.url}</span>
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1.5">
                        {rbiPolicyKeys(tg.policy).map(k => <UiBadge key={k} tone="neutral" tint size={18}>{t(k)}</UiBadge>)}
                        <UiBadge tone="neutral" tint size={18}>{tg.policy.idle_minutes}m / {tg.policy.max_hours}h</UiBadge>
                        <UiBadge tone={tg.mode === 'mirror' ? 'primary' : 'neutral'} tint size={18}>{t(`rbi.mode.${tg.mode ?? 'pixel'}`)}</UiBadge>
                      </span>
                    </button>
                  </UiCard>
                </li>
              )
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            {sel && (sel.modes ?? []).length > 1 && (
              <UiSegment
                ariaLabel={t('rbi.mode.label')}
                items={(sel.modes ?? []).map(m => ({ value: m, label: t(`rbi.mode.${m}`) }))}
                modelValue={mode}
                onUpdateModelValue={v => v && setMode(v as RbiMode)}
              />
            )}
            <UiButton ref={startRef} icon="external-link" disabled={!sel || starting} onClick={() => sel && onStart(sel, mode)}>
              {starting ? t('rbi.starting') : sel ? t('rbi.app.startTarget', { name: sel.name }) : t('rbi.app.pickTarget')}
            </UiButton>
          </div>
        </section>
      )}

      <section aria-label={t('rbi.app.recent')} className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">{t('rbi.app.recent')}</h2>
        {recent.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('rbi.app.noRecent')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border" data-testid="rbi-recent">
            {recent.map(s => {
              const live = s.status === 'running' || s.status === 'starting'
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                  <UiBadge tone={statusTone(s.status)} tint>{t(`rbi.status.${s.status}`)}</UiBadge>
                  <span className="min-w-0 flex-1 truncate text-foreground">{s.target_name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{t(`rbi.mode.${s.mode ?? 'pixel'}`)} · {fmtRbiTime(s.started_at)}{s.ended_at ? `–${fmtRbiTime(s.ended_at)}` : ''}</span>
                  {!live && s.end_reason && <span className="text-xs text-muted-foreground">{t(`rbi.reason.${s.end_reason}`)}</span>}
                  {live && <UiButton variant="outline" size="xs" onClick={() => onResume(s)}>{t('rbi.resume')}</UiButton>}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
