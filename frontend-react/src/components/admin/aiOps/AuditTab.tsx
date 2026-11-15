// 관리자 › AI 운영 › 감사 로그 — 시안 F2(검색·출처·실패만·CSV, 인자 값 없음 안내, 표) + 결과 없음·실패·로딩 + 모바일 390 목록.
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import { addToast } from '~/composables/useToast'
import { downloadApi } from '~/utils/apiDownload'
import { errText } from '~/utils/errText'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiChip } from '~/components/ui/Chip'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiMenu } from '~/components/ui/Menu'
import { UiSkeleton } from '~/components/ui/Skeleton'
import {
  aiOpsApi, loadError, resultTone, shortStamp, type AuditFilters, type AuditItem, type AuditSource, type LoadError,
} from '~/utils/aiOps'
import { OpsCard, OpsLoadFailed, useOpsLabels } from './parts'

interface ListState { items: AuditItem[]; loading: boolean; loaded: boolean; error: LoadError | null; hasMore: boolean; cursor: string | null; years: number }

export function AuditTab({ days }: { days: number }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const { resultLabel, sourceLabel } = useOpsLabels()
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [source, setSource] = useState<AuditSource>('')
  const [failedOnly, setFailedOnly] = useState(false)
  const [st, setSt] = useState<ListState>({ items: [], loading: true, loaded: false, error: null, hasMore: false, cursor: null, years: 1 })
  const seq = useRef(0)
  const filters: AuditFilters = { q, source, failedOnly, days }

  // 검색어는 잠깐 멈춘 뒤 반영
  useEffect(() => {
    const h = setTimeout(() => setQ(qInput), 300)
    return () => clearTimeout(h)
  }, [qInput])

  async function load(more = false) {
    const my = ++seq.current
    setSt(s => ({ ...s, loading: true, error: more ? s.error : null }))
    try {
      const r = await aiOpsApi.audit(filters, more ? st.cursor : null)
      if (my !== seq.current) return
      setSt(s => ({
        items: more ? [...s.items, ...r.items] : r.items, loading: false, loaded: true, error: null,
        hasMore: r.has_more, cursor: r.next_cursor, years: r.retention_years || s.years,
      }))
    } catch (e) {
      if (my !== seq.current) return
      setSt(s => ({ ...s, loading: false, loaded: true, error: loadError('/api/admin/ai/audit', e) }))
    }
  }
  useEffect(() => { void load() }, [q, source, failedOnly, days]) // eslint-disable-line react-hooks/exhaustive-deps

  function clearFilters() {
    setQInput('')
    setQ('')
    setSource('')
    setFailedOnly(false)
  }
  async function exportCsv() {
    try { await downloadApi(aiOpsApi.auditCsvUrl(filters), 'ai-audit.csv') }
    catch (e: any) { addToast('error', t('aiOps.audit.csvFailed', { msg: errText(e, e?.message || String(e)) })) }
  }

  const sourceText = source === 'builtin' ? t('aiOps.audit.sourceBuiltin') : source === 'connector' ? t('aiOps.audit.sourceConnector') : t('aiOps.audit.sourceAll')
  const sourceItems = ([['', 'sourceAll'], ['builtin', 'sourceBuiltin'], ['connector', 'sourceConnector']] as const)
    .map(([v, k]) => ({ key: v || 'all', label: t(`aiOps.audit.${k}`), radio: true, checked: source === v }))

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2.5 px-[18px] py-4">
      <h2 className="m-0 flex-grow text-[15px] font-semibold">{t('aiOps.audit.title')}</h2>
      <div className={isMobile ? 'w-full' : 'w-[220px]'}>
        <UiInput aria-label={t('aiOps.audit.search')} placeholder={t('aiOps.audit.search')} icon="search" modelValue={qInput} onUpdateModelValue={setQInput} />
      </div>
      <UiMenu
        label={t('aiOps.audit.sourceAll')} items={sourceItems} width={200}
        onSelect={k => setSource(k === 'all' ? '' : (k as AuditSource))}
        trigger={({ toggle }) => <UiChip label={sourceText} icon="filter" variant="toggle" modelValue={!!source} onClick={toggle} />}
      />
      <UiChip label={t('aiOps.audit.failedOnly')} variant="toggle" modelValue={failedOnly} onUpdateModelValue={setFailedOnly} />
      <UiButton variant="outline" size="sm" icon="download" onClick={() => void exportCsv()}>{t('aiOps.audit.csv')}</UiButton>
    </div>
  )

  let body
  if (st.error && !st.items.length) {
    body = <div className="px-[18px] pb-4"><OpsLoadFailed error={st.error} title={t('aiOps.audit.loadFailed')} onRetry={() => void load()} /></div>
  } else if (!st.loaded) {
    body = <div className="px-[18px] pb-4"><UiSkeleton preset="table" rows={6} delay={false} /></div>
  } else if (!st.items.length) {
    body = (
      <div className="p-6">
        <UiEmptyState
          variant="panel" icon="search" title={t('aiOps.audit.emptyTitle')}
          description={t('aiOps.audit.emptyDesc', { n: st.years })}
          actionLabel={t('aiOps.audit.clearFilters')} onAction={clearFilters}
        />
      </div>
    )
  } else if (isMobile) {
    body = (
      <ul aria-label={t('aiOps.audit.title')} className="m-0 list-none p-0">
        {st.items.map((l, i) => (
          <li key={i} className="flex flex-col gap-1 border-t border-border px-4 py-3">
            <span className="flex items-center gap-2">
              <span className="flex-grow font-mono text-[13px]">{l.tool}</span>
              <UiBadge tone={resultTone(l.result)} tint size={18}>{resultLabel(l.result)}</UiBadge>
            </span>
            <span className="text-xs text-muted-foreground">{l.user_name || '—'} · {sourceLabel(l)} · <span className="font-mono">{shortStamp(l.at, true)}</span></span>
          </li>
        ))}
      </ul>
    )
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-[13px]">
          <thead><tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="px-[18px] py-2.5 font-semibold">{t('aiOps.audit.colAt')}</th>
            <th scope="col" className="px-2 py-2.5 font-semibold">{t('aiOps.audit.colUser')}</th>
            <th scope="col" className="px-2 py-2.5 font-semibold">{t('aiOps.audit.colTool')}</th>
            <th scope="col" className="px-2 py-2.5 font-semibold">{t('aiOps.audit.colSource')}</th>
            <th scope="col" className="px-2 py-2.5 font-semibold">{t('aiOps.audit.colResult')}</th>
            <th scope="col" className="px-[18px] py-2.5 font-semibold">{t('aiOps.audit.colCode')}</th>
          </tr></thead>
          <tbody>
            {st.items.map((l, i) => (
              <tr key={i} className="h-[46px] border-t border-border">
                <td className="px-[18px] font-mono text-[12.5px] text-muted-foreground">{shortStamp(l.at, true)}</td>
                <td className="px-2">{l.user_name || '—'}</td>
                <td className="px-2 font-mono text-[12.5px]">{l.tool}</td>
                <td className="px-2 text-muted-foreground">{sourceLabel(l)}</td>
                <td className="px-2"><UiBadge tone={resultTone(l.result)} tint size={18}>{resultLabel(l.result)}</UiBadge></td>
                <td className="px-[18px] font-mono text-[12.5px] text-muted-foreground">{l.code || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <OpsCard aria-label={t('aiOps.audit.title')} className="overflow-hidden" aria-busy={st.loading || undefined}>
      {toolbar}
      <div role="note" className="mx-[18px] mb-3 flex items-center gap-2 rounded-lg bg-secondary px-3 py-2.5 text-[12.5px]">
        <UiIcon name="lock" className="h-3.5 w-3.5 shrink-0" />
        <span>{t('aiOps.audit.privacy')}</span>
      </div>
      {body}
      {st.hasMore && st.items.length > 0 && (
        <div className="flex justify-center border-t border-border p-3">
          <UiButton variant="outline" size="sm" disabled={st.loading} onClick={() => void load(true)}>{t('aiOps.more')}</UiButton>
        </div>
      )}
    </OpsCard>
  )
}
