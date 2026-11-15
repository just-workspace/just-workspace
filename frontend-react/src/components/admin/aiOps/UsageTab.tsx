// 관리자 › AI 운영 › 사용량 — 핵심 수치 4 · 일별 질문 막대 · 사용자별·도구별·그룹별 표 + 상태(로딩·실패)·모바일 390.
import { useState } from 'react'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import { UiBadge } from '~/components/ui/Badge'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTrans } from '~/components/ui/Trans'
import { fmtNum, fmtRate, mmdd, niceMax, type UsageResponse, type UsageState } from '~/utils/aiOps'
import { OpsCard, OpsLoadFailed, OpsTitle, TH } from './parts'

const MONO = 'font-mono'
const TD_NUM = `px-2 text-right ${MONO}`

export function UsageTab({ days, state, onRetry }: { days: number; state: UsageState; onRetry: () => void }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  if (state.error) return <OpsLoadFailed error={state.error} title={t('aiOps.usage.loadFailed')} onRetry={onRetry} />
  if (!state.data) {
    return (
      <div className="grid grid-cols-2 gap-3" aria-busy="true">
        <UiSkeleton preset="card" framed delay={false} />
        <UiSkeleton preset="card" framed delay={false} />
      </div>
    )
  }
  const d = state.data
  return (
    <div className="flex flex-col gap-5" aria-busy={state.loading || undefined}>
      <Tiles d={d} mobile={isMobile} />
      {!isMobile && <DailyChart d={d} days={days} />}
      {isMobile ? <MobileTop d={d} /> : (
        <>
          <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(420px,1fr))]">
            <UsersTable d={d} />
            <ToolsTable d={d} />
          </div>
          <GroupsTable d={d} />
        </>
      )}
      {d.totals.truncated && <p className="text-xs text-muted-foreground">{t('aiOps.usage.truncated')}</p>}
    </div>
  )
}

