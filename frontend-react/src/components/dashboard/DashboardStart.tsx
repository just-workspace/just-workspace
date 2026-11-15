/**
 * 시작하기: 칩 줄 아래·주 줄 위 전폭 카드. 머리 "시작하기 n/N" + ✕(숨기기),
 * 항목은 판 열 수에 맞춰 1·2·3열 격자(startColumns), 행 56 — 끝낸 항목 = check-circle success + "완료",
 * 남은 항목 = 아이콘 + 할 일 / 설명 + [행동](outline, 오른쪽). 3열이면 6항목 2줄 = 머리 48 + 112.
 * ✕ 는 대시보드 배치의 숨기기(편집 패널 목록에서 다시 보기). 다 하면 카드와 "둘러볼 채널"이 사라진다(useStartChecklist().active).
 *
 * 판정·닫기 모두 서버(GET /api/dashboard/checklist · POST …/dismiss) — 서버가 실제 데이터로 완료를 매기고,
 * 닫음도 사용자 설정이라 기기를 바꿔도 같다. 다 끝나면 서버에 닫음으로 남긴다.
 * 2단계 인증(enable_2fa)은 끝내지 않은 동안 숨긴다 — 진행 수도 보이는 것 기준.
 */
import { useEffect, useMemo } from 'react'
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { initPwa, promptInstall, pwaStore } from '~/composables/usePwa'
import { requestBrowserPermission } from '~/composables/useNotifications'
import { UiIconButton } from '~/components/ui/IconButton'
import { startColumns } from '~/lib/dashLayout'
import { DashCard, DashRow, useCardStatus, useDash } from './DashCard'

export interface ChecklistItem { id: string; label: string; link: string; done: boolean }
export interface Checklist { items: ChecklistItem[]; done_count: number; total: number; completed: boolean; dismissed: boolean }

const LABEL: Record<string, string> = {
  profile_photo: 'dashboard.checklist.photo',
  first_message: 'dashboard.checklist.hello',
  invite_colleague: 'dashboard.checklist.invite',
  upload_file: 'dashboard.checklist.file',
  install_app: 'dashboard.checklist.app',
  enable_push: 'dashboard.checklist.notify',
  enable_2fa: 'dashboard.checklist.twoFactor',
}
const ICON: Record<string, string> = {
  profile_photo: 'user', first_message: 'hash', invite_colleague: 'user-plus', upload_file: 'upload',
  install_app: 'smartphone', enable_push: 'bell', enable_2fa: 'shield',
}

/** 체크리스트 상태(대시보드가 신규 사용자 배치를 고르는 데 쓴다) */
export const startStore = createStore<{ data: Checklist | null; hidden: boolean; loaded: boolean }>()(() => ({ data: null, hidden: true, loaded: false }))

/** 보이는 항목(끝내지 않은 2단계 인증은 뺀다) */
export function visibleItems(d: Checklist | null): ChecklistItem[] {
  return (d?.items || []).filter(i => !(i.id === 'enable_2fa' && !i.done))
}

export async function loadStart() {
  try {
    const d = await $fetch<Checklist>('/api/dashboard/checklist')
    let hidden = d.dismissed
    // 예전(기기별 localStorage)에 닫아 둔 사람은 한 번 서버로 옮긴다
    const oldKey = `jw.start-checklist.dismissed:${authStore.getState().user?.id ?? ''}`
    let old = false
    try { old = localStorage.getItem(oldKey) === '1' } catch { /* 저장소 없음 */ }
    if (old) {
      try { localStorage.removeItem(oldKey) } catch { /* 저장소 없음 */ }
      if (!d.dismissed) { hidden = true; void dismissStart() }
    }
    const items = visibleItems(d)
    // 다 끝났으면 서버에 닫음으로 남기고 숨긴다(다음 방문부터 어느 기기에서도 숨김)
    if (!hidden && items.length && items.every(i => i.done)) {
      hidden = true
      $fetch('/api/dashboard/checklist/dismiss', { method: 'POST', body: {} }).catch(() => {})
    }
    startStore.setState({ data: d, hidden: hidden || !items.length, loaded: true })
  } catch {
    startStore.setState({ hidden: true, loaded: true }) // 못 받으면 그리지 않는다
  }
}

export async function dismissStart() {
  startStore.setState({ hidden: true })
  try { await $fetch('/api/dashboard/checklist/dismiss', { method: 'POST', body: {} }) } catch { /* 이번 화면에선 숨김 유지 */ }
}

/** 신규 사용자 모드 = 시작하기가 보일 때 */
export function useStartChecklist() {
  const hidden = useStore(startStore, s => s.hidden)
  const loaded = useStore(startStore, s => s.loaded)
  return { active: loaded && !hidden, loaded }
}

export function DashboardStart() {
  const { t } = useI18n()
  const d = useDash()
  const data = useStore(startStore, s => s.data)
  useEffect(() => { initPwa() }, [])
  useCardStatus('start', data ? 'ready' : 'loading')

  async function run(it: ChecklistItem) {
    switch (it.id) {
      case 'invite_colleague': return navigateTo(authStore.getState().user?.is_admin ? '/admin/users' : (it.link || '/meetings'))
      case 'install_app':
        if (pwaStore.getState().canInstall) { await promptInstall(); return }
        window.open('/api/apps', '_blank', 'noopener')
        return
      case 'enable_push': {
        const perm = await requestBrowserPermission()
        // 구독 등록은 비동기 — 잠깐 뒤 서버 판정을 다시 받는다
        if (perm === 'granted') setTimeout(() => { void loadStart() }, 1500)
        return
      }
      case 'profile_photo': return navigateTo('/settings/account')
      default:
        if (it.link?.startsWith('/') && !it.link.startsWith('//')) return navigateTo(it.link, { external: it.link.startsWith('/api/') })
    }
  }

  const items = useMemo(() => visibleItems(data).map(i => ({ ...i, text: LABEL[i.id] ? t(LABEL[i.id]) : i.label })), [data, t])
  const done = items.filter(i => i.done).length
  return (
    <DashCard
      cardKey="start"
      title={t('dashboard.d17.start.title')}
      count={items.length ? `${done}/${items.length}` : ''}
      fixed
      extra={<UiIconButton label={t('dashboard.d17.panel.hide', { title: t('dashboard.d17.start.title') })} icon="close" size="sm" className="-mr-2" onClick={() => d.hide('start')} />}
    >
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${startColumns(d.cols)},minmax(0,1fr))` }}>
        {items.map(it => it.done
          ? <DashRow key={it.id} icon="check-circle" iconClass="text-success" title={it.text} time={t('dashboard.d17.start.done')} timeClass="text-success" className="h-14" />
          : (
            <DashRow
              key={it.id}
              icon={ICON[it.id] ?? 'circle'}
              title={it.text}
              meta={t(`dashboard.d17.start.meta.${it.id in ICON ? it.id : 'other'}`)}
              action={{ label: t(`dashboard.d17.start.act.${it.id in ICON ? it.id : 'other'}`), variant: 'outline', persistent: true, onClick: () => { void run(it) } }}
            />
          ))}
      </ul>
    </DashCard>
  )
}

export default DashboardStart
