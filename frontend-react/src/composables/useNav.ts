/**
 * 사이드바(데스크탑)·하단 탭바(모바일)가 공유하는 그룹 네비 모델 — Vue 판 composables/useNav.ts 그대로.
 * 레일 묶음 순서는 아래 GROUPS. 모바일 "전체" 시트는 별도 묶음을 쓴다(MobileTabBar).
 * 그룹/순서는 여기서 결정하고, 표시(활성 표시·카운트 등)는 각 컴포넌트가 담당.
 *
 * React: const { home, groups, railGroups, flat } = useNav()   — groups·railGroups·flat 은 배열 값(Vue 의 .value)
 * 활성 판정: isNavActive(item, path, withAliases?) — 컴포넌트 밖에서도 쓴다.
 */
import { useMemo } from 'react'
import { moduleIconName } from '~/utils/icons'
import { usePlatform } from '~/composables/usePlatform'
import { useAuth } from '~/composables/useAuth'
import { i18n, useI18n } from '~/i18n'

export interface NavItem {
  id: string
  name: string
  route: string
  icon?: string // rail 아이콘(모듈 registry icon 이름). 없으면 dot
  matchExact?: boolean
  matchPrefix?: string // 활성 판정용 경로 접두사(route와 다를 때. 예: 관리 → /admin)
  /** 이 경로들에서도 레일 활성(하위 모듈 — 예: 메일 ← /contacts) */
  alsoMatch?: string[]
  /** false 면 레일에 그리지 않는다(전체 시트·Ctrl+K 에는 남음) */
  rail?: boolean
}

// 항목 활성 여부 — matchExact(대시보드) / matchPrefix(관리) / 기본 startsWith(route)
// withAliases=false 면 alsoMatch(상위 모듈로 묶인 하위 경로)를 보지 않는다 — 최근 방문 기록처럼 실제 모듈이 필요할 때.
export function isNavActive(item: NavItem, path: string, withAliases = true): boolean {
  const under = (r: string) => path === r || path.startsWith(r + '/')
  if (withAliases && item.alsoMatch?.some(under)) return true
  if (item.matchExact) return path === item.route
  if (item.matchPrefix) return path.startsWith(item.matchPrefix)
  return under(item.route)
}

// 연락처는 레일에 없다 — 메일 모듈의 하위. 진입: 메일 사이드바 "연락처" · 전체 시트 · Ctrl+K.
// 연락처 화면에서는 레일의 메일이 켜지고 상단바 경로는 메일 / 연락처.
const RAIL_HIDDEN = new Set(['contacts'])
/**
 * 워크스페이스 내비게이션(레일·모바일 탭·명령 팔레트)에 넣지 않는 모듈.
 * rbi(격리 브라우저)는 전용 출처(rbi.<도메인>)에서 따로 열린다 — 사용자는 그 주소로 바로(또는 사용자 메뉴 "격리 브라우저 열기"·
 * 데스크톱 레일 '도구' 묶음의 새 탭 항목 — composables/useRailTools),
 * 관리자는 관리 › 격리 브라우저. /rbi 경로는 옛 링크용 런처로만 남는다.
 */
export const NAV_EXCLUDED = new Set(['rbi'])
const ALSO_MATCH: Record<string, string[]> = { mail: ['/contacts'] }

export interface NavGroup {
  key: string
  label: string
  items: NavItem[]
}

// 그룹 이름은 i18n 키 shell.navGroup.<key> (groups 계산 안에서 t — 로캘 전환에 반응)
// 레일 순서·구분선: 홈 | 메일·채팅·캘린더·회의 | 파일·위키·게시판 | 작업·Git·AI | 관리.
// 연락처는 소통 묶음 끝(레일에는 숨김), 메모 등 플러그인은 카테고리 성격대로 묶음 끝에 붙인다.
const GROUPS: { key: string; ids: string[]; categories: string[] }[] = [
  { key: 'communication', ids: ['mail', 'chat', 'calendar', 'meetings', 'contacts'], categories: ['communication'] },
  { key: 'content', ids: ['files', 'wiki', 'board', 'notes'], categories: ['collaboration', 'content'] },
  { key: 'work', ids: ['tasks', 'git', 'ai'], categories: ['ai', 'system'] },
  { key: 'plugin', ids: [], categories: [] },
  { key: 'system', ids: ['admin'], categories: [] },
]

function groupOf(id: string, category?: string): string {
  const byId = GROUPS.find(g => g.ids.includes(id))
  if (byId) return byId.key
  const byCat = GROUPS.find(g => category && g.categories.includes(category))
  return byCat ? byCat.key : 'plugin'
}

