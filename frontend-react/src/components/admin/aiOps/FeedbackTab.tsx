// 관리자 › AI 운영 › 피드백 — 통계 카드(대화 내용 없음) · 별로예요 목록 + 첨부된 대화 패널 ·
// 스냅샷 소실 2종·삭제 확인·만료/삭제 행·빈 목록·조회 실패·모바일 전체 화면 시트 + 권한(403).
// 대화 보기는 사용자가 첨부를 선택한 행에만 제공되며, 열 때마다 서버가 감사 로그(ai_feedback.view)를 기록한다.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import { addToast } from '~/composables/useToast'
import { errText } from '~/utils/errText'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiChip } from '~/components/ui/Chip'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiMenu } from '~/components/ui/Menu'
import { UiModal } from '~/components/ui/Modal'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTrans } from '~/components/ui/Trans'
import {
  aiOpsApi, FEEDBACK_REASONS, fmtNum, loadError, shortStamp, snapshotGoneCode,
  type FeedbackItem, type FeedbackSnapshot, type LoadError, type SnapshotState, type UsageState,
} from '~/utils/aiOps'
import { OpsCard, OpsLoadFailed, useOpsLabels } from './parts'

interface ListState {
  items: FeedbackItem[]; total: number; attached: number; reasonCounts: Record<string, number>; ttl: number
  loading: boolean; loaded: boolean; error: LoadError | null; hasMore: boolean; cursor: string | null
}
const EMPTY: ListState = { items: [], total: 0, attached: 0, reasonCounts: {}, ttl: 90, loading: true, loaded: false, error: null, hasMore: false, cursor: null }

type Panel =
  | { id: string; kind: 'loading' }
  | { id: string; kind: 'ready'; snap: FeedbackSnapshot }
  | { id: string; kind: 'gone'; code: SnapshotState }
  | { id: string; kind: 'error'; error: LoadError }