function Tiles({ d, mobile }: { d: UsageResponse; mobile: boolean }) {
  const { t } = useI18n()
  const tt = d.totals
  const tiles = [
    { label: t('aiOps.usage.questions'), value: fmtNum(tt.questions), sub: t('aiOps.usage.questionsSub', { builtin: fmtNum(tt.questions), connector: fmtNum(tt.connector_calls) }) },
    { label: t('aiOps.usage.toolCalls'), value: fmtNum(tt.tool_calls), sub: t('aiOps.usage.toolCallsSub', { n: fmtNum(tt.write_tool_calls) }) },
    { label: mobile ? t('aiOps.usage.successRateShort') : t('aiOps.usage.successRate'), value: fmtRate(tt.tool_success_rate), sub: t('aiOps.usage.failSub', { n: fmtNum(tt.tool_failures) }) },
    { label: t('aiOps.usage.activeUsers'), value: fmtNum(tt.active_users), sub: t('aiOps.usage.activeSub', { n: fmtNum(tt.users_total) }) },
  ]
  if (mobile) {
    return (
      <div className="grid grid-cols-2 gap-2.5">
        {tiles.map(x => (
          <div key={x.label} className="rounded-xl border border-border bg-card p-3">
            <span className="block text-xs text-muted-foreground">{x.label}</span>
            <span className={`${MONO} text-[22px]`}>{x.value}</span>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
      {tiles.map(x => (
        <div key={x.label} className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-[18px] py-4">
          <span className="text-[12.5px] text-muted-foreground">{x.label}</span>
          <span className={`${MONO} text-[28px] font-medium leading-[34px]`}>{x.value}</span>
          <span className="text-xs text-muted-foreground">{x.sub}</span>
        </div>
      ))}
    </div>
  )
}

function DailyChart({ d, days }: { d: UsageResponse; days: number }) {
  const { t } = useI18n()
  const [hover, setHover] = useState(-1)
  const [asTable, setAsTable] = useState(false)
  const vals = d.daily.map(x => x.questions)
  const top = niceMax(Math.max(0, ...vals))
  const n = d.daily.length
  const labels = n ? [d.daily[0].date, d.daily[Math.floor((n - 1) / 2)].date, d.daily[n - 1].date] : []
  return (
    <OpsCard aria-label={t('aiOps.usage.dailyTitle', { n: days })} className="flex flex-col gap-3 px-[18px] py-4">
      <div className="flex items-baseline gap-2.5">
        <OpsTitle className="flex-grow"><UiTrans k="aiOps.usage.dailyTitle" slots={{ n: <span className={MONO}>{n}</span> }} /></OpsTitle>
        <button type="button" className="text-[12.5px] text-primary hover:underline" onClick={() => setAsTable(v => !v)}>
          {asTable ? t('aiOps.usage.showChart') : t('aiOps.usage.showTable')}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-[260px] overflow-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead><tr className="text-left"><th scope="col" className={TH}>{t('aiOps.usage.colDate')}</th><th scope="col" className={`${TH} text-right`}>{t('aiOps.usage.colQuestions')}</th><th scope="col" className={`${TH} text-right`}>{t('aiOps.usage.colToolCalls')}</th></tr></thead>
            <tbody>
              {d.daily.map(x => (
                <tr key={x.date} className="h-9 border-t border-border">
                  <td className={`px-2 ${MONO} text-[12.5px]`}>{x.date}</td>
                  <td className={TD_NUM}>{fmtNum(x.questions)}</td>
                  <td className={TD_NUM}>{fmtNum(x.tool_calls)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="relative flex h-[180px] items-end gap-0.5 border-b border-border" onMouseLeave={() => setHover(-1)}>
            <div aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-dashed border-border/60" />
            <span aria-hidden="true" className={`absolute left-0 top-[-2px] bg-card pr-1 ${MONO} text-[11px] text-muted-foreground`}>{fmtNum(top)}</span>
            {d.daily.map((x, i) => (
              <div key={x.date} className="flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
                <div
                  role="img" aria-label={t('aiOps.usage.barAria', { date: mmdd(x.date), n: x.questions })}
                  className={i === hover ? 'w-full rounded-t bg-primary' : 'w-full rounded-t bg-primary/70'}
                  style={{ height: `${Math.round((x.questions / top) * 100)}%` }}
                />
              </div>
            ))}
            {hover >= 0 && d.daily[hover] && (
              <div
                role="tooltip"
                className="pointer-events-none absolute top-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs"
                style={{ left: `${(((hover + 0.5) / n) * 100).toFixed(1)}%` }}
              >
                <span className="text-muted-foreground">{mmdd(d.daily[hover].date)}</span> · {t('aiOps.usage.tipQuestions')} <span className={MONO}>{fmtNum(d.daily[hover].questions)}</span>
              </div>
            )}
          </div>
          <div className={`flex justify-between ${MONO} text-[11px] text-muted-foreground`}>
            {labels.map((l, i) => <span key={i}>{mmdd(l)}</span>)}
          </div>
        </>
      )}
    </OpsCard>
  )
}

function EmptyRow({ cols }: { cols: number }) {
  const { t } = useI18n()
  return <tr className="h-11 border-t border-border"><td colSpan={cols} className="px-4 text-center text-[13px] text-muted-foreground">{t('aiOps.noRecords')}</td></tr>
}

function UsersTable({ d }: { d: UsageResponse }) {
  const { t } = useI18n()
  return (
    <OpsCard aria-label={t('aiOps.usage.byUser')} className="overflow-x-auto">
      <OpsTitle className="px-4 pb-1.5 pt-3.5">{t('aiOps.usage.byUser')}</OpsTitle>
      <table className="w-full border-collapse text-[13px]">
        <thead><tr className="text-left">
          <th scope="col" className={`${TH} pl-4`}>{t('aiOps.usage.colName')}</th>
          <th scope="col" className={TH}>{t('aiOps.usage.colGroup')}</th>
          <th scope="col" className={`${TH} text-right`}>{t('aiOps.usage.colQuestions')}</th>
          <th scope="col" className={`${TH} text-right`}>{t('aiOps.usage.colToolCalls')}</th>
          <th scope="col" className={`${TH} pr-4 text-right`}>{t('aiOps.usage.colFailures')}</th>
        </tr></thead>
        <tbody>
          {d.users.length === 0 && <EmptyRow cols={5} />}
          {d.users.map(u => (
            <tr key={u.user_id} className="h-11 border-t border-border">
              <td className="px-4">{u.name}</td>
              <td className="px-2 text-muted-foreground">{u.groups.join(', ') || '—'}</td>
              <td className={TD_NUM}>{fmtNum(u.questions)}</td>
              <td className={TD_NUM}>{fmtNum(u.tool_calls)}</td>
              <td className={`${TD_NUM} pr-4`}>{fmtNum(u.tool_failures)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </OpsCard>
  )
}

function ToolsTable({ d }: { d: UsageResponse }) {
  const { t } = useI18n()
  return (
    <OpsCard aria-label={t('aiOps.usage.byTool')} className="overflow-x-auto">
      <OpsTitle className="px-4 pb-1.5 pt-3.5">{t('aiOps.usage.byTool')}</OpsTitle>
      <table className="w-full border-collapse text-[13px]">
        <thead><tr className="text-left">
          <th scope="col" className={`${TH} pl-4`}>{t('aiOps.usage.colTool')}</th>
          <th scope="col" className={`${TH} text-right`}>{t('aiOps.usage.colCalls')}</th>
          <th scope="col" className={`${TH} text-right`}>{t('aiOps.usage.colFailures')}</th>
          <th scope="col" className={`${TH} text-right`}>{t('aiOps.usage.colRate')}</th>
          <th scope="col" className={`${TH} text-right`}>{t('aiOps.usage.colP50')}</th>
          <th scope="col" className={`${TH} pr-4 text-right`}>{t('aiOps.usage.colP95')}</th>
        </tr></thead>
        <tbody>
          {d.tools.length === 0 && <EmptyRow cols={6} />}
          {d.tools.map(o => (
            <tr key={o.tool} className="h-11 border-t border-border">
              <td className={`px-4 ${MONO} text-[12.5px]`}>{o.tool}</td>
              <td className={TD_NUM}>{fmtNum(o.calls)}</td>
              <td className={TD_NUM}>{fmtNum(o.failures)}</td>
              <td className={`${TD_NUM} ${o.success_rate != null && o.success_rate < 0.9 ? 'text-warning' : ''}`}>{fmtRate(o.success_rate)}</td>
              <td className={TD_NUM}>{fmtNum(o.p50_ms)}</td>
              <td className={`${TD_NUM} pr-4`}>{fmtNum(o.p95_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </OpsCard>
  )
}

function GroupsTable({ d }: { d: UsageResponse }) {
  const { t } = useI18n()
  return (
    <OpsCard aria-label={t('aiOps.usage.byGroup')} className="overflow-x-auto">
      <div className="flex items-center gap-2 px-4 pb-1.5 pt-3.5">
        <OpsTitle className="flex-grow">{t('aiOps.usage.byGroup')}</OpsTitle>
        <UiBadge tone="neutral" tint size={18}>{t('aiOps.usage.quotaNext')}</UiBadge>
      </div>
      <table className="w-full min-w-[640px] border-collapse text-[13px]">
        <thead><tr className="text-left">
          <th scope="col" className={`${TH} pl-4`}>{t('aiOps.usage.colGroup')}</th>
          <th scope="col" className={`${TH} text-right`}>{t('aiOps.usage.colUsers')}</th>
          <th scope="col" className={`${TH} text-right`}>{t('aiOps.usage.colQuestions')}</th>
          <th scope="col" className={`${TH} text-right`}>{t('aiOps.usage.colToolCalls')}</th>
          <th scope="col" className={`${TH} pr-4`}>{t('aiOps.usage.colQuota')}</th>
        </tr></thead>
        <tbody>
          {d.groups.length === 0 && <EmptyRow cols={5} />}
          {d.groups.map(g => (
            <tr key={g.group} className="h-11 border-t border-border">
              <td className="px-4">{g.group === '(그룹 없음)' ? t('aiOps.usage.noGroup') : g.group}</td>
              <td className={TD_NUM}>{fmtNum(g.users ?? 0)}</td>
              <td className={TD_NUM}>{fmtNum(g.questions ?? 0)}</td>
              <td className={TD_NUM}>{fmtNum(g.tool_calls ?? 0)}</td>
              <td className="px-4 text-muted-foreground">—</td>
            </tr>
          ))}
        </tbody>
      </table>
    </OpsCard>
  )
}

/** 모바일 390 — 표 대신 사용자·도구 상위 5개 목록 */
function MobileTop({ d }: { d: UsageResponse }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[12.5px] text-muted-foreground">{t('aiOps.usage.mobileNote')}</p>
      <OpsCard aria-label={t('aiOps.usage.topUsers')}>
        <OpsTitle className="px-4 pb-1 pt-3">{t('aiOps.usage.topUsers')}</OpsTitle>
        <ul className="m-0 list-none p-0">
          {d.users.slice(0, 5).map(u => (
            <li key={u.user_id} className="flex flex-col gap-0.5 border-t border-border px-4 py-2.5 first:border-t-0">
              <span className="text-[13.5px]">{u.name}</span>
              <span className="text-xs text-muted-foreground">{t('aiOps.usage.mobileUserLine', { q: fmtNum(u.questions), t: fmtNum(u.tool_calls), f: fmtNum(u.tool_failures) })}</span>
            </li>
          ))}
          {d.users.length === 0 && <li className="px-4 py-3 text-[13px] text-muted-foreground">{t('aiOps.noRecords')}</li>}
        </ul>
      </OpsCard>
      <OpsCard aria-label={t('aiOps.usage.topTools')}>
        <OpsTitle className="px-4 pb-1 pt-3">{t('aiOps.usage.topTools')}</OpsTitle>
        <ul className="m-0 list-none p-0">
          {d.tools.slice(0, 5).map(o => (
            <li key={o.tool} className="flex flex-col gap-0.5 border-t border-border px-4 py-2.5 first:border-t-0">
              <span className={`${MONO} text-[13px]`}>{o.tool}</span>
              <span className="text-xs text-muted-foreground">{t('aiOps.usage.mobileToolLine', { n: fmtNum(o.calls), rate: fmtRate(o.success_rate), p95: fmtNum(o.p95_ms) })}</span>
            </li>
          ))}
          {d.tools.length === 0 && <li className="px-4 py-3 text-[13px] text-muted-foreground">{t('aiOps.noRecords')}</li>}
        </ul>
      </OpsCard>
    </div>
  )
}
