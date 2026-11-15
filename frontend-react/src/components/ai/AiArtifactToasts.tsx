/**
 * 결과물 묶음 완료 토스트(시안 L1-4) — 다른 화면(또는 다른 대화)에 있을 때 작업이 끝나면.
 *  popover 바탕 · r12 · 그림자 · check-circle 20 success(일부 실패 = alert-circle warning) ·
 *  제목 14/600 "파일 3개를 다 만들었습니다" · 12.5 muted "대화 “…”" · [대화로 가기](primary) [zip 받기](ghost xs) · 닫기.
 *  자리는 공용 토스트와 같다(데스크톱 왼쪽 아래, 모바일 상단바 아래). 셸에 한 번 그린다.
 */
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { currentPath, navigateTo } from '~/lib/router'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiTrans } from '~/components/ui/Trans'
import { dismissArtifactToast, openAiConversation, useAiArtifactToasts } from '~/composables/useAiArtifacts'
import type { AiArtifactJob } from '~/utils/aiArtifacts'

export function AiArtifactToasts() {
  const toasts = useAiArtifactToasts()
  if (!toasts.length || typeof document === 'undefined') return null
  return createPortal(
    <div className="pointer-events-none fixed inset-x-3 top-[calc(56px+env(safe-area-inset-top)+8px)] z-toast flex flex-col gap-2 sm:inset-x-auto sm:bottom-6 sm:left-auto sm:right-6 sm:top-auto sm:w-[380px]">
      {toasts.map(j => <ArtifactToast key={j.id} job={j} />)}
    </div>,
    document.body,
  )
}

export function ArtifactToast({ job }: { job: AiArtifactJob }) {
  const { t } = useI18n()
  const ok = job.status === 'done'
  const titleKey = job.status === 'failed' ? 'ai.artifact.toast.failed'
    : job.kind === 'files_zip' ? (ok ? 'ai.artifact.toast.zipped' : 'ai.artifact.toast.zippedPartial')
      : (ok ? 'ai.artifact.toast.done' : 'ai.artifact.toast.partial')
  const mono = (v: unknown) => <span className="font-mono">{String(v)}</span>
  const zipUrl = job.zip?.download_url || undefined
  return (
    <div role="status" className="pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-popover px-4 py-3.5 text-popover-foreground shadow-[0_8px_24px_rgb(0_0_0/0.35)]">
      <UiIcon name={ok ? 'check-circle' : 'alert-circle'} className={cn('mt-0.5 h-5 w-5 shrink-0', ok ? 'text-success' : 'text-warning')} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-semibold"><UiTrans k={titleKey} slots={{ n: mono(job.ok), p: mono(`${job.ok}/${job.total}`) }} /></span>
        {job.conversation_id && <span className="truncate text-[12.5px] text-muted-foreground">{t('ai.artifact.toast.conv', { title: job.conversation_title || t('ai.untitled') })}</span>}
        <span className="mt-1 flex flex-wrap gap-2">
          {job.conversation_id && (
            <UiButton size="sm" onClick={() => { dismissArtifactToast(job.id); openAiConversation(job.conversation_id!, navigateTo, currentPath() === '/ai') }}>
              {t('ai.artifact.toast.go')}
            </UiButton>
          )}
          {zipUrl && <UiButton as="a" href={zipUrl} download={job.zip?.name} variant="ghost" size="xs" icon="download">{t('ai.artifact.toast.zip')}</UiButton>}
        </span>
      </span>
      <UiIconButton label={t('common.close')} icon="close" size="sm" variant="ghost" onClick={() => dismissArtifactToast(job.id)} />
    </div>
  )
}

export default AiArtifactToasts
