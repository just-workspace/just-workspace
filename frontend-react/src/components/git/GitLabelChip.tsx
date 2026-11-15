// Vue 원본: frontend/components/git/GitLabelChip.vue
// 라벨 칩(시안 PatBadges·GT3): 색 점 7 + 중립 테두리, 20 · rounded-5 · 11/500. 사용자 색은 점에만(대비 문제 없음).
import type { Label } from '~/composables/useGit'
import { labelDot } from '~/utils/labelColor'
import { cn } from '~/lib/utils'

export interface GitLabelChipProps {
  /** Gitea 라벨 */
  label: Label
  className?: string
}

/** 라벨 칩 */
export function GitLabelChip({ label, className }: GitLabelChipProps) {
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-[5px] rounded-[5px] border border-border px-[7px] text-[11px] font-medium text-foreground', className)}>
      <span className="h-[7px] w-[7px] rounded-full" style={{ background: labelDot(label.color) }} aria-hidden="true" />
      {label.name}
    </span>
  )
}

export default GitLabelChip
