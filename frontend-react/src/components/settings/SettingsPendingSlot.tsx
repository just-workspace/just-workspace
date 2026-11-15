/**
 * 다른 모듈의 컴포넌트가 들어올 자리 — 설정·관리 화면 안에 끼우는 남의 모듈 컴포넌트(MailFilterRules·AiAdminSettings)가
 * 없을 때 그 자리에 그린다. 페이지 전체 자리 표시(NotPortedYet)와 구분되게 data-testid="pending-slot".
 *
 * @example <SettingsPendingSlot vuePath="components/mail/MailFilterRules.vue" owner="메일" />
 */
export interface SettingsPendingSlotProps {
  /** 옮기지 않은 컴포넌트의 옛 파일 경로(표시용) */
  vuePath: string
  /** 그 컴포넌트를 맡은 모듈 이름 */
  owner: string
}

export function SettingsPendingSlot({ vuePath, owner }: SettingsPendingSlotProps) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-5 py-4 text-center" data-testid="pending-slot" data-vue-path={vuePath}>
      <p className="text-sm font-semibold text-foreground">React 이식 전 구성 요소 · {owner} 모듈 담당</p>
      <p className="mt-1 font-mono text-xs text-muted-foreground">frontend/{vuePath}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        <a className="underline underline-offset-2 hover:text-foreground" href="/__ui/vue">Vue 화면으로 보기</a>
      </p>
    </div>
  )
}

export default SettingsPendingSlot
