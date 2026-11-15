/**
 * 채팅 안 쓰기 승인 카드 — 시안 A1(기본 low·high) · A2(상태 9종).
 *
 * 내장 AI 스트림의 `write_request` 이벤트가 실어 온 요청 객체(app/mcp/writes.py to_dict)를 그린다.
 *   low  pending : [실행]=approve · [수정]=칸 인라인 편집 → PATCH(A2-2, 다시 계산 중 A2-1) · [취소]=cancel. 남은 시간(5분).
 *   high pending : "승인 대기함으로 보냄" + 대기함 링크(/approvals?id=). 대기함에서 처리되면 건수 이벤트로 다시 읽어 A2-7·A2-8.
 *   executed     : 결과 + [되돌리기] 남은 시간(undo_until 까지, 10분) · undone
 *   canceled · expired · failed · rejected
 * 모든 남은 시간은 서버 시각 기준(offset = server_now − 받은 순간의 클라이언트 시각).
 * 칸으로 못 고치는 값은 "대화로 고치기" — onCompose 로 입력 칸에 문장을 넣는다.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { NuxtLink } from '~/components/NuxtLink'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiKeycap } from '~/components/ui/Keycap'
import { UiSelect } from '~/components/ui/Select'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTextarea } from '~/components/ui/Textarea'
import { useIsMobile } from '~/composables/useIsMobile'
import { useNowTick } from '~/composables/useNowTick'
import { addToast } from '~/composables/useToast'
import { APPROVAL_UPDATED_EVENT, announceApprovalUpdate, approvalsApi, useApprovalsSeq } from '~/composables/useApprovals'
import { ApprovalExternalWarning, ApprovalPreviewRows } from '~/components/approvals/ApprovalParts'
import {
  approvalIcon, canUndoNow, clockTime, effectiveStatus, formatCountdown, remainingMs, resultLink, serverOffset,
  type ApprovalEditable, type ApprovalRequest,
} from '~/utils/approvals'

export interface ApprovalCardProps {
  /** 요청 객체(서버가 준 그대로) */
  request: ApprovalRequest
  /** "○○ 님이 실행" 의 이름 */
  userName?: string
  /** 대화로 고치기·다시 제안 — 입력 칸에 넣을 문장 */
  onCompose?: (text: string) => void
  /** 요청이 바뀜(서버 응답) — 부모가 메시지에 저장할 때 */
  onChange?: (req: ApprovalRequest) => void
  /** 실행된 뒤 카드 안에 보일 결과(예: files_zip 묶음 카드) — 결과 카드를 따로 띄우지 않고 한 카드로 */
  result?: ReactNode
}

type Mode = 'view' | 'edit' | 'computing'

function errMsg(e: any): string { return e?.data?.detail || e?.message || String(e) }
function errStatus(e: any): number | undefined { return e?.statusCode ?? e?.status ?? e?.response?.status }

/** 편집 칸 값(문자열) ← 인자 값 */
function toField(f: ApprovalEditable, v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(String).join(', ')
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch { return '' } }
  return String(v)
}

/** 인자 값 ← 편집 칸 값 */
function fromField(f: ApprovalEditable, s: string, prev: unknown): unknown {
  if (f.type === 'integer' || f.type === 'number') {
    if (s.trim() === '') return null
    const n = Number(s)
    return Number.isFinite(n) ? (f.type === 'integer' ? Math.trunc(n) : n) : prev
  }
  if (f.type === 'boolean') return s === 'true'
  if (f.type === 'array') return s.split(',').map(x => x.trim()).filter(Boolean)
  return s
}

/** 칸으로 고칠 수 있는 형식인가(그 밖은 대화로 고치기) */
function inlineEditable(f: ApprovalEditable): boolean {
  return ['string', 'integer', 'number', 'boolean', 'array'].includes(f.type) || !!f.enum?.length
}

