// 새 이슈("이슈 쓰기"): 자체 구현 rounded-xl 중앙 모달 → UiModal(데스크톱 중앙 · 모바일 바텀시트, G 규격).
// 제목 · 본문(마크다운) · 라벨(GitLabelPicker — 기존 기능 유지). 실패는 토스트로 표시(이전에는 console.error 만 수행).
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useGit } from '~/composables/useGit'
import { addToast } from '~/composables/useToast'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiButton } from '~/components/ui/Button'
import { GitLabelChip } from './GitLabelChip'
import { GitLabelPicker } from './GitLabelPicker'

export interface GitCreateIssueModalProps {
  /** 닫기 */
  onClose?: () => void
  /** 생성 완료 — 새 이슈 번호 */
  onCreated?: (n: number) => void
}

/** 새 이슈 모달 */
export function GitCreateIssueModal({ onClose, onCreated }: GitCreateIssueModalProps) {
  const { createIssue, fetchLabels, labelById } = useGit()
  const { t } = useI18n()

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [labelIds, setLabelIds] = useState<number[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => { void fetchLabels() }, [fetchLabels]) // 모달 열림 시 라벨 조회

  async function submit() {
    if (!title.trim() || submitting) return
    setSubmitting(true)
    try {
      const created = await createIssue(title.trim(), body, labelIds)
      addToast('success', created ? t('git.newIssue.createdWithNumber', { n: created.number }) : t('git.newIssue.created'))
      if (created) onCreated?.(created.number)
      onClose?.()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('git.newIssue.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <UiModal
      title={t('git.issue.newButton')}
      size="lg"
      persistent={submitting}
      onClose={() => onClose?.()}
      footer={
        <>
          <UiButton variant="outline" size="sm" type="button" onClick={() => onClose?.()}>{t('common.cancel')}</UiButton>
          <UiButton size="sm" type="submit" form="git-new-issue" disabled={!title.trim() || submitting}>{submitting ? t('git.newIssue.submitting') : t('git.newIssue.submit')}</UiButton>
        </>
      }
    >
      <form id="git-new-issue" className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <UiInput modelValue={title} onUpdateModelValue={setTitle} label={t('git.newIssue.titleLabel')} required data-autofocus placeholder={t('git.newIssue.titlePlaceholder')} />
        <UiTextarea modelValue={body} onUpdateModelValue={setBody} label={t('git.newIssue.bodyLabel')} rows={6} placeholder={t('git.newIssue.bodyPlaceholder')} />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground">{t('git.labels.title')}</span>
          {labelIds.map(id => <GitLabelChip key={id} label={labelById(id)} />)}
          <GitLabelPicker modelValue={labelIds} onUpdateModelValue={setLabelIds} mode="assign" variant="ghost" />
        </div>
      </form>
    </UiModal>
  )
}

export default GitCreateIssueModal
