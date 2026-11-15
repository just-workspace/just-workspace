/**
 * 파일 댓글 — 상세 패널의 "댓글" 탭.
 * 데스크톱:
 *  맨 위 줄 = "내 권한 [배지]" … "댓글 n"(px-4 py-2.5 12 muted, 아래 선).
 *  행(px-4 py-3, 아래 선 border/60) = 아바타 28 · 이름 13/600 · 시각 mono 11 · (해결됨 success 틴트 배지) / 본문 13 relaxed(@언급 = primary/15 칩)
 *    / 위치 조각 mono 11 muted / 행동 12/600 muted: 답글 · 해결(열린 최상위만) — 보기 권한이면 행동 줄을 숨긴다.
 *  입력(위 선, p-3) = UiTextarea rows 2 + "Ctrl + Enter 로 등록" + [등록](xs). "@" 를 치면 입력 위 UiMentionList
 *    (머리 "이 파일을 볼 수 있는 사람", 보조 = 이메일 · 권한 / "보기 권한 없음", 바닥 안내).
 *  보기 권한 = 입력 자리에 안내 띠(eye) "보기 권한은 댓글을 읽기만 합니다 … [권한 요청]" → 원 소유자에게 알림.
 * 모바일: 행 = 아바타 32 · 이름 14 · 시각 · 본문 15 + 오른쪽 ⋮(답글 · 해결 · 수정 · 삭제), 입력 = UiTextarea 1줄 + 보내기(solid lg).
 * 답글은 최상위 아래 들여 쓴다(왼쪽 54) · "○○ 님에게 답글 ✕" 줄 · 해결된 댓글의 "다시 열기" ·
 *   내 댓글의 수정·삭제(기존 기능) 를 행동 줄 끝에 남김.
 */
import { Fragment, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useI18n } from '~/i18n'
import { useToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { useIsMobile } from '~/composables/useIsMobile'
import { useFileComments, type FileComment, type FileMentionCandidate } from '~/composables/useFileComments'
import { roleLabelKey } from '~/lib/files'
import { authorName, boardStamp, initialOf, mentionQueryAt, splitResolvedMentions } from '~/utils/boardFormat'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiBadge } from '~/components/ui/Badge'
import { UiMentionList, useUiMentionList } from '~/components/ui/MentionList'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiTrans } from '~/components/ui/Trans'

export type FileCommentsState = ReturnType<typeof useFileComments>

export interface FilesFileCommentsPanelProps {
  /** 댓글을 볼 파일 경로(my/.. 또는 shared-with-me/..) */
  path: string
  /** 상세 패널이 이미 가진 댓글 상태(탭 숫자 "댓글 n" 을 같이 쓰려고). 없으면 이 부품이 직접 읽는다 */
  state?: FileCommentsState
}

/** 권한 배지 톤: 보기 neutral · 댓글 primary · 편집 success · 공동 소유 warning */
export const ROLE_TONE = { view: 'neutral', comment: 'primary', edit: 'success', owner: 'warning' } as const

