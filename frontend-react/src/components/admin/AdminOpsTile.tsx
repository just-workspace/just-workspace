import { cn } from '~/lib/utils'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { TONE_TILE, type OpsTile } from './dashboardTiles'

export interface AdminOpsTileProps {
  /** 칸 내용(buildOpsTiles 결과 한 개): 이름·아이콘·값·hint·톤·바로 가기(action·to) */
  tile: OpsTile
}

/**
 * 운영 요약 한 칸 — 틴트 아이콘 36 · 이름 12 · 값 15/600(hint 를 title 로) · 오른쪽 바로 가기 글자 링크.
 * Vue 판 dashboard.vue 의 tiles v-for 한 칸.
 */
export function AdminOpsTile({ tile }: AdminOpsTileProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3.5">
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-md', TONE_TILE[tile.tone])}>
        <UiIcon name={tile.icon} className="h-[17px] w-[17px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{tile.key}</div>
        <div className="truncate text-[15px] font-semibold text-foreground" title={tile.hint || tile.value}>{tile.value}</div>
      </div>
      <NuxtLink to={tile.to} className="relative shrink-0 text-xs font-semibold text-primary hover:underline after:absolute after:-inset-x-2 after:-inset-y-3 after:content-['']">
        {tile.action}
      </NuxtLink>
    </div>
  )
}


export default AdminOpsTile
