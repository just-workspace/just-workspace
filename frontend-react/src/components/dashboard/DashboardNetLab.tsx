/**
 * 네트워크 랩 카드 — 외부 출처 런처. "열기"만 제공(사용량 요약 없음).
 * 헤더: 아이콘 타일 40(router, primary/15) + 제목 15/600 + 호스트(mono 12, 주소에서 추출).
 * 본문: 설명 한 행(13 muted) · 푸터: [열기 ↗](primary sm, 새 탭) ··· "새 탭에서 열립니다"(12 muted).
 * 주소가 없으면 대시보드가 카드를 사용 불가로 판정한다(DashboardHome defs.lab.on) — 본 컴포넌트는 url 이 있을 때만 렌더링된다.
 */
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { netlabHost } from '~/composables/useNetLab'
import { DashCard, useCardStatus } from './DashCard'

export function DashboardNetLab({ url }: { url: string }) {
  const { t } = useI18n()
  useCardStatus('lab', 'ready')
  const title = t('dashboard.d17.lab.title')
  return (
    <DashCard
      cardKey="lab"
      title={title}
      head={(
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
            <UiIcon name="router" className="h-5 w-5" />
          </span>
          <span className="flex min-w-0 flex-col">
            <h2 className="truncate text-[15px] font-semibold">{title}</h2>
            <span className="truncate font-mono text-[12px] text-muted-foreground">{netlabHost(url)}</span>
          </span>
        </span>
      )}
    >
      <div className="flex flex-col gap-4 px-5 pb-5 pt-4">
        <p className="m-0 text-[13px] leading-5 text-muted-foreground">{t('dashboard.d17.lab.desc')}</p>
        <div className="flex items-center justify-between gap-3">
          <UiButton as="a" href={url} target="_blank" rel="noopener noreferrer" size="sm" iconRight="external-link">
            {t('dashboard.d17.lab.open')}
          </UiButton>
          <span className="text-[12px] text-muted-foreground">{t('dashboard.d17.lab.newTab')}</span>
        </div>
      </div>
    </DashCard>
  )
}

export default DashboardNetLab
