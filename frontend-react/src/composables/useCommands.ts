/**
 * Ctrl+K `>` 명령(시안 X2·10-6 ②): 새 일정 · 새 문서 · 새 작업 · 상태 · 방해 금지 · 테마 · 단축키 · 로그아웃.
 * 첫 화면에는 앞의 3개만 보이고, `>` 를 치면 전부. 모듈이 꺼져 있으면 그 명령은 숨긴다.
 * (Vue 판 composables/useCommands.ts 그대로)
 *
 * "새 일정/새 문서/새 작업"은 해당 모듈로 이동만 한다 — 모듈 화면에서 바로 작성 폼을 여는 진입(쿼리 등)은
 * 모듈 작업 때 연결한다(백엔드/모듈 갭 보고).
 *
 * React: const { all, primary, search } = useCommands()   — all·primary 는 배열 값
 */
import { useCallback, useMemo } from 'react'
import { usePlatform } from '~/composables/usePlatform'
import { useAuth } from '~/composables/useAuth'
import { useMyStatus } from '~/composables/useMyStatus'
import { openShortcuts } from '~/composables/useShell'
import { useColorMode } from '~/composables/useColorMode'
import { addToast } from '~/composables/useToast'
import { navigateTo } from '~/lib/router'
import { useI18n } from '~/i18n'

export interface Command {
  id: string
  label: string
  icon: string
  keys?: string[]
  /** 검색어 매칭용 별칭 */
  aliases?: string[]
  run: () => unknown
}

export function useCommands() {
  const { isModuleEnabled } = usePlatform()
  const { user, logout } = useAuth()
  const { setPresence, presence } = useMyStatus()
  const colorMode = useColorMode()
  const { t } = useI18n()
  const isAdmin = !!user?.is_admin
  const calendarOn = isModuleEnabled('calendar')
  const wikiOn = isModuleEnabled('wiki')
  const tasksOn = isModuleEnabled('tasks')

  const all = useMemo<Command[]>(() => {
    const list: Command[] = []
    if (calendarOn) list.push({ id: 'new-event', label: t('shell.cmd.newEvent'), icon: 'calendar', aliases: ['일정', 'event'], run: () => navigateTo('/calendar') })
    if (wikiOn) list.push({ id: 'new-doc', label: t('shell.cmd.newDoc'), icon: 'book-open', aliases: ['위키', '문서', 'wiki'], run: () => navigateTo('/wiki') })
    if (tasksOn) list.push({ id: 'new-task', label: t('shell.cmd.newTask'), icon: 'check-square', aliases: ['작업', 'task'], run: () => navigateTo('/tasks') })
    list.push({
      id: 'status', label: presence === 'away' ? t('shell.cmd.statusOnline') : t('shell.cmd.statusAway'), icon: 'smile', aliases: ['상태', 'status', '자리'],
      run: () => setPresence(presence === 'away' ? 'online' : 'away'),
    })
    list.push({
      id: 'dnd', label: presence === 'dnd' ? t('shell.cmd.dndOff') : t('ui.status.dnd'), icon: 'bell-off', aliases: ['dnd', '방해'],
      run: () => setPresence(presence === 'dnd' ? 'online' : 'dnd'),
    })
    list.push({
      id: 'theme', label: t('shell.cmd.toggleTheme'), icon: colorMode.value === 'dark' ? 'sun' : 'moon', aliases: ['다크', '라이트', 'theme'],
      run: () => { colorMode.setPreference(colorMode.value === 'dark' ? 'light' : 'dark') },
    })
    list.push({ id: 'shortcuts', label: t('shell.userMenu.shortcuts'), icon: 'keyboard', keys: ['Ctrl', '/'], aliases: ['키보드', 'shortcut'], run: () => openShortcuts() })
    list.push({ id: 'settings', label: t('shell.cmd.openSettings'), icon: 'settings', aliases: ['프로필', 'settings'], run: () => navigateTo('/settings') })
    if (isAdmin) list.push({ id: 'admin', label: t('shell.userMenu.adminConsole'), icon: 'shield', aliases: ['admin', '관리'], run: () => navigateTo('/admin') })
    list.push({ id: 'logout', label: t('auth.logout'), icon: 'log-out', aliases: ['logout', '나가기'], run: async () => { await logout(); addToast('info', t('shell.cmd.loggedOut')) } })
    return list
    // colorMode 는 렌더마다 새 객체 — 쓰는 값(value·setPreference)만 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, calendarOn, presence, setPresence, colorMode.value, isAdmin, logout])

  /** 첫 화면용 3개 */
  const primary = useMemo(() => all.slice(0, 3), [all])

  const search = useCallback((q: string) => {
    const s = q.trim().toLowerCase()
    if (!s) return all
    return all.filter(c => c.label.toLowerCase().includes(s) || c.aliases?.some(a => a.toLowerCase().includes(s)))
  }, [all])

  return { all, primary, search }
}
