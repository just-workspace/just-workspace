// 관리자 › AI 운영 › 쓰기 현황 — 시안 F2(위험도별 실행·되돌림·거부·만료·실패 + 외부 내용 뒤 low 안내).
// low 에는 거부가 없고(카드 [취소]는 거부가 아님), high 에는 되돌리기가 없어 '—'.
import { useI18n } from '~/i18n'
import { UiBadge } from '~/components/ui/Badge'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTrans } from '~/components/ui/Trans'
import { fmtNum, type UsageState, type WriteBucket } from '~/utils/aiOps'
import { OpsCard, OpsLoadFailed } from './parts'

export function WritesTab({ days, state, onRetry }: { days: number; state: UsageState; onRetry: () => void }) {
  const { t } = useI18n()
  if (state.error) return <OpsLoadFailed error={state.error} title={t('aiOps.writes.loadFailed')} onRetry={onRetry} />
  if (!state.data) return <UiSkeleton preset="table" framed delay={false} />
  const ws = state.data.writes_summary
  const dash = <span className="text-muted-foreground">—</span>
  const row = (risk: 'low' | 'high', b: WriteBucket) => (
    <tr className="h-12 border-t border-border">
      <th scope="row" className="px-[18px] text-left font-sans font-medium">
        <UiBadge tone={risk === 'low' ? 'success' : 'danger'} tint size={18}>{risk}</UiBadge>
      </th>
      <td className="px-2">{fmtNum(b.executed)}</td>
      <td className="px-2">{risk === 'high' ? dash : fmtNum(b.undone)}</td>
      <td className="px-2">{risk === 'low' ? dash : fmtNum(b.rejected)}</td>
      <td className="px-2">{fmtNum(b.expired)}</td>
      <td className="px-[18px]">{fmtNum(b.failed)}</td>
    </tr>
  )
  return (
    <OpsCard aria-label={t('aiOps.writes.title')} className="max-w-[720px] overflow-hidden" aria-busy={state.loading || undefined}>
      <h2 className="m-0 px-[18px] pb-1 pt-4 text-[15px] font-semibold">
        {t('aiOps.writes.title')} <span className="text-[12.5px] font-normal text-muted-foreground">{t('aiOps.writes.periodNote', { n: days })}</span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead><tr className="text-right text-xs text-muted-foreground">
            <th scope="col" className="px-[18px] py-2.5 text-left font-semibold">{t('aiOps.writes.risk')}</th>
            <th scope="col" className="px-2 py-2.5 font-semibold">{t('aiOps.writes.executed')}</th>
            <th scope="col" className="px-2 py-2.5 font-semibold">{t('aiOps.writes.undone')}</th>
            <th scope="col" className="px-2 py-2.5 font-semibold">{t('aiOps.writes.rejected')}</th>
            <th scope="col" className="px-2 py-2.5 font-semibold">{t('aiOps.writes.expired')}</th>
            <th scope="col" className="px-[18px] py-2.5 font-semibold">{t('aiOps.writes.failed')}</th>
          </tr></thead>
          <tbody className="text-right font-mono">
            {row('low', ws.low)}
            {row('high', ws.high)}
          </tbody>
        </table>
      </div>
      <p className="m-0 px-[18px] pb-4 pt-3 text-[12.5px] text-muted-foreground">
        <UiTrans k="aiOps.writes.note" slots={{ min: <span className="font-mono">{ws.untrusted_window_min}</span>, n: <span className="font-mono">{fmtNum(ws.low_after_untrusted)}</span> }} />
      </p>
    </OpsCard>
  )
}
