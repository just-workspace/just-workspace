// 승인 대기함 — 목록 + 상세, 대기/처리 기록 탭, 거부 사유, 외부 내용 경고 · 빈·오류·로딩·만료·모바일 390 목록→상세.
//  - 대기 = AI 가 요청한 위험 작업(high) 또는 외부 AI 커넥터(MCP)에서 수신한 쓰기 요청. 승인 전에는 아무것도 실행되지 않는다.
//  - ?id= 는 해당 요청을 선택한다(벨 알림·토스트·채팅 카드 링크). 대기 목록에 없으면(이미 처리·만료) 별도로 조회해 상세에 표시한다.
//  - 남은 시간은 서버 시각 기준(목록·상세 응답의 server_now 로 offset).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { errorStatus } from '~/lib/api'
import { useHead } from '~/lib/head'
import { queryString, useRoute } from '~/lib/router'
import { useAuth } from '~/composables/useAuth'
import { useIsMobile } from '~/composables/useIsMobile'
import { useNowTick } from '~/composables/useNowTick'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import {
  APPROVAL_UPDATED_EVENT, announceApprovalUpdate, approvalsApi, refreshApprovalsCount, setApprovalsCount, useApprovalsSeq,
} from '~/composables/useApprovals'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiIcon } from '~/components/ui/Icon'
import { UiModal } from '~/components/ui/Modal'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTabs } from '~/components/ui/Tabs'
import { ApprovalDetail, statusLabel } from '~/components/approvals/ApprovalDetail'
import { clientIcon, clockTime, effectiveStatus, formatCountdown, remainingMs, serverOffset, shortDateTime, statusTone, type ApprovalRequest } from '~/utils/approvals'
import { clientLabel, sourceLabel } from '~/components/approvals/ApprovalParts'

type Tab = 'pending' | 'history'

interface ListState {
  items: ApprovalRequest[]
  loading: boolean
  loaded: boolean
  error: { status?: number; at: string } | null
  hasMore: boolean
  cursor: string | null
}
const EMPTY_LIST: ListState = { items: [], loading: false, loaded: false, error: null, hasMore: false, cursor: null }

function errMsg(e: any) { return e?.data?.detail || e?.message || String(e) }

