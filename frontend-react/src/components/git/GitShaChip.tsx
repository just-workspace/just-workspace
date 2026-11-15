// Vue 원본: frontend/components/git/GitShaChip.vue
// SHA 칩 + 복사 버튼 상시: muted 바탕 mono 7자 + 복사 아이콘 버튼(터치 가능 — hover 전용 폐지).
// size md = 커밋 행 28 · sm = 최신 커밋 줄 24. 복사 버튼 히트는 40.
import type { MouseEvent } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { addToast } from '~/composables/useToast'
import { UiIcon } from '~/components/ui/Icon'
import { writeClipboard } from '~/lib/clipboard'

export interface GitShaChipProps {
  /** 커밋 SHA(전체) */
  sha: string
  /** md 28(기본) · sm 24 */
  size?: 'sm' | 'md'
}

/** 커밋 SHA 칩(앞 7자 + 복사) */
export function GitShaChip({ sha, size = 'md' }: GitShaChipProps) {
  const { t } = useI18n()
  const short = sha.slice(0, 7)

  async function copy(e: MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    try {
      await writeClipboard(sha)
      addToast('success', t('git.sha.copied', { sha: short }))
    } catch { addToast('error', t('common.copyFailed')) }
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md bg-muted font-mono text-foreground',
        size === 'sm' ? 'h-6 gap-1 pl-2 pr-0.5 text-[11px]' : 'h-7 gap-0.5 pl-2.5 pr-0.5 text-xs',
      )}
      title={sha}
    >
      {short}
      <button
        type="button"
        aria-label={t('git.sha.copy')}
        className={cn(
          "relative grid place-items-center rounded-sm text-muted-foreground hover:text-foreground before:absolute before:-inset-2 before:content-[''] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          size === 'sm' ? 'h-5 w-5' : 'h-7 w-7',
        )}
        onClick={copy}
      >
        <UiIcon name="copy" className="h-[13px] w-[13px]" />
      </button>
    </span>
  )
}

export default GitShaChip