export function FilesFileCommentsPanel({ path, state }: FilesFileCommentsPanelProps) {
  const { t } = useI18n()
  const { addToast } = useToast()
  const isMobile = useIsMobile()

  const own = useFileComments(path)
  const c = state ?? own
  const { items, canComment, role, owner, isOriginalOwner, loading, error, load, add, edit, remove, resolve, mentionable, requestAccess } = c
  useEffect(() => { if (!state) void own.load() }, [path]) // eslint-disable-line react-hooks/exhaustive-deps

  // 최상위 + 그 아래 답글(오래된 순)
  const tops = items.filter(x => !x.parent_id || !items.some(y => y.id === x.parent_id))
  const repliesOf = (id: string) => items.filter(x => x.parent_id === id)

  // ── 입력 ──
  const [content, setContent] = useState('')
  const contentRef = useRef('')
  contentRef.current = content
  const [submitting, setSubmitting] = useState(false)
  const [replyTo, setReplyTo] = useState<FileComment | null>(null)
  const box = useRef<HTMLTextAreaElement | null>(null)

  // @멘션(그 파일 권한이 붙은 후보)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const mentionRef = useRef<{ start: number; query: string } | null>(null)
  const [candidates, setCandidates] = useState<FileMentionCandidate[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  const pendingCaret = useRef<number | null>(null)
  function putMention(m: { start: number; query: string } | null) { mentionRef.current = m; setMention(m) }
  function checkMention(text = contentRef.current) {
    const el = box.current
    if (!el) return
    const m = mentionQueryAt(text, el.selectionStart ?? text.length)
    putMention(m)
    if (!m) { setCandidates([]); return }
    if (timer.current) clearTimeout(timer.current)
    const my = ++seq.current
    timer.current = setTimeout(async () => {
      try {
        const list = await mentionable(m.query)
        if (my !== seq.current || !mentionRef.current) return
        setCandidates(list.slice(0, 8))
      } catch {
        if (my === seq.current) setCandidates([])
      }
    }, 150)
  }
  function closeMention() {
    putMention(null)
    setCandidates([])
    seq.current++
  }
  const open = !!mention && candidates.length > 0
  function insertMention(u: FileMentionCandidate) {
    const m = mentionRef.current
    const el = box.current
    if (!m || !el) return
    const cur = contentRef.current
    const caret = el.selectionStart ?? cur.length
    const ins = `@${u.username} `
    setContent(cur.slice(0, m.start) + ins + cur.slice(caret))
    closeMention()
    pendingCaret.current = m.start + ins.length
  }
  const ml = useUiMentionList({ count: candidates.length, open, onPick: i => insertMention(candidates[i]), onClose: closeMention, idPrefix: 'file-mention' })
  useEffect(() => {
    const pos = pendingCaret.current
    const el = box.current
    if (pos === null || !el) return
    pendingCaret.current = null
    el.focus()
    el.setSelectionRange(pos, pos)
  })
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  function onKeydown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (ml.onKeyDown(e)) return
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit() }
    else if (e.key === 'Escape' && replyTo) { e.stopPropagation(); setReplyTo(null) }
  }
  async function submit() {
    const text = contentRef.current.trim()
    if (!text || submitting) return
    setSubmitting(true)
    try {
      await add(text, { parentId: replyTo?.id ?? null })
      setContent('')
      setReplyTo(null)
      closeMention()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.comments.createError'))
    } finally {
      setSubmitting(false)
    }
  }
  function startReply(cm: FileComment) {
    setReplyTo(cm)
    requestAnimationFrame(() => box.current?.focus())
  }
  async function toggleResolve(cm: FileComment) {
    try { await resolve(cm.id, !cm.resolved) } catch (e: any) { addToast('error', e?.data?.detail || t('files.comments.resolveError')) }
  }

  // ── 수정·삭제(내 댓글만) ──
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [saving, setSaving] = useState(false)
  async function saveEdit(e?: FormEvent) {
    e?.preventDefault()
    const id = editingId
    if (!id || !editText.trim()) return
    setSaving(true)
    try {
      await edit(id, editText.trim())
      setEditingId(null)
    } catch (err: any) {
      addToast('error', err?.data?.detail || t('files.comments.editError'))
    } finally {
      setSaving(false)
    }
  }
  async function onDelete(id: string) {
    if (!await confirmBox(t('files.comments.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') })) return
    try { await remove(id) } catch (e: any) { addToast('error', e?.data?.detail || t('files.comments.deleteError')) }
  }
  function editKeys(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void saveEdit() }
    else if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null) }
  }

  // ── 권한 요청(보기) ──
  const [requested, setRequested] = useState(false)
  useEffect(() => { setRequested(false) }, [path])
  async function askAccess() {
    try {
      await requestAccess('comment')
      setRequested(true)
      addToast('success', t('files.comments.requested', { owner: owner?.display_name ?? '' }))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.comments.requestError'))
    }
  }

  const nameOf = (a: { display_name?: string | null; username?: string } | null) => authorName(a) || t('common.unknownUser')
  const roleName = role ? (isOriginalOwner ? t('files.detail.originalOwner') : t(roleLabelKey(role))) : ''
  const roleTone = role ? ROLE_TONE[role] : 'neutral'

  function body(cm: FileComment, size: string) {
    return (
      <p className={`mt-0.5 whitespace-pre-wrap break-words leading-relaxed ${size}`}>
        {splitResolvedMentions(cm.content, cm.mentions).map((pt, i) => (
          pt.mention
            ? <span key={i} className="rounded-sm bg-primary/15 px-1 font-medium text-primary" title={pt.user?.display_name || undefined}>{pt.text}</span>
            : <Fragment key={i}>{pt.text}</Fragment>
        ))}
      </p>
    )
  }

  function mobileMenu(cm: FileComment): UiMenuItem[] {
    const out: UiMenuItem[] = [{ key: 'reply', label: t('files.comments.reply'), icon: 'reply' }]
    if (!cm.parent_id) out.push({ key: 'resolve', label: cm.resolved ? t('files.comments.reopen') : t('files.comments.resolve'), icon: 'check' })
    if (cm.is_mine) {
      out.push({ key: 'edit', label: t('common.edit'), icon: 'edit', separated: true })
      out.push({ key: 'delete', label: t('common.delete'), icon: 'trash', danger: true })
    }
    return out
  }
  function onMobileMenu(cm: FileComment, k: string) {
    if (k === 'reply') startReply(cm)
    else if (k === 'resolve') void toggleResolve(cm)
    else if (k === 'edit') { setEditingId(cm.id); setEditText(cm.content) }
    else if (k === 'delete') void onDelete(cm.id)
  }

  function row(cm: FileComment, reply: boolean) {
    const who = nameOf(cm.author)
    return (
      <li key={cm.id} className={`flex border-b border-border/60 py-3 pr-4 ${isMobile ? 'gap-3' : 'gap-2.5'} ${reply ? (isMobile ? 'pl-[60px]' : 'pl-[54px]') : 'pl-4'}`}>
        <UiAvatar src={cm.author?.avatar_url} alt={who} fallback={initialOf(who)} className={isMobile ? 'h-8 w-8 shrink-0' : 'h-7 w-7 shrink-0'} textSize={isMobile ? 12 : 11} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`truncate font-semibold ${isMobile ? 'text-sm' : 'text-[13px]'}`}>{who}</span>
            {cm.created_at && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{boardStamp(cm.created_at)}</span>}
            {cm.is_edited && <span className="shrink-0 text-[11px] text-muted-foreground">{t('files.comments.edited')}</span>}
            <span className="flex-1" />
            {cm.resolved && <UiBadge tone="success" tint size={18} className="shrink-0">{t('files.comments.resolved')}</UiBadge>}
          </div>
          {editingId === cm.id
            ? (
              <form className="mt-1" onSubmit={saveEdit}>
                <UiTextarea modelValue={editText} onUpdateModelValue={setEditText} rows={3} aria-label={t('files.comments.editLabel')} onKeyDown={editKeys} />
                <div className="mt-1 flex gap-1">
                  <UiButton size="xs" type="submit" disabled={saving || !editText.trim()}>{t('common.save')}</UiButton>
                  <UiButton size="xs" variant="ghost" type="button" onClick={() => setEditingId(null)}>{t('common.cancel')}</UiButton>
                </div>
              </form>
            )
            : (
              <>
                {body(cm, isMobile ? 'text-[15px]' : 'text-[13px]')}
                {cm.anchor && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{cm.anchor}</p>}
                {canComment && !isMobile && (
                  <div className="mt-1 flex gap-3 text-xs font-semibold text-muted-foreground">
                    <button type="button" className="-my-2 py-2 hover:text-foreground" onClick={() => startReply(cm)}>{t('files.comments.reply')}</button>
                    {!cm.parent_id && (
                      <button type="button" className="-my-2 py-2 hover:text-foreground" onClick={() => { void toggleResolve(cm) }}>
                        {cm.resolved ? t('files.comments.reopen') : t('files.comments.resolve')}
                      </button>
                    )}
                    {cm.is_mine && (
                      <>
                        <button type="button" className="-my-2 py-2 hover:text-foreground" onClick={() => { setEditingId(cm.id); setEditText(cm.content) }}>{t('common.edit')}</button>
                        <button type="button" className="-my-2 py-2 hover:text-danger" onClick={() => { void onDelete(cm.id) }}>{t('common.delete')}</button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
        </div>
        {isMobile && canComment && (
          <UiMenu
            label={`${who} ${t('files.detail.tabComments')} — ${mobileMenu(cm).map(x => x.label).join('·')}`}
            items={mobileMenu(cm)}
            triggerIcon="more-vertical"
            triggerSize="md"
            onSelect={(k) => onMobileMenu(cm, k)}
          />
        )}
      </li>
    )
  }

  const mentionOptions = candidates.map(u => ({
    id: u.id,
    label: u.display_name || u.username,
    secondary: u.role ? [u.email, t(roleLabelKey(u.role))].filter(Boolean).join(' · ') : t('files.comments.noAccess'),
    avatarUrl: u.avatar_url,
  }))

  const textarea = (
    <UiTextarea
      ref={box}
      rows={isMobile ? 1 : 2}
      modelValue={content}
      onUpdateModelValue={(v) => { setContent(v); contentRef.current = v; checkMention(v) }}
      placeholder={t('files.comments.placeholder')}
      aria-label={t('files.detail.tabComments')}
      maxLength={4000}
      autoComplete="off"
      className={isMobile ? 'flex-1' : undefined}
      {...ml.inputProps}
      onKeyDown={onKeydown}
      onClick={() => checkMention()}
      onBlur={closeMention}
    />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!isMobile && role && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
          <span>{t('files.comments.myRole')}</span>
          <UiBadge tone={roleTone} tint size={18}>{roleName}</UiBadge>
          <span className="flex-1" />
          <UiTrans k="files.comments.countN" as="span" slots={{ n: <span className="font-mono">{items.length}</span> }} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !items.length
          ? <UiSkeleton preset="list" rows={3} />
          : error
            ? <UiErrorTile placement="panel" title={t('files.comments.loadError')} onRetry={load} />
            : !items.length
              ? <UiEmptyState variant="panel" icon="message-square" title={t('files.comments.empty')} description={canComment ? t('files.comments.emptyHint') : undefined} />
              : (
                <ul aria-label={t('files.detail.tabComments')}>
                  {tops.map(top => (
                    <Fragment key={top.id}>
                      {row(top, false)}
                      {repliesOf(top.id).map(r => row(r, true))}
                    </Fragment>
                  ))}
                </ul>
              )}
      </div>

      {canComment
        ? (
          <div className={isMobile ? 'relative shrink-0 border-t border-border px-3 pb-7 pt-2' : 'relative shrink-0 border-t border-border p-3'}>
            {open && (
              <UiMentionList
                id={ml.id}
                ariaLabel={t('files.comments.mentionList')}
                options={mentionOptions}
                activeIndex={ml.active}
                onActiveChange={ml.setActive}
                onPick={ml.pick}
                heading={t('files.comments.mentionHeading')}
                footer={t('files.comments.mentionFooter')}
                className="left-3 right-3"
              />
            )}
            {replyTo && (
              <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <UiIcon name="reply" className="h-3.5 w-3.5" />
                <span className="min-w-0 flex-1 truncate">{t('files.comments.replyingTo', { name: nameOf(replyTo.author) })}</span>
                <UiIconButton icon="close" label={t('files.comments.cancelReply')} size="sm" onClick={() => setReplyTo(null)} />
              </div>
            )}
            {isMobile
              ? (
                <div className="flex items-end gap-2">
                  {textarea}
                  <UiIconButton icon="send" label={t('files.comments.post')} variant="solid" size="lg" disabled={submitting || !content.trim()} onClick={() => { void submit() }} />
                </div>
              )
              : (
                <>
                  {textarea}
                  <div className="mt-2 flex items-center gap-2">
                    <span className="flex-1 text-[11px] text-muted-foreground">{t('files.comments.ctrlEnter')}</span>
                    <UiButton size="xs" disabled={submitting || !content.trim()} onClick={() => { void submit() }}>{submitting ? t('files.comments.posting') : t('files.comments.post')}</UiButton>
                  </div>
                </>
              )}
          </div>
        )
        : !loading && role && (
          <div className="flex shrink-0 items-start gap-2 border-t border-border bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            <UiIcon name="eye" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {requested
              ? <UiTrans k="files.comments.requestedNote" as="span" values={{ owner: owner?.display_name ?? '' }} slots={{ b: (s: ReactNode) => <b className="font-semibold text-foreground">{s}</b> }} />
              : (
                <UiTrans
                  k="files.comments.viewerNote"
                  as="span"
                  values={{ owner: owner?.display_name ?? '' }}
                  slots={{
                    b: (s: ReactNode) => <b className="font-semibold text-foreground">{s}</b>,
                    req: (s: ReactNode) => <UiButton variant="link" size="xs" className="h-auto p-0 align-baseline text-xs font-semibold" onClick={() => { void askAccess() }}>{s}</UiButton>,
                  }}
                />
              )}
          </div>
        )}
    </div>
  )
}

export default FilesFileCommentsPanel