export function ApprovalCard({ request, userName, onCompose, onChange, result }: ApprovalCardProps) {
  const { t, locale } = useI18n()
  const isMobile = useIsMobile()
  const [req, setReqState] = useState<ApprovalRequest>(request)
  const [offset, setOffset] = useState(() => serverOffset(request.server_now))
  const [mode, setMode] = useState<Mode>('view')
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const reqRef = useRef(req)
  reqRef.current = req

  /** 서버가 준 새 요청 반영 — offset 도 그 응답의 server_now 로 다시 잰다 */
  function apply(next: ApprovalRequest, announce = true) {
    setReqState(next)
    if (next.server_now) setOffset(serverOffset(next.server_now))
    onChange?.(next)
    if (announce) announceApprovalUpdate(next)
  }

  // 부모가 다른 요청 객체를 주면(같은 id 의 새 이벤트) 따른다
  useEffect(() => {
    if (request !== reqRef.current) { setReqState(request); if (request.server_now) setOffset(serverOffset(request.server_now)) }
  }, [request])

  // 다른 곳(대기함·다른 카드)에서 같은 요청이 바뀌면 따른다
  useEffect(() => {
    function onUpd(e: Event) {
      const d = (e as CustomEvent<ApprovalRequest>).detail
      if (d && d.id === reqRef.current.id && d !== reqRef.current) apply(d, false)
    }
    window.addEventListener(APPROVAL_UPDATED_EVENT, onUpd)
    return () => window.removeEventListener(APPROVAL_UPDATED_EVENT, onUpd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // high 대기: 대기 건수 이벤트가 오면 대기함에서 처리됐는지 다시 본다(A2-7·A2-8)
  const seq = useApprovalsSeq()
  const seqSeen = useRef(seq)
  useEffect(() => {
    if (seq === seqSeen.current) return
    seqSeen.current = seq
    const r = reqRef.current
    if (r.status !== 'pending' || (r.risk !== 'high' && r.source !== 'mcp')) return
    approvalsApi.get(r.id).then(n => apply(n, false)).catch(() => { /* 다음 이벤트 때 */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq])

  const status0 = req.status
  const ticking = status0 === 'pending' || (status0 === 'executed' && !!req.can_undo)
  useNowTick(ticking) // 1초마다 다시 그린다 — 시각은 그릴 때의 Date.now() + offset
  const now = Date.now()
  const status = effectiveStatus(req, offset, now)
  const isHigh = req.risk === 'high'
  const left = remainingMs(req.expires_at, offset, now)
  const undoLeft = remainingMs(req.undo_until, offset, now)
  const undoable = canUndoNow(req, offset, now)
  const icon = approvalIcon(req.tool)
  const time = (iso?: string | null, sec = false) => clockTime(iso, sec, locale)
  const who = userName || t('ai.you')

  async function run(kind: string, fn: () => Promise<ApprovalRequest>) {
    if (busy) return
    setBusy(kind)
    try {
      apply(await fn())
      return true
    } catch (e: any) {
      addToast('error', t('approvals.errors.action', { msg: errMsg(e) }))
      // 이미 처리됨(409) 등 — 서버 상태로 맞춘다
      if (errStatus(e) === 409 || errStatus(e) === 404) approvalsApi.get(req.id).then(n => apply(n, false)).catch(() => {})
      return false
    } finally {
      setBusy(null)
    }
  }

  const approve = (remember?: 'conversation' | 'always') => run('approve', () => approvalsApi.approve(req.id, remember))
  // Claude Code "아니요, 대신 이렇게" — 사유를 모델에게 넘긴다(거절 + 지시)
  const [insteadOpen, setInsteadOpen] = useState(false)
  const [instead, setInstead] = useState('')
  const sendInstead = async () => {
    const text = instead.trim()
    if (!text) return
    if (await run('reject', () => approvalsApi.reject(req.id, text))) { setInsteadOpen(false); setInstead('') }
  }
  const cancel = () => run('cancel', () => approvalsApi.cancel(req.id))
  const undo = () => run('undo', () => approvalsApi.undo(req.id))

  const editable = (req.editable || []).filter(inlineEditable)
  function startEdit() {
    if (!editable.length) { composeFix(); return }
    const d: Record<string, string> = {}
    for (const f of editable) d[f.field] = toField(f, req.args?.[f.field])
    setDraft(d)
    setMode('edit')
  }
  function composeFix() {
    onCompose?.(t('approvals.card.fixPrompt', { title: req.title, target: req.target_summary || req.title }))
  }
  async function saveAndRun() {
    const args: Record<string, unknown> = { ...(req.args || {}) }
    for (const f of editable) args[f.field] = fromField(f, draft[f.field] ?? '', args[f.field])
    setMode('computing')
    setBusy('edit')
    try {
      const edited = await approvalsApi.edit(req.id, args)
      apply(edited)
      setBusy(null)
      setMode('view')
      await run('approve', () => approvalsApi.approve(req.id))
    } catch (e: any) {
      setBusy(null)
      setMode('edit')
      addToast('error', t('approvals.errors.edit', { msg: errMsg(e) }))
    }
  }

  // ── 그리기 ──
  const mono = 'font-mono text-xs text-muted-foreground'
  const header = (opts: { icon: string; iconCls: string; right?: ReactNode; badge?: ReactNode; border?: boolean; muted?: boolean }) => (
    <header className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-3', opts.border !== false && 'border-b border-border', isMobile && 'px-3.5')}>
      <UiIcon name={opts.icon} className={cn('h-4 w-4', opts.iconCls)} />
      <span className={cn('text-sm font-semibold', opts.muted && 'text-muted-foreground')}>{req.title}</span>
      {!isMobile && <span className={mono}>{req.tool}</span>}
      {opts.badge}
      <span className="flex-1" />
      {opts.right}
    </header>
  )
  const riskBadge = (label: string) => <UiBadge tone={isHigh ? 'danger' : 'success'} tint size={18}>{label}</UiBadge>
  const footCls = 'flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-[12.5px] text-muted-foreground'
  const summary = req.target_summary ? (
    <div className={cn('pb-3 pr-4 text-[13px] leading-5 text-muted-foreground', isMobile ? 'pl-3.5' : 'pl-[42px]')}>
      {isMobile && <span className={cn(mono, 'mr-1.5')}>{req.tool}</span>}{req.target_summary}
    </div>
  ) : null
  const body = (
    <div className={cn('flex flex-col gap-3 py-3.5', isMobile ? 'px-3.5' : 'px-4')}>
      {isMobile && <span className="font-mono text-[11.5px] text-muted-foreground">{req.tool}</span>}
      <ApprovalPreviewRows rows={req.preview || []} target={req.target_summary} />
      {(req.after_untrusted || req.read_external) && <ApprovalExternalWarning req={req} compact />}
    </div>
  )
  const link = resultLink(req.result)
  const label = t('approvals.card.label', { title: req.title })

  // A2-1 미리보기 다시 계산 중
  if (mode === 'computing') {
    return (
      <section aria-label={t('approvals.card.computingLabel', { title: req.title })} aria-busy="true" className="overflow-hidden rounded-xl border border-border bg-card">
        {header({ icon: 'loader', iconCls: 'animate-spin text-muted-foreground' })}
        <div className="px-4 py-3.5"><UiSkeleton preset="text" rows={3} delay={false} /></div>
        <footer className={footCls}>{t('approvals.card.computing')}</footer>
      </section>
    )
  }

  // A2-2 [수정] 누른 뒤 — 인라인 편집
  if (status === 'pending' && mode === 'edit') {
    return (
      <section aria-label={t('approvals.card.editLabel', { title: req.title })} className="overflow-hidden rounded-xl border border-primary/50 bg-card">
        {header({ icon, iconCls: 'text-primary', badge: riskBadge(isHigh ? 'high' : 'low') })}
        <div className="flex flex-col gap-3 px-4 py-3.5">
          {editable.map(f => {
            const v = draft[f.field] ?? ''
            const set = (nv: string) => setDraft(d => ({ ...d, [f.field]: nv }))
            if (f.enum?.length) {
              return <UiSelect key={f.field} label={f.label} modelValue={v} onUpdateModelValue={x => set(String(x ?? ''))} options={f.enum.map(o => ({ value: String(o), label: String(o) }))} />
            }
            if (f.type === 'boolean') {
              return <UiSelect key={f.field} label={f.label} modelValue={v || 'false'} onUpdateModelValue={x => set(String(x ?? 'false'))} options={[{ value: 'true', label: t('approvals.card.yes') }, { value: 'false', label: t('approvals.card.no') }]} />
            }
            if (f.multiline) return <UiTextarea key={f.field} label={f.label} modelValue={v} onUpdateModelValue={set} rows={4} />
            const num = f.type === 'integer' || f.type === 'number'
            return <UiInput key={f.field} label={f.label} modelValue={v} onUpdateModelValue={set} type={num ? 'number' : 'text'} mono={num} hint={f.type === 'array' ? t('approvals.card.arrayHint') : undefined} />
          })}
          {onCompose && (
            <button type="button" className="self-start text-[12.5px] font-medium text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" onClick={composeFix}>
              {t('approvals.card.fixInChat')}
            </button>
          )}
        </div>
        <footer className={footCls}>
          <span className="flex-1 basis-60">{t('approvals.card.editHint')}</span>
          <UiButton variant="ghost" size="sm" onClick={() => setMode('view')}>{t('approvals.card.back')}</UiButton>
          <UiButton size="sm" icon="check" disabled={!!busy} onClick={() => { void saveAndRun() }}>{t('approvals.card.saveAndRun')}</UiButton>
        </footer>
      </section>
    )
  }

  // 대기(내장 AI, low·high) — Claude Code 권한 선택지: 1 예 / 2 이 대화에서 다시 묻지 않기 / 3 항상 허용 / 4 아니요, 대신…
  // 숫자 키 1~4, Esc = 취소(카드 안에 초점이 있을 때)
  if (status === 'pending' && req.source === 'ai') {
    const allOpts: { key: string; label: string; hint?: string; onPick: () => void; tone?: 'primary' | 'danger' }[] = [
      { key: '1', label: t('approvals.choice.yes'), onPick: () => { void approve() }, tone: 'primary' },
      { key: '2', label: t('approvals.choice.yesConversation', { title: req.title }), onPick: () => { void approve('conversation') } },
      { key: '3', label: t('approvals.choice.yesAlways', { title: req.title }), hint: isHigh ? t('approvals.choice.alwaysHighHint') : undefined, onPick: () => { void approve('always') } },
      { key: '4', label: t('approvals.choice.instead'), onPick: () => setInsteadOpen(true), tone: 'danger' },
      // 외부 내용을 읽은 뒤의 '남에게 보이는 쓰기' 관문 카드 — 허용 규칙을 남겨도 이 대화에서는 계속 묻으므로
      // "다시 묻지 않기" 두 선택지(2·3)는 내지 않는다(눌러도 효과가 없어 헷갈린다)
    ]
    const opts = allOpts.filter(o => !req.ask_reason || (o.key !== '2' && o.key !== '3'))
    const onKey = (e: KeyboardEvent) => {
      if (busy || (e.target as HTMLElement).closest('textarea,input')) {
        if (e.key === 'Escape' && insteadOpen) { e.preventDefault(); setInsteadOpen(false) }
        return
      }
      const o = opts.find(x => x.key === e.key)
      if (o) { e.preventDefault(); o.onPick() }
      else if (e.key === 'Escape') { e.preventDefault(); void cancel() }
    }
    return (
      <section aria-label={label} onKeyDown={onKey} className={cn('overflow-hidden rounded-xl border bg-card', isHigh ? 'border-warning/60' : 'border-primary/50')}>
        {header({
          icon, iconCls: isHigh ? 'text-warning' : 'text-primary', badge: riskBadge(isMobile ? (isHigh ? 'high' : 'low') : t(isHigh ? 'approvals.card.highBadge' : 'approvals.card.lowBadge')),
          right: (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="timer" aria-live="off">
              <UiIcon name="clock" className="h-3.5 w-3.5" />
              <span className="font-mono">{formatCountdown(left)}</span>
              {!isMobile && t('approvals.card.expiresIn')}
            </span>
          ),
        })}
        {body}
        <div className="border-t border-border px-3 py-2.5" role="group" aria-label={t('approvals.choice.question')}>
          <div className="px-1 pb-1.5 text-[13px] font-medium text-foreground">{t('approvals.choice.question')}</div>
          <div className="flex flex-col gap-0.5">
            {opts.map(o => (
              <button
                key={o.key} type="button" disabled={!!busy} onClick={o.onPick} aria-label={o.label} aria-keyshortcuts={o.key}
                className={cn('flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                  o.tone === 'primary' && 'font-medium text-primary', insteadOpen && o.key === '4' && 'bg-muted')}
              >
                <UiKeycap size={18} className="mt-px shrink-0">{o.key}</UiKeycap>
                <span className="min-w-0 flex-1">
                  {busy === 'approve' && o.key === '1' ? t('approvals.card.running') : o.label}
                  {o.hint && <span className="block text-[11.5px] font-normal text-muted-foreground">{o.hint}</span>}
                </span>
              </button>
            ))}
          </div>
          {insteadOpen && (
            <div className="mt-2 flex flex-col gap-2 px-1">
              <UiTextarea
                modelValue={instead} onUpdateModelValue={setInstead} rows={2} autoFocus
                placeholder={t('approvals.choice.insteadPlaceholder')} aria-label={t('approvals.choice.instead')}
                onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendInstead() } }}
              />
              <div className="flex justify-end gap-2">
                <UiButton size="sm" variant="ghost" onClick={() => setInsteadOpen(false)}>{t('approvals.card.back')}</UiButton>
                <UiButton size="sm" icon="send" disabled={!!busy || !instead.trim()} onClick={() => { void sendInstead() }}>{t('approvals.choice.sendInstead')}</UiButton>
              </div>
            </div>
          )}
        </div>
        <footer className={cn(footCls, 'bg-background/40 py-2')}>
          <span className="flex-1 basis-60">
            {isHigh ? t('approvals.choice.highFoot') : t('approvals.card.runHint')}
            {isHigh && <> <NuxtLink to={`/approvals?id=${encodeURIComponent(req.id)}`} className="font-medium text-primary hover:underline">{t('approvals.card.openInbox')}</NuxtLink></>}
          </span>
          <UiButton variant="ghost" size="sm" disabled={!!busy} onClick={() => { void cancel() }} aria-label={t('approvals.card.cancel')} aria-keyshortcuts="Escape">{t('approvals.card.cancel')} {!isMobile && <UiKeycap size={18} className="ml-1">Esc</UiKeycap>}</UiButton>
          <UiButton variant="outline" size="sm" icon="edit" disabled={!!busy} onClick={startEdit}>{t('approvals.card.edit')}</UiButton>
        </footer>
      </section>
    )
  }

  // 대기(low) — A1 카드 1 / A2-9 모바일
  if (status === 'pending' && !isHigh && req.source !== 'mcp') {
    const btnSize = isMobile ? 'lg' : 'sm'
    return (
      <section aria-label={label} className="overflow-hidden rounded-xl border border-primary/50 bg-card">
        {header({
          icon, iconCls: 'text-primary', badge: riskBadge(isMobile ? 'low' : t('approvals.card.lowBadge')),
          right: (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="timer" aria-live="off">
              <UiIcon name="clock" className="h-3.5 w-3.5" />
              <span className="font-mono">{formatCountdown(left)}</span>
              {!isMobile && t('approvals.card.expiresIn')}
            </span>
          ),
        })}
        {body}
        <footer className={cn(isMobile ? 'grid grid-cols-3 gap-2 border-t border-border px-3.5 py-3' : cn(footCls, 'bg-background/40'))}>
          {!isMobile && <span className="flex-1 basis-60">{t('approvals.card.runHint')}</span>}
          <UiButton variant="ghost" size={btnSize} className={isMobile ? 'px-2' : ''} disabled={!!busy} onClick={() => { void cancel() }}>{t('approvals.card.cancel')}</UiButton>
          <UiButton variant="outline" size={btnSize} className={isMobile ? 'px-2' : ''} icon={isMobile ? undefined : 'edit'} disabled={!!busy} onClick={startEdit}>{t('approvals.card.edit')}</UiButton>
          <UiButton size={btnSize} className={isMobile ? 'px-2' : ''} icon={isMobile ? undefined : 'check'} disabled={!!busy} onClick={() => { void approve() }}>
            {busy === 'approve' ? t('approvals.card.running') : t('approvals.card.run')}
          </UiButton>
        </footer>
      </section>
    )
  }

  // 대기(high · MCP) — A1 카드 2: 승인 대기함으로 보냄
  if (status === 'pending') {
    return (
      <section aria-label={label} className="overflow-hidden rounded-xl border border-warning/50 bg-card">
        {header({
          icon, iconCls: 'text-warning', badge: riskBadge(isMobile ? 'high' : t('approvals.card.highBadge')),
          right: !isMobile ? <UiBadge tone="warning" size={18}>{t('approvals.card.sentToInbox')}</UiBadge> : undefined,
        })}
        {body}
        <footer className={cn(footCls, 'bg-warning/[0.06] text-foreground')}>
          <UiIcon name="shield" className="h-4 w-4 text-warning" />
          <span className="flex-1 basis-64 leading-[19px]">
            {t('approvals.card.highHint')}{' '}
            <span className="font-mono text-muted-foreground">{req.id} · {t('approvals.card.expiresInMono', { time: formatCountdown(left) })}</span>
          </span>
          <NuxtLink
            to={`/approvals?id=${encodeURIComponent(req.id)}`}
            className={cn('inline-flex items-center justify-center rounded-[10px] border border-border px-3.5 text-[13.5px] font-medium text-foreground hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', isMobile ? 'h-11 w-full' : 'h-9')}
          >{t('approvals.card.openInbox')}</NuxtLink>
        </footer>
      </section>
    )
  }

  // A2-3 실행됨 / A2-7 high 승인됨
  if (status === 'executed') {
    return (
      <section aria-label={t('approvals.card.executedLabel', { title: req.title })} className="overflow-hidden rounded-xl border border-border bg-card">
        {header({
          icon: isHigh ? icon : 'check-circle', iconCls: 'text-success', border: false,
          badge: isHigh ? riskBadge('high') : undefined,
          right: <UiBadge tone="success" size={18}>{isHigh ? t('approvals.card.approvedDone') : t('approvals.card.executed')}</UiBadge>,
        })}
        {result ? <div className="px-4 py-3">{result}</div> : summary}
        <footer className={footCls}>
          <span className="flex-1 basis-52">
            {t(isHigh ? 'approvals.card.approvedBy' : 'approvals.card.executedBy', { name: who })} · <span className="font-mono">{time(req.executed_at || req.decided_at, true)} · {req.id}</span>
          </span>
          {link && <NuxtLink to={link} className="text-primary hover:underline">{t('approvals.card.openResult')}</NuxtLink>}
          {undoable && (
            <UiButton variant="ghost" size="xs" icon="rotate-ccw" disabled={!!busy} onClick={() => { void undo() }} aria-label={t('approvals.card.undoAria', { time: formatCountdown(undoLeft) })}>
              {t('approvals.card.undo')} <span className="ml-1 font-mono text-muted-foreground">{formatCountdown(undoLeft)}</span>
            </UiButton>
          )}
        </footer>
      </section>
    )
  }

  // 되돌림
  if (status === 'undone') {
    return (
      <section aria-label={t('approvals.card.undoneLabel', { title: req.title })} className="overflow-hidden rounded-xl border border-dashed border-border">
        {header({ icon: 'rotate-ccw', iconCls: 'text-muted-foreground', border: false, muted: true, right: <UiBadge tone="neutral" size={18}>{t('approvals.status.undone')}</UiBadge> })}
        <footer className={cn(footCls, 'border-dashed')}><span className="flex-1">{t('approvals.card.undoneNote')}</span></footer>
      </section>
    )
  }

  // A2-4 취소됨
  if (status === 'canceled') {
    return (
      <section aria-label={t('approvals.card.canceledLabel', { title: req.title })} className="overflow-hidden rounded-xl border border-dashed border-border bg-transparent">
        {header({ icon: 'ban', iconCls: 'text-muted-foreground', border: false, muted: true, right: <UiBadge tone="neutral" size={18}>{t('approvals.status.canceled')}</UiBadge> })}
        <footer className={cn(footCls, 'border-dashed')}>
          <span className="flex-1 basis-52">{t('approvals.card.canceledNote')}{req.decided_at && <> · <span className="font-mono">{time(req.decided_at)}</span></>}</span>
          {onCompose && <UiButton variant="ghost" size="xs" icon="refresh" onClick={() => onCompose(t('approvals.card.reproposePrompt', { title: req.title }))}>{t('approvals.card.repropose')}</UiButton>}
        </footer>
      </section>
    )
  }

  // A2-5 만료
  if (status === 'expired') {
    return (
      <section aria-label={t('approvals.card.expiredLabel', { title: req.title })} className="overflow-hidden rounded-xl border border-border bg-card opacity-85">
        {header({ icon: 'clock', iconCls: 'text-muted-foreground', right: <UiBadge tone="neutral" tint size={18}>{t('approvals.status.expired')}</UiBadge> })}
        <div className="px-4 py-3 text-[13px] leading-5 text-muted-foreground">
          {req.target_summary ? `${req.target_summary}. ` : ''}{t(isHigh || req.source === 'mcp' ? 'approvals.card.expiredNoteHigh' : 'approvals.card.expiredNote')}
        </div>
        <footer className={footCls}>
          <span className="flex-1 basis-52">{t('approvals.card.expiredHint')}</span>
          {onCompose && <UiButton variant="outline" size="xs" icon="refresh" onClick={() => onCompose(t('approvals.card.reproposePrompt', { title: req.title }))}>{t('approvals.card.newPreview')}</UiButton>}
        </footer>
      </section>
    )
  }

  // A2-6 실행 실패
  if (status === 'failed') {
    return (
      <section aria-label={t('approvals.card.failedLabel', { title: req.title })} className="overflow-hidden rounded-xl border border-danger/45 bg-card">
        {header({ icon, iconCls: 'text-danger' })}
        <div className="px-4 py-3">
          <UiErrorTile
            placement="card"
            title={req.error || t('approvals.card.failedTitle')}
            detail={time(req.executed_at || req.decided_at) || undefined}
            retryLabel={t('approvals.card.retry')}
            noRetry={!onCompose}
            onRetry={() => onCompose?.(t('approvals.card.retryPrompt', { title: req.title }))}
          />
        </div>
        <footer className={footCls}>{t('approvals.card.failedNote')}</footer>
      </section>
    )
  }

  // A2-8 거부됨(대기함에서)
  return (
    <section aria-label={t('approvals.card.rejectedLabel', { title: req.title })} className="overflow-hidden rounded-xl border border-border bg-card">
      {header({ icon: 'ban', iconCls: 'text-danger', border: false, badge: isHigh ? riskBadge('high') : undefined, right: <UiBadge tone="danger" size={18}>{t('approvals.status.rejected')}</UiBadge> })}
      {req.reject_reason && (
        <div className={cn('pb-3 pr-4 text-[13px] leading-5 text-muted-foreground', isMobile ? 'pl-3.5' : 'pl-[42px]')}>
          {t('approvals.card.rejectReason', { reason: req.reject_reason })}
        </div>
      )}
      <footer className={footCls}>
        <span className="flex-1 basis-52">
          {t('approvals.card.rejectedBy', { name: who })} · <span className="font-mono">{time(req.decided_at, true)}</span> · {t('approvals.card.notRun')}
        </span>
        {onCompose && (
          <UiButton variant="ghost" size="xs" icon="edit" onClick={() => onCompose(t('approvals.card.retryWithReasonPrompt', { title: req.title, reason: req.reject_reason || '' }))}>
            {t('approvals.card.retryWithReason')}
          </UiButton>
        )}
      </footer>
    </section>
  )
}

export default ApprovalCard
