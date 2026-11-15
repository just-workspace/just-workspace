/**
 * AI 메시지 한 줄(Vue components/ai/AiMessageItem.vue).
 *  왼쪽 정렬 · 아바타 타일 28(사용자 = 원형 primary/20 이니셜, 어시스턴트 = r8 secondary + 반짝임) · 간격 12(모바일 10).
 *  머리: 이름 13/600 + mono 11 muted(시각, 어시스턴트는 "모델 · 시각") — 모바일은 이름만.
 *  도구 칩 26(r6, 12/600): 완료 muted + ✓ success · 진행 warning/15 + 회전 · 실패 danger/15 "… 실패".
 *  본문 15px foreground(줄 1.75, 모바일 1.65~1.7) · 스트리밍 커서 8×16 foreground/70.
 *  오류·도구 실패 = warning 띠(role=alert) + "다시 시도"(primary 600).
 *
 * 진행 단계 카드(도구 칩 대신) · 본문 [n] 출처 표식 + 출처 칩·미리보기 · 수식(KaTeX) ·
 *  행동 줄(복사 · 👍 · 👎 · 다시 만들기 … AI 생성 · 모델 · 확인 안내) · 끊김/멈춤 = "이어서 받기" 타일 ·
 *  받는 중 [멈추기].
 *
 * 사용자 메시지 아래 [질문 수정] [◀ n/N ▶](버전이 2개 이상일 때) · 수정 칸(보내기 = 새 버전) ·
 *  첨부 칩 · 답변 중 메모리에 저장했으면 "메모리에 저장함 — “…” 보기 · 취소" 줄.
 */
import { Fragment, useCallback, useId, useState } from 'react'
import { NuxtLink } from '~/components/NuxtLink'
import { UiTextarea } from '~/components/ui/Textarea'
import { AiSentAttachments } from '~/components/ai/AiAttachments'
import { cn } from '~/lib/utils'
import { aiFileIcon } from '~/utils/aiAssist'
import { useI18n } from '~/i18n'
import { useAiLabels } from '~/composables/useAiLabels'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiTrans } from '~/components/ui/Trans'
import { AiMessage } from '~/components/ai/AiMessage'
import { AiSteps } from '~/components/ai/AiSteps'
import { AiCitations } from '~/components/ai/AiCitations'
import { AiFeedbackButtons } from '~/components/ai/AiFeedback'
import { ApprovalCard } from '~/components/approvals/ApprovalCard'
import { AiArtifacts } from '~/components/ai/AiArtifacts'
import { aiArtifactsFromWrites, aiMergeArtifacts } from '~/utils/aiArtifacts'
import type { AiFeedback, AiMemorySaved, AiMsg, AiQuestion } from '~/utils/aiAssist'
import { AiQuestionCard } from '~/components/ai/AiQuestionCard'
import type { ApprovalRequest } from '~/utils/approvals'
import { announceApprovalUpdate, approvalsApi } from '~/composables/useApprovals'
import { toast } from '~/composables/useToast'

export interface AiMessageItemProps {
  /** 메시지 */
  msg: AiMsg
  /** 사용자 이름(머리)·이니셜 */
  userName: string
  /** 사용자 아바타 주소 */
  userAvatar?: string | null
  /** 마지막 어시스턴트 응답(다시 생성·다시 시도 가능) */
  last?: boolean
  /** 응답 받는 중(다시 생성 숨김) */
  busy?: boolean
  /** 복사 — 본문 */
  onCopy?: (text: string) => void
  /** 다시 생성 · 다시 시도 */
  onRegenerate?: () => void
  /** 끊기거나 멈춘 답변 이어서 받기 */
  onContinue?: () => void
  /** 받는 중 멈추기 */
  onStop?: () => void
  /** 피드백이 바뀜 */
  onFeedback?: (fb: AiFeedback | null) => void
  /** 사용자 메시지 고치기 — 본문을 입력 칸으로 */
  onEdit?: (text: string) => void
  /** 승인 카드의 요청이 바뀜(실행·취소·수정 등) */
  onWriteChange?: (req: ApprovalRequest) => void
  /** AI 질문 카드에 답함(ask_user · plan_exit) */
  onQuestionChange?: (q: AiQuestion) => void
  /** 승인 카드 "대화로 고치기"·"다시 제안" — 입력 칸에 넣을 문장 */
  onWriteCompose?: (text: string) => void
  /** 질문 수정 보내기(새 버전). 있으면 "편집"이 입력칸 대신 제자리 수정 칸을 연다.
   *  keepIds = 원래 첨부 중 이번 버전에 넣을 것(첨부가 없으면 undefined) */
  onEditSubmit?: (text: string, keepIds?: string[]) => void
  /** 지금 모델이 이미지를 읽는지 — 수정 때 이미지를 유지하면 보내기 막힘 */
  vision?: boolean
  /** 버전 넘기기(1부터) */
  onSwitchVersion?: (n: number) => void
  /** 메모리 저장 취소 */
  onMemoryUndo?: (m: AiMemorySaved) => void
}

