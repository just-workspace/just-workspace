/**
 * 관리 › 업데이트 화면들이 함께 쓰는 조각 — 요약 표의 줄, 단계 목록, 기록 보기, 불러오기 훅.
 * 상태는 색만으로 구분하지 않는다: 아이콘 + 글자(배지)를 같이 그린다.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { updateApi, downloadJobLog, unavailableReason, type StepStatus, type PullImage } from '~/composables/useSystemUpdate'
import { UiIcon } from '~/components/ui/Icon'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiProgress } from '~/components/ui/Progress'
import { UiCallout } from '~/components/ui/Callout'

/** 진행을 다시 읽는 간격 */
export const updateTiming = { pollMs: 1500 }

/** 요약 표(dl)의 한 줄 — 값이 없으면 줄을 그리지 않는다 */
export function Row({ label, children, action, first = false }: { label: string; children?: ReactNode; action?: ReactNode; first?: boolean }) {
  if (children == null || children === false || children === '') return null
  return (
    <div className={cn('flex min-h-11 flex-wrap items-center gap-3 px-4 py-1', !first && 'border-t border-border')}>
      <dt className="w-[104px] shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 basis-[200px]">{children}</dd>
      {action}
    </div>
  )
}

export const Mono = ({ children, className, ...rest }: { children: ReactNode; className?: string; 'data-testid'?: string }) => <span {...rest} className={cn('font-mono', className)}>{children}</span>

const STEP_LOOK: Record<StepStatus, { icon: string; color: string; tone: 'success' | 'primary' | 'danger' | 'neutral' }> = {
  done: { icon: 'check', color: 'text-success', tone: 'success' },
  running: { icon: 'loader', color: 'text-primary', tone: 'primary' },
  failed: { icon: 'alert-circle', color: 'text-danger', tone: 'danger' },
  pending: { icon: 'clock', color: 'text-muted-foreground', tone: 'neutral' },
}

export interface StepRowData { id: string; label: string; status: StepStatus; note?: string | null; images?: PullImage[]; percent?: number | null }

