/**
 * 아직 React 로 옮기지 않은 화면의 자리 표시. 라우트·레이아웃·가드는 이미 진짜로 동작한다.
 * 모듈 이식 에이전트가 src/pages/<경로>.tsx 를 실제 화면으로 바꾸면 사라진다.
 */
export interface NotPortedYetProps {
  /** Vue 원본 경로(frontend/ 기준). 예: "pages/mail/index.vue" */
  vuePath: string
}

export default function NotPortedYet({ vuePath }: NotPortedYetProps) {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center p-6" data-testid="not-ported-yet" data-vue-path={vuePath}>
      <div className="max-w-[680px] rounded-lg border border-dashed border-border bg-card px-5 py-4 text-center">
        <p className="text-sm font-semibold text-foreground">React 이식 전 화면</p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">frontend/{vuePath}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          <a className="underline underline-offset-2 hover:text-foreground" href="/__ui/vue">Vue 화면으로 보기</a>
        </p>
      </div>
    </div>
  )
}