export function AiMessageItem({ msg, userName, userAvatar, last, busy, onCopy, onRegenerate, onContinue, onStop, onFeedback, onEdit, onWriteChange, onQuestionChange, onWriteCompose, onEditSubmit, onSwitchVersion, onMemoryUndo, vision = true }: AiMessageItemProps) {
  const { t, locale } = useI18n()
  // 묶음 처리(선택식) — 대기 low 카드가 2개 이상이면 체크박스 + [선택 실행][선택 취소]. 기본은 전부 선택
  const pendingLow = (msg.writes || []).filter(w => w.status === 'pending' && w.risk === 'low')
  const batchOn = pendingLow.length >= 2
  const [unpicked, setUnpicked] = useState<Set<string>>(() => new Set())
  const picked = pendingLow.filter(w => !unpicked.has(w.id))
  const [batchBusy, setBatchBusy] = useState<'approve' | 'cancel' | null>(null)
  const togglePick = useCallback((id: string, on: boolean) => setUnpicked(prev => {
    const n = new Set(prev); if (on) n.delete(id); else n.add(id); return n
  }), [])
  const runBatch = useCallback(async (action: 'approve' | 'cancel') => {
    const conv = picked[0]?.conversation_id
    if (!conv || !picked.length) return
    setBatchBusy(action)
    try {
      const r = await approvalsApi.batch(conv, picked.map(w => w.id), action)
      for (const it of r.items) { onWriteChange?.(it); announceApprovalUpdate(it) }
    } catch (e: any) {
      toast({ type: 'error', title: e?.data?.detail || t('ai.perm.failed') })
    } finally { setBatchBusy(null) }
  }, [picked, onWriteChange, t])
  const { toolLabel } = useAiLabels()
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [openCite, setOpenCite] = useState<number | null>(null)
  const onOpenCite = useCallback((n: number | null) => setOpenCite(n), [])
  const [editing, setEditing] = useState<string | null>(null)
  // 질문 수정 때 뺄 첨부 id(기본은 모두 유지)
  const [dropped, setDropped] = useState<string[]>([])
  const editAtts = (msg.attachments ?? []).filter(a => a.id)
  const editBlocked = !vision && editAtts.some(a => a.kind === 'image' && !dropped.includes(a.id as string))
  const versionTotal = msg.versions?.length ?? 0
  const versionN = msg.active_version ?? versionTotal

  const isUser = msg.role === 'user'
  // 스트림·기록의 결과물 카드 — 승인 카드로 실행한 결과(같은 작업 id)는 빼고(그 승인 카드 안에 보인다)
  const writeJobIds = new Set(aiArtifactsFromWrites(msg.writes).map(p => (p.type === 'file' ? undefined : p.job?.id)).filter(Boolean) as string[])
  const standaloneArtifacts = aiMergeArtifacts(msg.artifacts ?? []).filter(p => !(p.type !== 'file' && p.job?.id && writeJobIds.has(p.job.id)))
  const initial = (userName || '?').trim().slice(0, 1).toUpperCase()

  const fmtTime = (v?: string | null) => {
    if (!v) return ''
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleTimeString(locale === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  const time = fmtTime(msg.created_at)
  const meta = (isUser || !msg.model)
    ? time
    : (time ? t('ai.message.meta', { model: msg.model, time }) : msg.model)

  const steps = msg.steps ?? []
  const citations = msg.citations ?? []
  const partial = !isUser && !msg.streaming && !!msg.content && (msg.status === 'interrupted' || msg.status === 'stopped' || !!msg.stopped)
  const stoppedByUser = msg.status === 'stopped' || !!msg.stopped
  const failedTools = steps.length ? [] : (msg.tools ?? []).filter(x => x.ok === false)
  /** 오류 띠 문구 — 스트림 오류가 먼저, 없으면 도구 실패. 받은 부분이 있는 끊김은 "이어서 받기" 타일이 대신한다 */
  const alertText = (() => {
    if (msg.streaming || partial) return ''
    if (msg.error) return msg.error
    if (failedTools.length) return t('ai.message.toolFailNote', { names: failedTools.map(x => toolLabel(x.name)).join(', ') })
    return ''
  })()

  function openCiteFromText(n: number) {
    setOpenCite(n)
    document.getElementById(`cite-${uid}-${n}`)?.focus()
  }

  return (
    <div className="group flex gap-2.5 md:gap-3">
      {/* 아바타 */}
      {isUser ? (
        userAvatar
          ? <img src={userAvatar} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
          : <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/20 text-[11px] font-semibold text-primary">{initial}</span>
      ) : (
        <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-secondary text-foreground">
          <UiIcon name="sparkles" className="h-[15px] w-[15px]" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-foreground">
          {isUser ? userName : t('ai.assistant')}
          {' '}
          {meta && <span className="hidden font-mono text-[11px] font-normal text-muted-foreground md:inline">{meta}</span>}
        </div>

        {/* 진행 단계 — 없으면(옛 기록·단계 이벤트 없는 서버) 도구 칩 */}
        {!isUser && !!steps.length && (
          <AiSteps steps={steps} streaming={msg.streaming} startedAt={msg.started_at} endedAt={msg.ended_at} className="my-1.5 md:my-2" />
        )}
        {!steps.length && !!msg.tools?.length && (
          <div className="my-1.5 flex flex-wrap gap-1.5 md:my-2">
            {msg.tools.map(tr => (
              <Fragment key={tr.name}>
                {tr.ok === undefined && msg.streaming ? (
                  <span role="status" className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-warning/15 px-2.5 text-xs font-semibold text-warning">
                    <UiIcon name="loader" className="h-3 w-3 animate-spin" />{t('ai.message.toolRunning', { name: toolLabel(tr.name) })}
                  </span>
                ) : tr.ok === false ? (
                  <span className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-danger/15 px-2.5 text-xs font-semibold text-danger">
                    <UiIcon name="alert-circle" className="h-3 w-3" />{t('ai.message.toolFailed', { name: toolLabel(tr.name) })}
                  </span>
                ) : (
                  <span className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-muted px-2.5 text-xs font-semibold text-foreground">
                    <UiIcon name="check" className="h-3 w-3 text-success" />{toolLabel(tr.name)}
                  </span>
                )}
              </Fragment>
            ))}
          </div>
        )}

        {/* 본문 */}
        {isUser && editing !== null ? (
          // 질문 수정
          <div className="mt-1 flex flex-col gap-2.5 rounded-xl border border-ring bg-card p-3">
            {!!editAtts.length && (
              <div className="flex flex-wrap gap-1.5">
                {editAtts.map((a) => {
                  const keep = !dropped.includes(a.id as string)
                  return (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={keep}
                      className={cn(
                        'inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg border bg-transparent px-2.5 text-[12.5px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                        keep ? 'border-primary/60 text-foreground' : 'border-border text-muted-foreground line-through',
                      )}
                      onClick={() => setDropped(l => (keep ? [...l, a.id as string] : l.filter(x => x !== a.id)))}
                    >
                      <UiIcon name={aiFileIcon(a.name, a.kind)} className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 truncate">{a.name} · {keep ? t('ai.attach.keep') : t('ai.attach.drop')}</span>
                    </button>
                  )
                })}
              </div>
            )}
            <UiTextarea modelValue={editing} onUpdateModelValue={setEditing} aria-label={t('ai.versions.editLabel')} rows={2} autoFocus />
            {editBlocked && <p role="alert" className="m-0 text-xs text-danger">{t('ai.attach.editNoVision')}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                {editAtts.length ? t('ai.attach.editNote') : t('ai.versions.editNote', { n: String(Math.max(versionTotal, 1) + 1) })}
              </span>
              <UiButton variant="ghost" size="sm" onClick={() => setEditing(null)}>{t('ai.versions.cancel')}</UiButton>
              <UiButton
                size="sm"
                icon="send"
                disabled={!editing.trim() || busy || editBlocked}
                onClick={() => {
                  const v = editing.trim()
                  const keep = editAtts.length ? editAtts.map(a => a.id as string).filter(id => !dropped.includes(id)) : undefined
                  setEditing(null)
                  onEditSubmit?.(v, keep)
                }}
              >{t('ai.versions.send')}</UiButton>
            </div>
          </div>
        ) : isUser ? (
          <>
            {/* 보낸 첨부 — 누르면 원본 미리보기·내려받기 */}
            {!!msg.attachments?.length && <AiSentAttachments items={msg.attachments} className="mb-1.5 mt-1" />}
            {!!msg.content && <div className="mt-0.5 whitespace-pre-wrap break-words text-[15px] leading-[1.65] text-foreground md:leading-[1.7]">{msg.content}</div>}
          </>
        ) : (
          <div className={'text-[15px] leading-[1.7] text-foreground md:leading-[1.75]'}>
            {msg.content && (
              <AiMessage
                content={msg.content}
                streaming={msg.streaming}
                citations={citations.map(c => c.n)}
                onCite={openCiteFromText}
              />
            )}
            {msg.streaming && <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground/70 align-[-2px]" />}
          </div>
        )}

        {/* 받는 중 멈추기 */}
        {!isUser && msg.streaming && onStop && (
          <div className="mt-2">
            <UiButton variant="outline" size="sm" icon="square" onClick={() => onStop()}>{t('ai.message.stop')}</UiButton>
          </div>
        )}

        {/* 출처 칩 */}
        {!isUser && !!citations.length && (
          <AiCitations items={citations} idPrefix={`cite-${uid}`} openN={openCite} onOpenChange={onOpenCite} className="mt-3" />
        )}

        {/* 결과물 카드 — 스트림·기록 + 승인 카드로 실행한 파일 압축 */}
        {/* 승인 카드로 실행한 결과(files_zip 묶음)는 그 승인 카드 안에 보인다 — 따로 카드를 띄우면 이중으로 보인다 */}
        {!isUser && !!standaloneArtifacts.length && (
          <AiArtifacts items={standaloneArtifacts} className="mt-3" />
        )}

        {/* 메모리에 저장함 */}
        {!isUser && !!msg.memories?.length && (
          <div className="mt-2.5 flex flex-col gap-1.5">
            {msg.memories.map(m => (
              <div key={m.id} role="status" className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[12.5px] text-muted-foreground">
                <UiIcon name="memory-stick" className="h-3.5 w-3.5 shrink-0" />
                <span className={'min-w-0 flex-1 ' + (m.cancelled ? 'line-through' : '')}>{m.cancelled ? t('ai.memory.undone') : t('ai.memory.saved', { text: m.text })}</span>
                {!m.cancelled && (
                  <>
                    <NuxtLink to="/settings/ai/memory" className="text-primary hover:underline">{t('ai.memory.view')}</NuxtLink>
                    <button type="button" className="font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onMemoryUndo?.(m)}>{t('ai.memory.undo')}</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* AI 질문 카드 — Claude Code AskUserQuestion · ExitPlanMode */}
        {!isUser && !!msg.questions?.length && (
          <div className="mt-3.5 flex flex-col gap-3.5">
            {msg.questions.map(q => <AiQuestionCard key={q.id} q={q} onChange={onQuestionChange} />)}
          </div>
        )}

        {/* 쓰기 승인 카드 */}
        {!isUser && !!msg.writes?.length && (
          <div className="mt-3.5 flex flex-col gap-3.5">
            {batchOn && (
              <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2.5 rounded-[10px] border border-primary/40 bg-card px-3 py-2 text-[13px] shadow-sm">
                <UiCheckbox
                  size={16} ariaLabel={t('ai.perm.pickAll')}
                  modelValue={picked.length === pendingLow.length} indeterminate={picked.length > 0 && picked.length < pendingLow.length}
                  onUpdateModelValue={v => setUnpicked(v ? new Set() : new Set(pendingLow.map(w => w.id)))}
                />
                <span className="flex-1 text-foreground">{t('ai.perm.picked', { k: picked.length, n: pendingLow.length })}</span>
                <UiButton size="sm" variant="ghost" disabled={!!batchBusy || !picked.length} onClick={() => { void runBatch('cancel') }}>
                  {t('ai.perm.cancelPicked')}
                </UiButton>
                <UiButton size="sm" icon="check" disabled={!!batchBusy || !picked.length} onClick={() => { void runBatch('approve') }}>
                  {batchBusy === 'approve' ? t('approvals.card.running') : t('ai.perm.runPicked', { k: picked.length })}
                </UiButton>
              </div>
            )}
            {msg.writes.map(w => {
              const card = (
                <ApprovalCard
                  key={w.id} request={w} userName={userName} onChange={onWriteChange} onCompose={onWriteCompose}
                  result={aiArtifactsFromWrites([w]).length ? <AiArtifacts items={aiArtifactsFromWrites([w])} /> : undefined}
                />
              )
              if (!batchOn || w.status !== 'pending' || w.risk !== 'low') return card
              return (
                <div key={w.id} className="flex items-start gap-2.5">
                  <UiCheckbox className="mt-3.5" size={16} ariaLabel={t('ai.perm.pickOne')} modelValue={!unpicked.has(w.id)} onUpdateModelValue={v => togglePick(w.id, v)} />
                  <div className="min-w-0 flex-1">{card}</div>
                </div>
              )
            })}
          </div>
        )}

        {/* 끊김·멈춤 — 받은 부분은 저장됨, 이어서 받기 */}
        {partial && (
          <UiErrorTile
            className="mt-2.5"
            title={stoppedByUser ? t('ai.message.stoppedTitle') : t('ai.message.interruptedTitle')}
            detail={[stoppedByUser ? '' : (msg.error || t('ai.message.connectionLost')), fmtTime(msg.ended_at || msg.created_at), t('ai.message.partialSaved')].filter(Boolean).join(' · ')}
            retryLabel={t('ai.message.continue')}
            noRetry={!last || busy}
            onRetry={() => onContinue?.()}
          />
        )}

        {/* 오류·도구 실패 */}
        {alertText && (
          <div role="alert" className="mt-2.5 flex items-center gap-2.5 rounded-[10px] border border-warning/40 bg-warning/10 px-3 py-2.5 text-[13px] text-foreground">
            <span className="min-w-0 flex-1">{alertText}</span>
            {last && !busy && (
              <button
                type="button"
                className="relative shrink-0 font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-x-2 before:-inset-y-3 before:content-['']"
                onClick={() => onRegenerate?.()}
              >{t('ai.message.retry')}</button>
            )}
          </div>
        )}

        {/* 행동 줄 + AI 생성 표시(AI 기본법) */}
        {!isUser && !msg.streaming && (!!msg.content || !!msg.writes?.length || !!msg.artifacts?.length) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {!!msg.content && <UiIconButton label={t('ai.message.copy')} icon="copy" size="sm" onClick={() => onCopy?.(msg.content)} />}
            {!!msg.content && <AiFeedbackButtons messageId={msg.id} value={msg.feedback} onChange={onFeedback} />}
            {last && !busy && !alertText && !partial && !!msg.content && (
              <UiIconButton label={t('ai.message.regenerate')} icon="refresh" size="sm" onClick={() => onRegenerate?.()} />
            )}
            <span className="flex-1" />
            <span className="inline-flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
              <UiIcon name="sparkles" className="h-3.5 w-3.5" />
              {msg.model ? (
                <>
                  <UiTrans k="ai.message.aiGeneratedModel" as="span" className="hidden md:inline" slots={{ model: <span className="font-mono">{msg.model}</span> }} />
                  <UiTrans k="ai.message.aiGeneratedModelShort" as="span" className="md:hidden" slots={{ model: <span className="font-mono">{msg.model}</span> }} />
                </>
              ) : <span>{t('ai.message.aiGenerated')}</span>}
            </span>
          </div>
        ) : isUser && editing === null ? (
          // 질문 수정 · 버전 넘기기 — 버전이 여럿이면 늘 보이고, 아니면 hover·포커스 때
          <div className={'mt-1 flex items-center gap-0.5 text-xs text-muted-foreground transition-opacity ' + (versionTotal > 1 ? '' : 'md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100')}>
            {onEditSubmit && msg.id ? (
              <UiIconButton label={t('ai.versions.editQuestion')} icon="edit" size="sm" disabled={busy} onClick={() => { setDropped([]); setEditing(msg.content) }} />
            ) : (
              <button type="button" className="hover:text-foreground" onClick={() => onEdit?.(msg.content)}>{t('ai.message.edit')}</button>
            )}
            {versionTotal > 1 && (
              <>
                <UiIconButton label={t('ai.versions.prev')} icon="chevron-left" size="sm" disabled={busy || versionN <= 1} onClick={() => onSwitchVersion?.(versionN - 1)} />
                <span className="min-w-8 text-center font-mono" aria-label={t('ai.versions.label', { n: String(versionN), total: String(versionTotal) })}>{versionN}/{versionTotal}</span>
                <UiIconButton label={t('ai.versions.next')} icon="chevron-right" size="sm" disabled={busy || versionN >= versionTotal} onClick={() => onSwitchVersion?.(versionN + 1)} />
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default AiMessageItem