export function FeedbackTab({ days, usage, onRetryUsage }: { days: number; usage: UsageState; onRetryUsage: () => void }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const { reasonLabel } = useOpsLabels()
  const [reason, setReason] = useState('')
  const [attachedOnly, setAttachedOnly] = useState(false)
  const [st, setSt] = useState<ListState>(EMPTY)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const seq = useRef(0)

  async function load(more = false) {
    const my = ++seq.current
    setSt(s => ({ ...s, loading: true, error: more ? s.error : null }))
    try {
      const r = await aiOpsApi.feedback({ days, reason, attachedOnly, cursor: more ? st.cursor : null })
      if (my !== seq.current) return
      setSt(s => ({
        items: more ? [...s.items, ...r.items] : r.items, total: r.total, attached: r.attached_total ?? 0,
        reasonCounts: r.reason_counts || {}, ttl: r.snapshot_ttl_days || 90,
        loading: false, loaded: true, error: null, hasMore: r.has_more, cursor: r.next_cursor,
      }))
    } catch (e) {
      if (my !== seq.current) return
      setSt(s => ({ ...s, loading: false, loaded: true, error: loadError('/api/admin/ai/feedback', e) }))
    }
  }
  useEffect(() => { void load() }, [days, reason, attachedOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  function patchRow(id: string, snapshot: SnapshotState) {
    setSt(s => ({ ...s, items: s.items.map(i => (i.id === id ? { ...i, snapshot } : i)) }))
  }

  async function open(id: string) {
    setPanel({ id, kind: 'loading' })
    try {
      const snap = await aiOpsApi.snapshot(id)
      setPanel(p => (p?.id === id ? { id, kind: 'ready', snap } : p))
    } catch (e) {
      const code = snapshotGoneCode(e)
      if (code) {
        patchRow(id, code)
        setPanel(p => (p?.id === id ? { id, kind: 'gone', code } : p))
      } else {
        setPanel(p => (p?.id === id ? { id, kind: 'error', error: loadError(`/api/admin/ai/feedback/${id}/snapshot`, e) } : p))
      }
    }
  }

  async function doDelete() {
    if (!panel) return
    const id = panel.id
    setDeleting(true)
    try {
      await aiOpsApi.deleteSnapshot(id)
      patchRow(id, 'admin_deleted')
      setPanel({ id, kind: 'gone', code: 'admin_deleted' })
      setConfirmDel(false)
      setSt(s => ({ ...s, attached: Math.max(0, s.attached - 1) }))
      addToast('success', t('aiOps.feedback.deleted'))
    } catch (e: any) {
      addToast('error', t('aiOps.feedback.deleteFailed', { msg: errText(e, e?.message || String(e)) }))
    } finally {
      setDeleting(false)
    }
  }

  function clearFilters() {
    setReason('')
    setAttachedOnly(false)
  }

  const filtered = !!reason || attachedOnly
  const current = panel ? st.items.find(i => i.id === panel.id) ?? null : null

  // ── 대화 칸(행 오른쪽): 첨부 → [대화 보기], 소실 → 상태 배지, 미첨부 → 글자 ──
  function convCell(r: FeedbackItem, mobile = false): ReactNode {
    if (r.snapshot === 'attached') {
      return <UiButton variant="outline" size={mobile ? 'lg' : 'xs'} icon="eye" onClick={() => void open(r.id)}>{t('aiOps.feedback.view')}</UiButton>
    }
    if (r.snapshot === 'expired' || r.snapshot === 'conversation_deleted' || r.snapshot === 'admin_deleted') {
      return <UiBadge tone="neutral" size={18}>{t(`aiOps.feedback.state.${r.snapshot}`)}</UiBadge>
    }
    return mobile ? null : <span className="text-xs text-muted-foreground">{t('aiOps.feedback.notAttached')}</span>
  }

  const reasonText = reason ? reasonLabel(reason) : t('aiOps.feedback.reasonAll')
  const reasonItems = [
    { key: 'all', label: t('aiOps.feedback.reasonAll'), radio: true, checked: !reason },
    ...FEEDBACK_REASONS.map(r => ({ key: r, label: reasonLabel(r), radio: true, checked: reason === r, badge: st.reasonCounts[r] ? String(st.reasonCounts[r]) : undefined })),
  ]

  // ── 목록 ──
  let listBody: ReactNode
  if (st.error && !st.items.length) {
    listBody = <div className="px-4 pb-4"><OpsLoadFailed error={st.error} title={t('aiOps.feedback.loadFailed')} onRetry={() => void load()} /></div>
  } else if (!st.loaded) {
    listBody = <div className="px-4 pb-4"><UiSkeleton preset="table" rows={6} delay={false} /></div>
  } else if (!st.items.length) {
    listBody = (
      <div className="p-6">
        {filtered
          ? <UiEmptyState variant="panel" icon="inbox" title={t('aiOps.feedback.emptyFilteredTitle')} description={t('aiOps.feedback.emptyFilteredDesc')} actionLabel={t('aiOps.audit.clearFilters')} onAction={clearFilters} />
          : <UiEmptyState variant="panel" icon="inbox" title={t('aiOps.feedback.emptyTitle')} description={t('aiOps.feedback.emptyDesc')} />}
      </div>
    )
  } else if (isMobile) {
    listBody = (
      <ul className="m-0 list-none p-0">
        {st.items.map(r => (
          <li key={r.id} className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
            <span className="flex items-center gap-2">
              {r.reasons.map(x => <UiBadge key={x} tone="neutral" tint size={18}>{reasonLabel(x)}</UiBadge>)}
              <span className="flex-grow" />
              <span className="font-mono text-xs text-muted-foreground">{shortStamp(r.at)}</span>
            </span>
            {r.comment && <span className="text-[13.5px]">{r.comment}</span>}
            {convCell(r, true)}
          </li>
        ))}
      </ul>
    )
  } else {
    listBody = (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-[13px]">
          <thead><tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-2 font-semibold">{t('aiOps.feedback.colAt')}</th>
            <th scope="col" className="px-2 py-2 font-semibold">{t('aiOps.feedback.colReason')}</th>
            <th scope="col" className="px-2 py-2 font-semibold">{t('aiOps.feedback.colComment')}</th>
            <th scope="col" className="px-2 py-2 font-semibold">{t('aiOps.feedback.colTools')}</th>
            <th scope="col" className="px-4 py-2 font-semibold">{t('aiOps.feedback.colConversation')}</th>
          </tr></thead>
          <tbody>
            {st.items.map(r => (
              <tr key={r.id} className={`h-[52px] border-t border-border ${panel?.id === r.id ? 'bg-accent' : ''}`}>
                <td className="whitespace-nowrap px-4 font-mono text-[12.5px] text-muted-foreground">{shortStamp(r.at)}</td>
                <td className="px-2"><span className="flex flex-wrap gap-1">{r.reasons.length ? r.reasons.map(x => <UiBadge key={x} tone="neutral" tint size={18}>{reasonLabel(x)}</UiBadge>) : '—'}</span></td>
                <td className="max-w-[280px] truncate px-2" title={r.comment || undefined}>{r.comment}</td>
                <td className="px-2 font-mono text-xs text-muted-foreground">{r.tools.length ? r.tools.join(' · ') : '—'}</td>
                <td className="px-4">{convCell(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  // ── 첨부된 대화 패널(데스크톱 오른쪽 · 모바일 전체 화면 시트) ──
  const privacyNote = (
    <div role="note" className="mx-4 mt-3 flex gap-2 rounded-lg bg-secondary px-3 py-2.5 text-[12.5px] leading-[19px]">
      <UiIcon name="lock" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{t('aiOps.feedback.privacy')}</span>
    </div>
  )
  function panelBody(p: Panel): ReactNode {
    if (p.kind === 'loading') return <div className="p-4"><UiSkeleton preset="text" rows={5} delay={false} /></div>
    if (p.kind === 'error') return <div className="p-4"><OpsLoadFailed placement="panel" error={p.error} title={t('aiOps.feedback.snapshotFailed')} onRetry={() => void open(p.id)} /></div>
    if (p.kind === 'gone') {
      const g = p.code === 'conversation_deleted' ? { icon: 'trash', title: 'goneUserTitle', desc: 'goneUserDesc' }
        : p.code === 'expired' ? { icon: 'clock', title: 'goneExpiredTitle', desc: 'goneExpiredDesc' }
          : p.code === 'admin_deleted' ? { icon: 'trash', title: 'goneAdminTitle', desc: 'goneAdminDesc' }
            : { icon: 'inbox', title: 'goneNoneTitle', desc: 'goneNoneDesc' }
      return <div className="p-6"><UiEmptyState variant="panel" icon={g.icon} title={t(`aiOps.feedback.${g.title}`)} description={t(`aiOps.feedback.${g.desc}`, { n: st.ttl })} /></div>
    }
    const s = p.snap
    const lastAssistant = s.messages.map(m => m.role).lastIndexOf('assistant')
    const who = t('aiOps.feedback.who', { x: current?.who ?? '—' })
    return (
      <div className="flex flex-col gap-3 px-4 py-3.5 text-[13.5px] leading-[22px]">
        <span className="text-xs text-muted-foreground">
          {t('aiOps.feedback.meta', { who, at: '\u0000', reason: s.reasons.map(reasonLabel).join(', ') || '—' }).split('\u0000').flatMap((part, i) => (i ? [<span key={i} className="font-mono">{shortStamp(s.at)}</span>, part] : [part]))}
        </span>
        {s.messages.map((m, i) => (m.role === 'user'
          ? <div key={i} className="max-w-[300px] self-end whitespace-pre-wrap break-words rounded-[10px] bg-accent px-3 py-2">{m.content}</div>
          : <div key={i} className={`whitespace-pre-wrap break-words border-l-2 pl-3 ${i === lastAssistant ? 'border-danger/60' : 'border-border'}`}>{m.content}</div>))}
        {s.comment && <span className="text-[12.5px] text-muted-foreground">{t('aiOps.feedback.note', { note: s.comment })}</span>}
      </div>
    )
  }
  const footerParts = panel?.kind === 'ready' ? (
    <>
      <span className="flex-grow text-xs text-muted-foreground">
        <UiTrans k="aiOps.feedback.ttl" slots={{ n: <span className="font-mono">{st.ttl}</span> }} />
      </span>
      <UiButton variant="danger" size="sm" icon="trash" onClick={() => setConfirmDel(true)}>{t('aiOps.feedback.deleteSnapshot')}</UiButton>
    </>
  ) : null
  const panelFooter = footerParts ? <div className="mt-auto flex items-center gap-2 border-t border-border px-4 py-3">{footerParts}</div> : null

  const stats = <StatsCard days={days} usage={usage} attached={st.attached} onRetry={onRetryUsage} />

  return (
    <div className="flex flex-col gap-5">
      {stats}
      <div className="flex flex-wrap items-start gap-5">
        <OpsCard aria-label={t('aiOps.feedback.listAria')} className="min-w-0 flex-[999_1_560px] overflow-hidden" aria-busy={st.loading || undefined}>
          <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
            <h2 className="m-0 flex-grow text-[15px] font-semibold">
              {t('aiOps.feedback.listTitle')} <span className="font-mono font-normal text-muted-foreground">{fmtNum(st.total)}</span>
            </h2>
            <UiMenu
              label={t('aiOps.feedback.reasonMenu')} items={reasonItems} width={220}
              onSelect={k => setReason(k === 'all' ? '' : k)}
              trigger={({ toggle }) => <UiChip label={reasonText} icon="filter" variant="toggle" modelValue={!!reason} onClick={toggle} />}
            />
            <UiChip label={t('aiOps.feedback.attachedOnly')} variant="toggle" modelValue={attachedOnly} onUpdateModelValue={setAttachedOnly} />
          </div>
          {listBody}
          {st.hasMore && st.items.length > 0 && (
            <div className="flex justify-center border-t border-border p-3">
              <UiButton variant="outline" size="sm" disabled={st.loading} onClick={() => void load(true)}>{t('aiOps.more')}</UiButton>
            </div>
          )}
        </OpsCard>

        {panel && !isMobile && (
          <aside aria-label={t('aiOps.feedback.panelTitle')} className="flex max-w-[460px] flex-[1_1_380px] flex-col overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
              <h2 className="m-0 flex-grow text-[15px] font-semibold">{t('aiOps.feedback.panelTitle')}</h2>
              <UiBadge tone="neutral" tint size={18}>{t('aiOps.feedback.readOnly')}</UiBadge>
              <UiIconButton label={t('aiOps.feedback.close')} icon="close" size="sm" variant="ghost" onClick={() => setPanel(null)} />
            </div>
            {privacyNote}
            {panelBody(panel)}
            {panelFooter}
          </aside>
        )}
      </div>

      {panel && isMobile && (
        <UiModal mobile="full" title={t('aiOps.feedback.panelTitle')} onClose={() => setPanel(null)} footer={footerParts ?? undefined}>
          <div className="-mx-5 -mt-5 flex flex-col">
            <div className="sticky top-0 z-[1] bg-card pb-1">{privacyNote}</div>
            {panelBody(panel)}
          </div>
        </UiModal>
      )}

      {confirmDel && (
        <UiModal confirm danger title={t('aiOps.feedback.confirmTitle')} onClose={() => !deleting && setConfirmDel(false)}
          footer={<>
            <UiButton variant="ghost" size="sm" disabled={deleting} onClick={() => setConfirmDel(false)}>{t('aiOps.feedback.cancel')}</UiButton>
            <UiButton variant="danger" size="sm" disabled={deleting} onClick={() => void doDelete()}>{t('aiOps.feedback.confirm')}</UiButton>
          </>}
        >
          <p className="m-0 text-[13px] leading-5 text-muted-foreground">{t('aiOps.feedback.confirmBody')}</p>
        </UiModal>
      )}
    </div>
  )
}

/** 통계 카드("피드백 · 최근 30일 · 대화 내용 없음") — 좋아요·별로예요·대화 첨부 + 별로예요 이유 막대 */
function StatsCard({ days, usage, attached, onRetry }: { days: number; usage: UsageState; attached: number; onRetry: () => void }) {
  const { t } = useI18n()
  const { reasonLabel } = useOpsLabels()
  const fb = usage.data?.feedback
  const reasons = Object.entries(fb?.reasons ?? {}).sort((a, b) => b[1] - a[1])
  const top = reasons.length ? reasons[0][1] : 0
  return (
    <OpsCard aria-label={t('aiOps.stats.title')} className="flex max-w-[720px] flex-col gap-3.5 px-[18px] py-4">
      <h2 className="m-0 text-[15px] font-semibold">
        {t('aiOps.stats.title')} <span className="text-[12.5px] font-normal text-muted-foreground">{t('aiOps.stats.note', { n: days })}</span>
      </h2>
      {usage.error ? <OpsLoadFailed error={usage.error} title={t('aiOps.usage.loadFailed')} onRetry={onRetry} />
        : !fb ? <UiSkeleton preset="text" rows={3} delay={false} />
          : (
            <>
              <div className="flex gap-6">
                {[[t('aiOps.stats.up'), fb.up], [t('aiOps.stats.down'), fb.down], [t('aiOps.stats.attached'), attached]].map(([l, n]) => (
                  <div key={String(l)} className="flex flex-col gap-0.5">
                    <span className="text-[12.5px] text-muted-foreground">{l}</span>
                    <span className="font-mono text-2xl">{fmtNum(Number(n))}</span>
                  </div>
                ))}
              </div>
              {reasons.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold text-muted-foreground">{t('aiOps.stats.reasonsTitle')}</span>
                  {reasons.map(([r, n]) => (
                    <div key={r} className="grid grid-cols-[120px_minmax(0,1fr)_48px] items-center gap-2.5 text-[13px]">
                      <span>{reasonLabel(r)}</span>
                      <div role="img" aria-label={t('aiOps.stats.reasonAria', { label: reasonLabel(r), n })} className="h-2.5 rounded-r bg-border/50">
                        <div className="h-2.5 rounded-r bg-primary/75" style={{ width: `${top ? Math.round((n / top) * 100) : 0}%` }} />
                      </div>
                      <span className="text-right font-mono">{fmtNum(n)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
    </OpsCard>
  )
}
