/**
 * 관리자 › AI 운영 — 시안 F1(사용량) · F2(쓰기 현황·감사 로그·정책 + 상태·모바일) · I1·I2(피드백).
 * React 전환 뒤 새로 생긴 화면(routes.ts reactOnly). /admin/ai(설정 › AI — 모델·도구·한도)와는 따로, 운영 그룹에 둔다.
 * 탭은 경로: /admin/ai-ops(사용량) · /writes · /audit · /policy · /feedback. "한도 배분"은 다음 판(비활성 탭).
 * 기간(7·30·90일)은 탭 사이에서 유지된다(같은 라우트라 컴포넌트가 다시 마운트되지 않는다). 정책 탭엔 기간이 없다.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useRoute } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { UiSegment } from '~/components/ui/Segment'
import { UiTabs } from '~/components/ui/Tabs'
import { UsageTab } from '~/components/admin/aiOps/UsageTab'
import { WritesTab } from '~/components/admin/aiOps/WritesTab'
import { AuditTab } from '~/components/admin/aiOps/AuditTab'
import { PolicyTab } from '~/components/admin/aiOps/PolicyTab'
import { FeedbackTab } from '~/components/admin/aiOps/FeedbackTab'
import { aiOpsApi, loadError, tabFromPath, tabPath, type UsageState } from '~/utils/aiOps'
import { useIsMobile } from '~/composables/useIsMobile'

export default function AdminAiOpsPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('aiOps.title'), app: appName }) })
  const route = useRoute()
  const isMobile = useIsMobile()
  const tab = tabFromPath(route.path)
  const [days, setDays] = useState(30)
  const [usage, setUsage] = useState<UsageState>({ data: null, loading: false, error: null })
  const [downCount, setDownCount] = useState<number | null>(null)
  const seq = useRef(0)

  // 사용량 응답 하나를 사용량·쓰기 현황·피드백 통계가 같이 쓴다
  const loadUsage = useCallback(async (d: number) => {
    const my = ++seq.current
    setUsage(s => ({ ...s, loading: true, error: null }))
    try {
      const data = await aiOpsApi.usage(d)
      if (my === seq.current) setUsage({ data, loading: false, error: null })
    } catch (e) {
      if (my === seq.current) setUsage({ data: null, loading: false, error: loadError('/api/admin/ai/usage', e) })
    }
  }, [])
  const needsUsage = tab === 'usage' || tab === 'writes' || tab === 'feedback'
  const loadedFor = useRef<number | null>(null)
  useEffect(() => {
    if (!needsUsage || loadedFor.current === days) return
    loadedFor.current = days
    void loadUsage(days)
  }, [needsUsage, days, loadUsage])

  // 피드백 탭 카운트(이 기간의 별로예요)
  useEffect(() => {
    let alive = true
    aiOpsApi.feedback({ days, reason: '', attachedOnly: false, limit: 1 })
      .then(r => { if (alive) setDownCount(r.total) })
      .catch(() => { if (alive) setDownCount(null) })
    return () => { alive = false }
  }, [days])

  const tabs = [
    { key: 'usage', label: t('aiOps.tabs.usage'), to: tabPath('usage'), exact: true },
    { key: 'writes', label: t('aiOps.tabs.writes'), to: tabPath('writes') },
    { key: 'audit', label: t('aiOps.tabs.audit'), to: tabPath('audit') },
    { key: 'policy', label: t('aiOps.tabs.policy'), to: tabPath('policy') },
    { key: 'feedback', label: t('aiOps.tabs.feedback'), to: tabPath('feedback'), ...(downCount != null ? { count: downCount } : {}) },
    { key: 'quota', label: t('aiOps.tabs.quota'), disabled: true },
  ]
  const periods = [7, 30, 90].map(n => ({ value: n, label: t('aiOps.days', { n }) }))
  const segment = tab === 'policy' ? null : (
    <UiSegment
      ariaLabel={t('aiOps.period')} items={periods} modelValue={days} size={isMobile ? 'md' : 'sm'} grow={isMobile}
      onUpdateModelValue={v => setDays(Number(v) || 30)}
    />
  )

  return (
    <AdminPageShell title={t('aiOps.title')} subtitle={t('aiOps.subtitle')} actions={isMobile ? undefined : segment}>
      <UiTabs ariaLabel={t('aiOps.title')} items={tabs} flush />
      {isMobile && segment}
      <div className="flex flex-col gap-5 pt-1">
        {tab === 'usage' && <UsageTab days={days} state={usage} onRetry={() => void loadUsage(days)} />}
        {tab === 'writes' && <WritesTab days={days} state={usage} onRetry={() => void loadUsage(days)} />}
        {tab === 'audit' && <AuditTab days={days} />}
        {tab === 'policy' && <PolicyTab />}
        {tab === 'feedback' && <FeedbackTab days={days} usage={usage} onRetryUsage={() => void loadUsage(days)} />}
      </div>
    </AdminPageShell>
  )
}
