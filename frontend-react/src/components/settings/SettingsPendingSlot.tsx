/**
 * 다른 모듈이 옮길 컴포넌트 자리(임시) — 설정·관리 화면 안에 끼우는 남의 모듈 컴포넌트(MailFilterRules·AiAdminSettings)가
 * 아직 React 판이 없을 때 그 자리에 그린다. 페이지 전체 자리 표시(NotPortedYet)와 구분되게 data-testid="pending-slot".
 * 주인 모듈 판이 들어오면 이 자리를 진짜 컴포넌트로 바꾼다(MIGRATION 4-1).
 *
 * @example <SettingsPendingSlot vuePath="components/mail/MailFilterRules.vue" owner="메일" />
 */
export interface SettingsPendingSlotProps {
  /** Vue 원본 경로(frontend/ 기준) */
  vuePath: string
  /** 이식 담당 모듈 이름 */
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