function itemRank(id: string, groupKey: string): number {
  const ids = GROUPS.find(g => g.key === groupKey)?.ids ?? []
  const i = ids.indexOf(id)
  return i === -1 ? ids.length : i
}

/**
 * 묶음 안 순서 — 내장은 GROUPS 순서, 그 뒤 플러그인은 manifest order(작을수록 위) → order 없음.
 * 같으면 서버 목록 순서(폴더 이름순) 그대로(안정 정렬).
 */
export function compareNavItems(a: { id: string; order?: number | null }, b: { id: string; order?: number | null }, groupKey: string): number {
  const r = itemRank(a.id, groupKey) - itemRank(b.id, groupKey)
  if (r) return r
  const oa = typeof a.order === 'number' ? a.order : Infinity
  const ob = typeof b.order === 'number' ? b.order : Infinity
  return oa === ob ? 0 : oa < ob ? -1 : 1
}

/**
 * 최상단 단독 항목: 대시보드 — name 은 getter(읽을 때마다 현재 로캘). 시안 표기 "홈"(레일·상단바 "워크스페이스 / 홈"·모바일 제목).
 * Vue 판과 같이 한 객체를 계속 쓴다(useNav().home 과 같은 객체).
 */
export const navHome: NavItem = { id: 'dashboard', get name() { return i18n.t('shell.tab.home') }, route: '/', icon: 'home', matchExact: true }

export function useNav() {
  const { enabledModules } = usePlatform()
  const { user } = useAuth()
  // 로캘이 바뀌면 다시 계산되도록 컴포넌트용 t 를 쓴다(Vue 는 useNuxtApp().$i18n)
  const { t, te } = useI18n()
  const isAdmin = !!user?.is_admin

  const groups = useMemo<NavGroup[]>(() => {
    // 내장 모듈 이름은 서버 registry(한국어 고정) 대신 i18n nav.<id> — 시안 표기(작업·회의)와 로캘을 따른다. 플러그인은 서버 이름 그대로.
    const moduleName = (m: { id: string; name: string; type?: string }) => (m.type !== 'plugin' && te(`nav.${m.id}`) ? t(`nav.${m.id}`) : m.name)
    const byGroup: Record<string, Array<NavItem & { order?: number | null }>> = {}
    // 메일 모듈이 꺼져 있으면 연락처가 갈 곳이 없으니 레일에 그대로 둔다
    const hasMail = enabledModules.some(m => m.id === 'mail')
    for (const mod of enabledModules) {
      if (NAV_EXCLUDED.has(mod.id)) continue
      const key = groupOf(mod.id, mod.category)
      ;(byGroup[key] ||= []).push({
        id: mod.id, name: moduleName(mod), route: mod.route, icon: moduleIconName(mod.icon),
        ...(mod.type === 'plugin' ? { order: mod.order ?? null } : {}),
        ...(hasMail && RAIL_HIDDEN.has(mod.id) ? { rail: false } : {}),
        ...(ALSO_MATCH[mod.id] ? { alsoMatch: ALSO_MATCH[mod.id] } : {}),
      })
    }

    // 관리(admin)는 맨 끝 단독 묶음(관리자에게만)
    if (isAdmin) {
      ;(byGroup.system ||= []).push({ id: 'admin', name: t('nav.admin'), route: '/admin/dashboard', icon: 'settings', matchPrefix: '/admin' })
    }

    const out: NavGroup[] = []
    for (const { key } of GROUPS) {
      const items = byGroup[key]
      if (!items?.length) continue
      items.sort((a, b) => compareNavItems(a, b, key))
      out.push({ key, label: t(`shell.navGroup.${key}`), items: items.map(({ order: _o, ...it }) => it) })
    }
    return out
  }, [enabledModules, isAdmin, t, te])

  // 모바일 탭바용 평면 목록(홈 + 모든 그룹 항목) — 앞 4개는 탭, 나머지는 '전체'
  const flat = useMemo<NavItem[]>(() => [navHome, ...groups.flatMap(g => g.items)], [groups])

  // 레일(데스크톱 사이드바)용 — rail:false 항목을 빼고 빈 묶음은 버린다
  const railGroups = useMemo<NavGroup[]>(() => groups
    .map(g => ({ ...g, items: g.items.filter(i => i.rail !== false) }))
    .filter(g => g.items.length), [groups])

  return { home: navHome, groups, railGroups, flat }
}
