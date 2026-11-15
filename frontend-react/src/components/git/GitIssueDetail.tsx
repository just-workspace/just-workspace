// Vue 원본: frontend/components/git/GitIssueDetail.vue
/**
 * 이슈 상세.
 *  제목 20/700 + #n(mono muted) · [편집] [이슈 닫기] → 상태 칩(P6) + "작성자 님이 언제 작성 · 담당 이름"
 *  → 라벨 줄(GitLabelPicker ghost — 기존 기능 유지) → 본문 카드(rounded-12) → 댓글 n → 댓글들 → 댓글 쓰기
 * [편집] = 제목·본문을 그 자리에서 고친다(저장 · 취소, Esc 취소, Ctrl+Enter 저장). [이슈 닫기]/[다시 열기] = 상태 PATCH.
 * 담당 = 라벨 줄과 같은 줄 규격(이름 칩 + 점선 "+ 담당 지정" 드롭다운, GitAssigneePicker). 모두 PATCH /issues/{n}.
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useI18n } from '~/i18n'
import { timeAgo } from '~/lib/date'
import { gitStore, useGit } from '~/composables/useGit'
import { addToast } from '~/composables/useToast'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiInput } from '~/components/ui/Input'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiButton } from '~/components/ui/Button'
import { UiAvatar } from '~/components/ui/Avatar'
import { WorkStateChip } from '~/components/work/WorkStateChip'
import { GitLabelChip } from './GitLabelChip'
import { GitLabelPicker } from './GitLabelPicker'
import { GitAssigneePicker } from './GitAssigneePicker'
import { GitMarkdownRenderer } from './GitMarkdownRenderer'

/** 이슈 상세 */
export function GitIssueDetail() {
  const { selectedIssue, issueComments, issueLoading, issueError, addIssueComment, setIssueLabels, loadIssue, updateIssue } = useGit()
  const { t } = useI18n()

  const [newComment, setNewComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submitComment() {
    const body = newComment.trim()
    const i = gitStore.getState().selectedIssue
    if (!body || !i) return
    setSubmitting(true)
    try {
      await addIssueComment(i.number, body)
      setNewComment('')
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('git.issueDetail.commentFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  async function commitLabels(ids: number[]) {
    const i = gitStore.getState().selectedIssue
    if (!i) return
    try { await setIssueLabels(i.number, ids) }
    catch (e: any) { addToast('error', e?.data?.detail || t('git.issueDetail.labelFailed')) }
  }

  const assigneeLogins = (selectedIssue?.assignees ?? []).map(a => a.login)
  const assignees = assigneeLogins.join(', ')

  // ─── 편집 · 닫기/다시 열기 · 담당 ───
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')
  const [saving, setSaving] = useState(false)
  const issueNumber = selectedIssue?.number
  useEffect(() => { setEditing(false) }, [issueNumber])

  function startEdit() {
    if (!selectedIssue) return
    setEditTitle(selectedIssue.title)
    setEditBody(selectedIssue.body || '')
    setEditing(true)
  }
  async function saveEdit() {
    const i = gitStore.getState().selectedIssue
    if (!i || saving) return
    const title = editTitle.trim()
    if (!title) { addToast('error', t('git.issueDetail.titleRequired')); return }
    const patch: { title?: string; body?: string } = {}
    if (title !== i.title) patch.title = title
    if (editBody !== (i.body || '')) patch.body = editBody
    if (!patch.title && patch.body === undefined) { setEditing(false); return }
    setSaving(true)
    try {
      await updateIssue(i.number, patch)
      setEditing(false)
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('git.issueDetail.saveFailed'))
    } finally {
      setSaving(false)
    }
  }
  function onEditKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void saveEdit() }
  }

  const [toggling, setToggling] = useState(false)
  async function toggleState() {
    const i = gitStore.getState().selectedIssue
    if (!i || toggling) return
    const next = i.state === 'open' ? 'closed' : 'open'
    setToggling(true)
    try {
      await updateIssue(i.number, { state: next })
      addToast('success', next === 'closed' ? t('git.issueDetail.closed') : t('git.issueDetail.reopened'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('git.issueDetail.saveFailed'))
    } finally {
      setToggling(false)
    }
  }

  async function commitAssignees(logins: string[]) {
    const i = gitStore.getState().selectedIssue
    if (!i) return
    try { await updateIssue(i.number, { assignees: logins }) }
    catch (e: any) { addToast('error', e?.data?.detail || t('git.issueDetail.assigneeFailed')) }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {issueLoading && !selectedIssue ? (
        <UiSkeleton preset="text" rows={6} className="p-6" />
      ) : issueError ? (
        <UiErrorTile
          placement="panel"
          className="mt-6"
          title={issueError === 'notfound' ? t('git.issueDetail.notFound') : t('git.issueDetail.loadFailed')}
          noRetry={issueError === 'notfound'}
          onRetry={() => { if (selectedIssue) void loadIssue(selectedIssue.number) }}
        />
      ) : selectedIssue ? (
        <article className="px-4 py-4 md:px-6 md:py-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start">
            {!editing ? (
              <h1 className="flex-1 text-xl font-bold leading-[1.4] text-foreground">
                {selectedIssue.title}{' '}
                <span className="font-mono font-normal text-muted-foreground">#{selectedIssue.number}</span>
              </h1>
            ) : (
              <div className="min-w-0 flex-1">
                <UiInput
                  modelValue={editTitle}
                  onUpdateModelValue={setEditTitle}
                  aria-label={t('git.issueDetail.titleLabel')}
                  className="[&_input]:text-base [&_input]:font-semibold"
                  onKeyDown={onEditKey}
                />
              </div>
            )}
            <div className="flex shrink-0 gap-2">
              {!editing ? (
                <>
                  <UiButton variant="outline" size="xs" onClick={startEdit}>{t('git.issueDetail.edit')}</UiButton>
                  <UiButton variant="outline" size="xs" disabled={toggling} onClick={() => { void toggleState() }}>{selectedIssue.state === 'open' ? t('git.issueDetail.close') : t('git.issueDetail.reopen')}</UiButton>
                </>
              ) : (
                <>
                  <UiButton variant="outline" size="xs" disabled={saving} onClick={() => setEditing(false)}>{t('common.cancel')}</UiButton>
                  <UiButton size="xs" disabled={saving || !editTitle.trim()} onClick={() => { void saveEdit() }}>{t('common.save')}</UiButton>
                </>
              )}
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            <WorkStateChip state={selectedIssue.state === 'open' ? 'open' : 'closed'} />
            <span>{t('git.shared.authored', { user: selectedIssue.user?.login ?? '', when: timeAgo(selectedIssue.created_at) })}</span>
            {assignees && <>· {t('git.shared.assignee')} <b className="font-semibold text-foreground">{assignees}</b></>}
          </div>

          {/* 라벨 줄 */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="shrink-0 text-xs font-semibold text-muted-foreground">{t('git.labels.title')}</span>
            {selectedIssue.labels.map(l => <GitLabelChip key={l.id} label={l} />)}
            <GitLabelPicker
              modelValue={selectedIssue.labels.map(l => l.id)}
              mode="assign"
              variant="ghost"
              onCommit={(ids) => { void commitLabels(ids) }}
            />
          </div>

          {/* 담당 줄(라벨 줄과 같은 규격) */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="shrink-0 text-xs font-semibold text-muted-foreground">{t('git.shared.assignee')}</span>
            {(selectedIssue.assignees ?? []).map(a => (
              <span
                key={a.login}
                className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border pl-0.5 pr-2 text-xs"
              >
                <UiAvatar src={a.avatar_url || null} alt={a.login} fallback={a.login.charAt(0).toUpperCase()} className="h-5 w-5 text-[9px]" />
                {a.login}
              </span>
            ))}
            <GitAssigneePicker modelValue={assigneeLogins} onCommit={(v) => { void commitAssignees(v) }} />
          </div>

          {/* 본문 */}
          {editing ? (
            <div className="mt-4">
              <UiTextarea
                modelValue={editBody}
                onUpdateModelValue={setEditBody}
                rows={8}
                aria-label={t('git.issueDetail.bodyLabel')}
                placeholder={t('git.issueDetail.bodyPlaceholder')}
                className="[&_textarea]:rounded-lg"
                onKeyDown={onEditKey}
              />
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-border px-4 py-3.5 text-sm leading-[1.7]">
              {selectedIssue.body
                ? <GitMarkdownRenderer content={selectedIssue.body} />
                : <p className="text-muted-foreground">{t('git.pull.noDescription')}</p>}
            </div>
          )}

          {/* 댓글 */}
          <h2 className="mt-4 text-[13px] font-semibold">{t('git.issueDetail.comments')} <span className="font-mono">{issueComments.length || selectedIssue.comments}</span></h2>
          {issueLoading ? (
            <UiSkeleton preset="list" rows={2} className="mt-2" />
          ) : issueComments.length ? (
            <ul role="list" className="mt-2 flex flex-col gap-2.5">
              {issueComments.map(c => (
                <li key={c.id} className="rounded-lg border border-border">
                  <div className="flex items-center gap-2 border-b border-border bg-card px-3.5 py-2 text-xs text-muted-foreground">
                    <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold text-foreground" aria-hidden="true">{(c.user?.login || '?').charAt(0).toUpperCase()}</span>
                    <b className="font-semibold text-foreground">{c.user?.login}</b>
                    <span className="font-mono">{timeAgo(c.created_at)}</span>
                  </div>
                  <div className="px-3.5 py-3 text-sm"><GitMarkdownRenderer content={c.body} /></div>
                </li>
              ))}
            </ul>
          ) : null}

          <form className="mt-2.5 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void submitComment() }}>
            <UiTextarea
              modelValue={newComment}
              onUpdateModelValue={setNewComment}
              rows={newComment ? 4 : 1}
              aria-label={t('git.issueDetail.writeComment')}
              placeholder={t('git.issueDetail.commentPlaceholder')}
              className="[&_textarea]:min-h-11 [&_textarea]:rounded-lg [&_textarea]:bg-card"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submitComment() }}
            />
            {newComment.trim() && (
              <div className="flex justify-end">
                <UiButton size="sm" type="submit" disabled={submitting}>{submitting ? t('git.issueDetail.commenting') : t('git.issueDetail.comment')}</UiButton>
              </div>
            )}
          </form>
        </article>
      ) : null}
    </div>
  )
}

export default GitIssueDetail