/** 단계 목록 — 단계마다 아이콘·이름·상태 배지. 진행 중인 단계는 이미지별 진행을, 실패한 단계는 children(실패 카드)을 안에 그린다 */
export function StepRows({ steps, label, failure }: { steps: StepRowData[]; label: string; failure?: ReactNode }) {
  const { t } = useI18n()
  return (
    <ol aria-label={label} className="flex flex-col">
      {steps.map((s, i) => {
        const look = STEP_LOOK[s.status] ?? STEP_LOOK.pending
        return (
          <li key={s.id} data-testid={`step-${s.id}`} data-status={s.status}
            className={cn('flex flex-col text-[13.5px]', i > 0 && 'border-t border-border', s.status === 'failed' && 'bg-danger/10', s.status === 'pending' && 'text-muted-foreground')}>
            <div className="flex min-h-10 flex-wrap items-center gap-3 px-4 py-0.5">
              <UiIcon name={look.icon} className={cn('h-4 w-4 shrink-0', look.color, s.status === 'running' && 'animate-spin motion-reduce:animate-none')} />
              <span className={cn('min-w-0 flex-1 basis-[160px]', (s.status === 'running' || s.status === 'failed') && 'font-semibold')}>{s.label}</span>
              {s.note && <span className="font-mono text-xs text-muted-foreground">{s.note}</span>}
              <UiBadge tone={look.tone} tint size={18}>{t(`admin.update.step.status.${s.status}`)}</UiBadge>
            </div>
            {s.status === 'running' && s.images && s.images.length > 0 && (
              <div className="flex flex-col gap-1.5 px-4 pb-3 pl-11">
                {s.images.map(img => (
                  <div key={img.name} className="flex items-center gap-3 text-xs" data-testid={`image-${img.name}`}>
                    <span className="w-28 shrink-0 truncate font-mono sm:w-40">{img.name}</span>
                    <UiProgress className="min-w-0 flex-1" size="sm" label={img.name} value={img.percent ?? (img.status === 'done' ? 100 : 0)} tone={img.status === 'failed' ? 'danger' : img.status === 'done' ? 'success' : 'primary'} />
                    <span className="w-12 shrink-0 text-right font-mono text-muted-foreground">
                      {img.status === 'done' ? t('admin.update.step.status.done') : img.status === 'failed' ? t('admin.update.step.status.failed') : `${img.percent ?? 0}%`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {s.status === 'running' && !s.images?.length && s.percent != null && (
              <div className="px-4 pb-3 pl-11"><UiProgress size="sm" label={s.label} value={s.percent} /></div>
            )}
            {s.status === 'failed' && failure && <div className="flex flex-col gap-3 px-4 pb-4 pl-11">{failure}</div>}
          </li>
        )
      })}
    </ol>
  )
}

/** "기록 보기"(펼침) + "기록 내려받기" */
export function LogButtons({ jobId }: { jobId: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<string[] | null>(null)
  const [failed, setFailed] = useState(false)

  async function toggle() {
    const next = !open
    setOpen(next)
    if (!next) return
    setFailed(false)
    try { setLines((await updateApi.jobLog(jobId)).lines) } catch { setFailed(true) }
  }
  async function download() {
    try { await downloadJobLog(jobId) } catch { addToast('error', t('admin.update.log.downloadFailed')) }
  }
  return (
    <>
      <UiButton size="sm" variant="outline" icon="terminal" iconRight={open ? 'chevron-up' : 'chevron-down'} aria-expanded={open} onClick={() => { void toggle() }}>{t('admin.update.log.view')}</UiButton>
      <UiButton size="sm" variant="outline" icon="download" onClick={() => { void download() }}>{t('admin.update.log.download')}</UiButton>
      {open && (
        <pre className="max-h-64 w-full basis-full overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-5" data-testid="update-log">
          {failed ? t('admin.update.log.failed') : lines == null ? t('admin.update.log.loading') : lines.length ? lines.join('\n') : t('admin.update.log.empty')}
        </pre>
      )}
    </>
  )
}

/** 설치 관리자가 없거나 업데이트를 모르는 설치의 안내 */
export function Unavailable({ reason }: { reason: 'no_installer' | 'unsupported' }) {
  const { t } = useI18n()
  return (
    <UiCallout tone="neutral" role="status" data-testid="update-unavailable" title={t(`admin.update.unavailable.${reason}.title`)}>
      {t(`admin.update.unavailable.${reason}.body`)}
    </UiCallout>
  )
}

export interface Loaded<T> { data: T | null; error: unknown; unavailable: 'no_installer' | 'unsupported' | null; loading: boolean; reload: () => Promise<T | null>; set: (v: T) => void }

/** 한 번 불러오고 다시 부를 수 있는 값. 화면을 떠난 뒤의 응답은 버린다 */
export function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)
  const seq = useRef(0)
  const fn = useRef(fetcher)
  fn.current = fetcher
  const reload = useCallback(async () => {
    const my = ++seq.current
    try {
      const r = await fn.current()
      if (alive.current && my === seq.current) { setData(r); setError(null) }
      return r
    } catch (e) {
      if (alive.current && my === seq.current) setError(e)
      return null
    } finally {
      if (alive.current && my === seq.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    alive.current = true
    setLoading(true)
    void reload()
    return () => { alive.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error, unavailable: error ? unavailableReason(error) : null, loading, reload, set: setData }
}

/** 조건이 참인 동안 일정 간격으로 다시 부른다(겹쳐 부르지 않는다) */
export function usePoll(active: boolean, fn: () => Promise<unknown>) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    let stopped = false
    let running = false
    const id = setInterval(() => {
      if (running || stopped) return
      running = true
      void ref.current().finally(() => { running = false })
    }, updateTiming.pollMs)
    return () => { stopped = true; clearInterval(id) }
  }, [active])
}