export default function ApprovalsPage() {
  const { t, locale } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('approvals.title')} | ${appName}` })
  const { user } = useAuth()
  const userName = user?.display_name || user?.username || t('ai.you')
  const isMobile = useIsMobile()
  const route = useRoute()
  const navigate = useNavigate()
  const queryId = queryString(route.query.id) || null

  const [tab, setTab] = useState<Tab>('pending')
  const [pending, setPending] = useState<ListState>(EMPTY_LIST)
  const [history, setHistory] = useState<ListState>(EMPTY_LIST)
  const [offset, setOffset] = useState(0)
  const [extra, setExtra] = useState<ApprovalRequest | null>(null) // ?id= 가 목록에 없을 때 별도로 조회한 요청
  const [extraError, setExtraError] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const listRef = useRef({ pending, history })
  listRef.current = { pending, history }

  async function loadList(view: Tab, more = false, quiet = false) {
    const set = view === 'pending' ? setPending : setHistory
    const cur = view === 'pending' ? listRef.current.pending : listRef.current.history
    if (!quiet) set(s => ({ ...s, loading: true, error: more ? s.error : null }))
    try {
      const r = await approvalsApi.list(view, more ? cur.cursor : null)
      if (r.server_now) setOffset(serverOffset(r.server_now))
      if (view === 'pending' && typeof r.pending === 'number') setApprovalsCount(r.pending)
      set(s => ({
        ...s,
        items: more
          ? [...s.items, ...r.items.filter(n => !s.items.some(o => o.id === n.id))]
          // 백그라운드 갱신: 방금 이 화면에서 처리한 항목은 배지와 함께 유지한다(처리 후에도 목록에 상태 배지 표시)
          : quiet && view === 'pending'
            ? [...r.items, ...s.items.filter(o => o.status !== 'pending' && !r.items.some(n => n.id === o.id))]
            : r.items,
        loading: false, loaded: true, error: null, hasMore: !!r.has_more, cursor: r.next_cursor,
      }))
    } catch (e) {
      if (quiet) return
      set(s => ({ ...s, loading: false, loaded: true, error: { status: errorStatus(e), at: new Date().toISOString() } }))
    }
  }

  useEffect(() => { void loadList('pending') }, [])
  useEffect(() => { if (tab === 'history' && !history.loaded && !history.loading) void loadList('history') }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  // 대기 건수가 변경되면(새 요청·다른 곳에서 처리) 대기 목록을 백그라운드로 재조회한다
  const seq = useApprovalsSeq()
  const seqSeen = useRef(seq)
  useEffect(() => {
    if (seq === seqSeen.current) return
    seqSeen.current = seq
    if (listRef.current.pending.loaded) void loadList('pending', false, true)
  }, [seq])

  /** 요청 1건 반영(목록·별도 조회분 모두) */
  function patchReq(next: ApprovalRequest) {
    const upd = (s: ListState) => (s.items.some(i => i.id === next.id) ? { ...s, items: s.items.map(i => (i.id === next.id ? next : i)) } : s)
    setPending(upd)
    setHistory(s => {
      const u = upd(s)
      // 대기에서 처리된 항목은 처리 기록 맨 위에 추가(이미 수신해 둔 경우)
      return u === s && s.loaded && next.status !== 'pending' ? { ...s, items: [next, ...s.items] } : u
    })
    setExtra(x => (x && x.id === next.id ? next : x))
    if (next.server_now) setOffset(serverOffset(next.server_now))
  }

  useEffect(() => {
    function onUpd(e: Event) { const d = (e as CustomEvent<ApprovalRequest>).detail; if (d?.id) patchReq(d) }
    window.addEventListener(APPROVAL_UPDATED_EVENT, onUpd)
    return () => window.removeEventListener(APPROVAL_UPDATED_EVENT, onUpd)
  }, [])

  // 선택된 요청: ?id= → 없으면(데스크톱) 첫 대기 요청
  const inLists = (id: string | null) => (id ? pending.items.find(i => i.id === id) || history.items.find(i => i.id === id) || null : null)
  // 주소에 선택 항목이 없을 때(데스크톱)의 선택은 한 번 정해지면 유지한다. 기존에는 항상 "목록 첫 줄"이어서
  // 읽는 중에 새 요청이 도착하거나(맨 위에 추가된다) 직전 요청을 처리하면 상세가 다른 요청으로 전환됐고,
  // [승인]이 동일 위치에 있어 읽지 않은 요청을 승인할 수 있었다. 선택 항목이 목록에서 제외된 경우에만 첫 줄로 재설정한다.
  const [autoId, setAutoId] = useState<string | null>(null)
  useEffect(() => {
    if (autoId && pending.items.some(i => i.id === autoId)) return
    const first = pending.items[0]?.id ?? null
    if (first !== autoId) setAutoId(first)
  }, [pending.items, autoId])
  const selectedId = queryId || (!isMobile && tab === 'pending' ? autoId : null)
  const selected = inLists(selectedId) || (extra && extra.id === selectedId ? extra : null)

  // ?id= 가 목록에 없으면 별도로 조회한다(이미 처리됐거나 만료된 요청)
  useEffect(() => {
    setExtraError(false)
    if (!queryId || !pending.loaded || inLists(queryId) || (extra && extra.id === queryId)) return
    let alive = true
    approvalsApi.get(queryId)
      .then(r => { if (alive) { setExtra(r); if (r.server_now) setOffset(serverOffset(r.server_now)) } })
      .catch(() => { if (alive) setExtraError(true) })
    return () => { alive = false }
  }, [queryId, pending.loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // 다른 요청을 선택하면 거부 사유를 초기화한다
  useEffect(() => { setReason('') }, [selectedId])

  function select(id: string | null) {
    const to = id ? `/approvals?id=${encodeURIComponent(id)}` : '/approvals'
    // 모바일은 목록 → 상세가 한 단계(뒤로 가기로 목록 복귀), 데스크톱은 동일 화면 내 선택이므로 기록을 추가하지 않는다
    void navigate(to, { replace: !isMobile || !id })
  }

  async function act(kind: 'approve' | 'reject' | 'undo') {
    const req = selected
    if (!req || busy) return
    setBusy(kind)
    try {
      const next = kind === 'approve' ? await approvalsApi.approve(req.id)
        : kind === 'reject' ? await approvalsApi.reject(req.id, reason)
          : await approvalsApi.undo(req.id)
      patchReq(next)
      setExtra(next) // 목록 갱신으로 제외돼도 상세는 유지된다
      announceApprovalUpdate(next)
      setReason('')
      if (kind === 'approve') addToast(next.status === 'executed' ? 'success' : 'error', next.status === 'executed' ? t('approvals.toast.approved') : t('approvals.toast.failed', { msg: next.error || '' }))
      else if (kind === 'reject') addToast('info', t('approvals.toast.rejected'))
      else addToast('success', t('approvals.toast.undone'))
      void refreshApprovalsCount()
    } catch (e: any) {
      addToast('error', t('approvals.errors.action', { msg: errMsg(e) }))
      approvalsApi.get(req.id).then(patchReq).catch(() => {})
    } finally {
      setBusy(null)
    }
  }

  const pendingCount = pending.items.filter(i => i.status === 'pending').length
  useNowTick(pending.items.some(i => i.status === 'pending'))
  const now = Date.now()

  // ── 조각 ──
  const errorTile = (s: ListState, view: Tab) => (
    <UiErrorTile
      placement="panel"
      title={t(view === 'pending' ? 'approvals.errors.loadPending' : 'approvals.errors.loadHistory')}
      detail={t('approvals.errors.loadDetail', { status: s.error?.status ?? '—', time: clockTime(s.error?.at, false, locale) })}
      retryLabel={t('common.retry')}
      onRetry={() => { void loadList(view) }}
    />
  )
  const panel = (child: ReactNode) => (
    <div className="flex min-h-[280px] items-center justify-center rounded-xl border border-border bg-card p-6">{child}</div>
  )

  const pendingList = (
    <ul aria-label={t('approvals.list.label')} className={cn('m-0 list-none p-0', !isMobile && 'overflow-hidden rounded-xl border border-border bg-card')}>
      {pending.items.map(it => {
        const st = effectiveStatus(it, offset, now)
        const left = remainingMs(it.expires_at, offset, now)
        const soon = st === 'pending' && left !== null && left < 10 * 60_000
        const sel = !isMobile && it.id === selectedId
        return (
          <li key={it.id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              aria-pressed={isMobile ? undefined : sel}
              onClick={() => select(it.id)}
              className={cn(
                'flex w-full flex-col gap-1.5 px-4 py-3.5 text-left text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                sel ? 'bg-accent shadow-[inset_3px_0_0_hsl(var(--primary))]' : 'hover:bg-accent/40',
              )}
            >
              <span className="flex w-full items-center gap-2">
                <span className={cn('min-w-0 truncate font-semibold', isMobile ? 'text-[14.5px]' : 'text-sm')}>{it.title}</span>
                {!isMobile && <span className="truncate font-mono text-[11.5px] text-muted-foreground">{it.tool}</span>}
                <span className="flex-1" />
                {isMobile
                  ? (st === 'pending'
                      ? <span className={cn('shrink-0 font-mono text-xs', soon ? 'text-warning' : 'text-muted-foreground')}>{formatCountdown(left)}</span>
                      : <UiBadge tone={statusTone(st)} size={18}>{statusLabel(t, it, st)}</UiBadge>)
                  : <UiBadge tone={statusTone(st)} tint={st === 'pending'} size={18} className="shrink-0">{statusLabel(t, it, st)}</UiBadge>}
              </span>
              <span className="text-[13px] leading-[19px] text-muted-foreground">{it.target_summary || it.title}</span>
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <UiIcon name={clientIcon(it.client_kind)} className="h-3.5 w-3.5" />{sourceLabel(t, it)} · {clientLabel(t, it)}
                </span>
                {!isMobile && <span className="font-mono">{clockTime(it.created_at, false, locale)}</span>}
                {!isMobile && st === 'pending' && <span className={cn('font-mono', soon && 'text-warning')}>{t('approvals.list.left', { time: formatCountdown(left) })}</span>}
                {(it.after_untrusted || it.read_external) && (
                  <span className="inline-flex items-center gap-1 text-warning"><UiIcon name="alert-triangle" className="h-3.5 w-3.5" />{t('approvals.list.afterExternal')}</span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )

  const historyTable = (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[820px] border-collapse text-[13.5px]">
        <thead>
          <tr className="text-left text-[12.5px] text-muted-foreground">
            {['handledAt', 'request', 'source', 'result', 'handledBy'].map(k => (
              <th key={k} scope="col" className="border-b border-border px-4 py-3 font-semibold">{t(`approvals.history.${k}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {history.items.map(h => (
            <tr key={h.id} className="h-12 hover:bg-accent/30">
              <td className="border-b border-border px-4 font-mono text-[12.5px] text-muted-foreground">{shortDateTime(h.decided_at || h.executed_at || h.created_at)}</td>
              <td className="border-b border-border px-4">
                <button type="button" className="text-left hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" onClick={() => select(h.id)}>
                  {h.title} <span className="font-mono text-xs text-muted-foreground">{h.tool}</span>
                </button>
              </td>
              <td className="border-b border-border px-4 text-muted-foreground">{sourceLabel(t, h)} · {clientLabel(t, h)}</td>
              <td className="border-b border-border px-4"><UiBadge tone={statusTone(h.status)} tint size={18}>{statusLabel(t, h)}</UiBadge></td>
              <td className="border-b border-border px-4">{h.status === 'expired' ? '—' : userName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  const moreBtn = (s: ListState, view: Tab) => s.hasMore && (
    <div className="flex justify-center pt-3">
      <UiButton variant="outline" size="sm" disabled={s.loading} onClick={() => { void loadList(view, true) }}>{t('approvals.list.more')}</UiButton>
    </div>
  )

  const detailFor = (req: ApprovalRequest, mobile = false) => (
    <ApprovalDetail
      req={req}
      offset={offset}
      userName={userName}
      reason={reason}
      onReason={setReason}
      busy={busy}
      mobile={mobile}
      onApprove={() => { void act('approve') }}
      onReject={() => { void act('reject') }}
      onUndo={() => { void act('undo') }}
      className={mobile ? 'min-h-full' : 'flex-[999_1_520px]'}
    />
  )

  const tabs = (
    <UiTabs
      ariaLabel={t('approvals.title')}
      modelValue={tab}
      onUpdateModelValue={v => setTab((v as Tab) || 'pending')}
      items={[{ key: 'pending', label: t('approvals.tabs.pending'), count: pending.loaded ? pendingCount : undefined }, { key: 'history', label: t('approvals.tabs.history') }]}
      flush
    />
  )

  // ── 모바일 상세 ──
  if (isMobile && queryId) {
    return (
      <div className="flex h-full flex-col bg-background">
        <LayoutMobileDetailBar title={selected?.title || t('approvals.title')} backLabel={t('approvals.back')} navigate={false} onBack={() => select(null)} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? detailFor(selected, true)
            : extraError ? <div className="p-4">{panel(<UiErrorTile placement="panel" title={t('approvals.errors.notFound')} noRetry />)}</div>
              : <div className="p-4"><UiSkeleton preset="text" rows={4} delay={false} /></div>}
        </div>
      </div>
    )
  }

  const list = tab === 'pending' ? pending : history
  const showLoading = list.loading && !list.loaded
  const historyModalReq = !isMobile && tab === 'history' && queryId ? selected : null

  return (
    <div className="h-full overflow-y-auto">
      <div className={cn('flex flex-col', isMobile ? '' : 'px-8 pb-8 pt-6')}>
        {!isMobile && (
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[22px] font-bold leading-[30px]">{t('approvals.title')}</h1>
            <p className="m-0 text-[13.5px] text-muted-foreground">{t('approvals.subtitle')}</p>
          </div>
        )}
        <div className={isMobile ? 'px-4' : 'pt-3'}>{tabs}</div>

        <div className={cn(isMobile ? '' : 'pt-5')}>
          {showLoading ? (
            <div className={cn(isMobile ? 'p-4' : 'rounded-xl border border-border bg-card p-4')} aria-busy="true">
              <UiSkeleton preset="list" rows={4} delay={false} />
            </div>
          ) : list.error && !list.items.length ? (
            <div className={isMobile ? 'p-4' : ''}>{panel(errorTile(list, tab))}</div>
          ) : tab === 'pending' ? (
            !pending.items.length ? (
              <div className={cn(isMobile ? 'p-4' : 'flex flex-wrap items-start gap-5')}>
                <div className={cn(!isMobile && 'flex-[1_1_380px]', !isMobile && selected && 'max-w-[460px]')}>
                  {panel(
                    <UiEmptyState
                      variant="panel"
                      icon="shield"
                      title={t('approvals.empty.title')}
                      description={t('approvals.empty.desc')}
                      actionLabel={t('approvals.empty.action')}
                      onAction={() => setTab('history')}
                    />,
                  )}
                </div>
                {!isMobile && selected && detailFor(selected)}
              </div>
            ) : (
              <div className={cn(!isMobile && 'flex flex-wrap items-start gap-5')}>
                <div className={cn(!isMobile && 'max-w-[460px] flex-[1_1_380px]')}>
                  {pendingList}
                  {moreBtn(pending, 'pending')}
                </div>
                {!isMobile && (selected
                  ? detailFor(selected)
                  : queryId && extraError
                    ? <div className="flex-[999_1_520px]">{panel(<UiErrorTile placement="panel" title={t('approvals.errors.notFound')} noRetry />)}</div>
                    : null)}
              </div>
            )
          ) : (
            !history.items.length ? (
              <div className={isMobile ? 'p-4' : ''}>
                {panel(<UiEmptyState variant="panel" icon="clock" title={t('approvals.empty.historyTitle')} description={t('approvals.empty.historyDesc')} />)}
              </div>
            ) : (
              <div className={isMobile ? 'p-4' : ''}>
                {historyTable}
                {moreBtn(history, 'history')}
              </div>
            )
          )}
        </div>
      </div>

      {historyModalReq && (
        <UiModal size="680" ariaLabel={historyModalReq.title} title={historyModalReq.title} flush onClose={() => select(null)}>
          {detailFor(historyModalReq)}
        </UiModal>
      )}
    </div>
  )
}
