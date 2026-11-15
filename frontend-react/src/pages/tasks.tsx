/**
 * 작업
 *  데스크톱: 머리(작업 24/700 + 집계 · 목록/보드 세그먼트) → 칩 줄(진행 중 · 우선순위 높음 · + 필터 · 묶기/정렬 ▾)
 *            → 빠른 입력 44 → 마감 묶음 목록(행 48) + 오른쪽 상세 패널 360(작업을 고르면).
 *  모바일: 칩 줄(36) + ⋯(묶기·정렬) → 목록(행 60, 묶음 머리 32) + FAB(새 작업 시트) / 작업을 고르면 전체 화면 상세(탭바 숨김).
 * 좌 200 aside 는 폐지. 데스크톱 셸(Electron)이 넘기는 ?status=·?priority= 는 칩 상태로 받는다.
 * 선택한 작업은 ?task=<id> 로 URL 에 남겨 링크 복사·뒤로 가기가 된다.
 * 필터는 서버로(GET /api/tasks/?assignee=&tag=&project=&status=&priority=) — "마감 지남"만 화면에서 거른다.
 * 칩 줄: [나에게 배정](assignee=me) · 진행 중 · 우선순위 높음↑ · + 필터(상태·우선순위·담당자·태그·프로젝트).
 *  "나에게 배정" 칩은 기본 꺼짐 — 담당 기능 전에 만든 작업은 담당자가 비어 있어 켜 두면 안 보이기 때문.
 * 빠른 입력 @담당 → 사용자(resolveAssignee)로 저장. @ 가 없으면 나에게 배정. 못 찾으면 @글자를 제목에 남기고 알린다.
 * 보드 보기는 토글 자리만(다음 단계).
 * 모바일 머리: 목록 = 이 페이지 header, 상세 = LayoutMobileDetailBar — 공용 상단바는 쓰지 않는다(routes.ts ownMobileHeader).
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { useHead } from '~/lib/head'
import { useRoute, useRouter, type RouteLocation } from '~/lib/router'
import { useSharedState } from '~/lib/state'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { useIsMobile } from '~/composables/useIsMobile'
import { useTasks, loadUsers, loadFacets, rememberFacets, tasksStore, type Task, type TaskFilters } from '~/composables/useTasks'
import {
  dueGroupOf, groupTasks, PRIORITY_META, PRIORITY_ORDER, resolveAssignee, STATUS_ORDER, STATUS_META, TASK_GROUP_LABEL_KEY,
  type QuickParse, type TaskGroupBy, type TaskSort, type TaskStatus, type TaskPriority,
} from '~/utils/taskQuick'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSegment } from '~/components/ui/Segment'
import { UiChip } from '~/components/ui/Chip'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiFab } from '~/components/ui/Fab'
import { UiModal } from '~/components/ui/Modal'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { TasksQuickInput, type TasksQuickInputHandle } from '~/components/tasks/TasksQuickInput'
import { TasksRow } from '~/components/tasks/TasksRow'
import { TasksDetail } from '~/components/tasks/TasksDetail'

type MenuKind = 'status' | 'row' | 'filter' | 'group' | 'sort' | 'view'

/** ?status=·?priority= (데스크톱 셸 스마트 목록) → 칩 상태 */
function filtersFromQuery(s: unknown, p: unknown) {
  return {
    overdueOnly: s === 'overdue',
    status: (s && s !== 'all' && s !== 'overdue' ? s as TaskStatus : null),
    priority: ((p as TaskPriority) || null),
  }
}

export default function TasksPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('tasks.heading')} | ${appName}` })   // 화면·내비와 같은 "작업"(옛 키 tasks.title 은 "할 일")
  useBreadcrumb(t('tasks.breadcrumb'))

  const {
    tasks, loading, error, fetchTasks, createTask, updateTask, deleteTask, toggleTask, upsertLocal, removeLocal,
    taskUsers, facets,
  } = useTasks()
  const { user } = useAuth()
  const route = useRoute()
  const router = useRouter()
  const isMobile = useIsMobile()
  const routeRef = useRef<RouteLocation>(route)
  routeRef.current = route

  // ── 필터(칩 줄) ──
  // 데스크톱 셸(Electron) 스마트 목록이 고른 값은 쿼리로 넘어온다(첫 값은 초기 상태로)
  const init = (() => {
    const s = route.query.status, p = route.query.priority
    if (s === undefined && p === undefined) return null
    return filtersFromQuery(s, p)
  })()
  const [statusFilter, setStatusFilter] = useState<TaskStatus | null>(init?.status ?? null)
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | null>(init?.priority ?? null)
  const [overdueOnly, setOverdueOnly] = useState(init?.overdueOnly ?? false)
  /** me | none | 사용자 id */
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)

  const qs = route.query.status, qp = route.query.priority
  const firstQ = useRef(true)
  useEffect(() => {
    if (firstQ.current) { firstQ.current = false; return }
    if (qs === undefined && qp === undefined) return
    const f = filtersFromQuery(qs, qp)
    setOverdueOnly(f.overdueOnly)
    setStatusFilter(f.status)
    setPriorityFilter(f.priority)
  }, [qs, qp])

  const inProgressChip = statusFilter === 'in_progress'
  function setInProgressChip(v: boolean) { setStatusFilter(v ? 'in_progress' : null); if (v) setOverdueOnly(false) }
  const highChip = priorityFilter === 'high'
  function setHighChip(v: boolean) { setPriorityFilter(v ? 'high' : null) }
  const mineChip = assigneeFilter === 'me'
  function setMineChip(v: boolean) { setAssigneeFilter(v ? 'me' : null) }
  const activeFilterCount = [statusFilter, priorityFilter, overdueOnly || null, assigneeFilter, tagFilter, projectFilter].filter(Boolean).length

  // ── 묶기·정렬(기본 마감 · 우선순위) ──
  const [groupBy, setGroupBy] = useState<TaskGroupBy>('due')
  const [sortBy, setSortBy] = useState<TaskSort>('priority')
  const GROUP_LABEL: Record<TaskGroupBy, string> = { due: t('tasks.group.due'), priority: t('tasks.filterPriority'), none: t('common.none') }
  const SORT_LABEL: Record<TaskSort, string> = { priority: t('tasks.filterPriority'), due: t('tasks.group.due'), created: t('tasks.group.createdOrder') }
  // 묶음 머리 글자(groupTasks 의 label 은 한국어 기본값이라 key 로 번역)
  function groupLabel(g: { key: string; label: string }) {
    const k = TASK_GROUP_LABEL_KEY[g.key]
    return k ? t(k) : g.label
  }

  // 서버가 이미 걸렀다. 낙관적 갱신으로 조건에서 벗어난 행이 남지 않게 같은 조건을 한 번 더 본다(+ 마감 지남은 여기서만)
  const visible = tasks.filter((x) => {
    if (statusFilter && x.status !== statusFilter) return false
    if (priorityFilter && x.priority !== priorityFilter) return false
    if (overdueOnly && dueGroupOf(x) !== 'overdue') return false
    const a = assigneeFilter
    if (a === 'me' && x.assignee_id !== user?.id) return false
    if (a === 'none' && x.assignee_id) return false
    if (a && a !== 'me' && a !== 'none' && x.assignee_id !== a) return false
    if (tagFilter && !(x.tags || []).includes(tagFilter)) return false
    if (projectFilter && x.project !== projectFilter) return false
    return true
  })
  const groups = groupTasks(visible, groupBy, sortBy)

  // 머리 집계(시안 "나에게 배정 12 · 마감 지남 1 · 오늘 2") — 나에게 배정 = 내가 담당인 안 끝난 작업.
  // 필터를 건 목록으로 세면 숫자가 흔들리므로 필터 없이 읽은 목록으로 센 값을 들고 있는다.
  const [counts, setCounts] = useState({ open: 0, overdue: 0, today: 0 })
  const serverFilters = useMemo<TaskFilters>(() => ({
    status: statusFilter,
    priority: priorityFilter,
    assignee: assigneeFilter,
    tag: tagFilter,
    project: projectFilter,
  }), [statusFilter, priorityFilter, assigneeFilter, tagFilter, projectFilter])
  const unfiltered = !Object.values(serverFilters).some(Boolean)
  const unfilteredRef = useRef(unfiltered)
  unfilteredRef.current = unfiltered
  useEffect(() => {
    if (!unfilteredRef.current) return
    let open = 0, overdue = 0, today = 0
    for (const x of tasks) {
      const g = dueGroupOf(x)
      if (x.status !== 'done' && x.assignee_id === user?.id) open++
      if (g === 'overdue') overdue++
      if (g === 'today') today++
    }
    setCounts({ open, overdue, today })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks])

  const filtersRef = useRef(serverFilters)
  filtersRef.current = serverFilters
  function load() {
    return fetchTasks({ sort_by: 'created_at', sort_dir: 'desc', limit: 200, ...filtersRef.current })
  }
  useEffect(() => { void loadUsers(); void loadFacets() }, [])
  // onMounted(load) + watch(serverFilters, load)
  const filtersKey = JSON.stringify(serverFilters)
  useEffect(() => { void load() }, [filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 선택(?task=) ──
  const selectedId = (route.query.task as string) || null
  const selected = tasks.find(x => x.id === selectedId)
  function select(id: string | null) {
    const q = { ...routeRef.current.query }
    if (id) q.task = id
    else delete q.task
    // 모바일은 상세가 화면 전환이라 뒤로 가기로 닫히게 push, 데스크톱 패널 전환은 replace
    const curSel = (routeRef.current.query.task as string) || null
    if (isMobile && id && !curSel) void router.push({ query: q })
    else void router.replace({ query: q })
  }
  // 링크로 들어왔는데 목록(상위 200)에 없으면 한 건 불러온다
  const hasSelected = !!selected
  useEffect(() => {
    if (!selectedId || loading || hasSelected) return
    void (async () => {
      try { upsertLocal(await $fetch<Task>(`/api/tasks/${selectedId}`)) }
      catch { select(null) }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, loading])

  const [, setDetailOpen] = useSharedState<boolean>('mobile-detail-open', () => false)
  useEffect(() => () => { setDetailOpen(false) }, [setDetailOpen])

  // ── 쓰기 ──
  const [creating, setCreating] = useState(false)
  const quickRef = useRef<TasksQuickInputHandle | null>(null)
  const [showNewSheet, setShowNewSheet] = useState(false)

  async function quickCreate(p: QuickParse) {
    setCreating(true)
    try {
      // @담당 → 사용자. @ 가 없으면 나에게 배정. 못 찾으면 @글자를 제목에 남기고 담당은 비운다
      let assigneeId: string | null = user?.id ?? null
      let title = p.title
      let unresolved = ''
      if (p.assignee) {
        await loadUsers()
        const me = user
        const users = tasksStore.getState().taskUsers
        const pool = me && !users.some(u => u.id === me.id)
          ? [...users, { id: me.id, username: me.username, display_name: me.display_name ?? null, avatar_url: null }]
          : users
        const found = resolveAssignee(p.assignee, pool)
        if (found) assigneeId = found.id
        else { assigneeId = null; title = p.titleWithAssignee; unresolved = p.assignee }
      }
      if (!title) title = p.titleWithAssignee
      const created = await createTask({
        title,
        priority: p.priority ?? 'medium',
        due_date: p.due ?? undefined,
        assignee_id: assigneeId,
      })
      upsertLocal(created)
      quickRef.current?.clear()
      setShowNewSheet(false)
      addToast('success', t('tasks.toast.added', { title: created.title }))
      if (unresolved) addToast('info', t('tasks.assign.notFound', { name: unresolved }))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('tasks.toast.addFailed'))
    } finally {
      setCreating(false)
    }
  }

  async function patch(task: Task, data: Partial<Task>) {
    const before = { ...task }
    upsertLocal({ ...task, ...data } as Task)
    // assignee_name 은 화면 즉시 반영용 — 서버엔 보내지 않는다
    const { assignee_name: _n, ...body } = data
    try {
      const saved = await updateTask(task.id, body as any)
      upsertLocal(saved)
      if (body.tags || body.project) rememberFacets(saved)
    } catch (e: any) {
      upsertLocal(before)
      addToast('error', e?.data?.detail || t('tasks.toast.updateFailed'))
    }
  }

  async function toggle(task: Task) {
    const before = { ...task }
    upsertLocal({ ...task, status: task.status === 'done' ? 'todo' : 'done' })
    try { upsertLocal(await toggleTask(task.id)) }
    catch { upsertLocal(before); addToast('error', t('tasks.toast.statusFailed')) }
  }

  async function remove(task: Task) {
    if (!await confirmBox(t('tasks.confirm.delete', { title: task.title }), { danger: true, confirmLabel: t('common.delete') })) return
    try {
      await deleteTask(task.id)
      if (((routeRef.current.query.task as string) || null) === task.id) select(null)
      removeLocal(task.id)
    } catch { addToast('error', t('tasks.toast.deleteFailed')) }
  }

  async function duplicate(task: Task) {
    try {
      const copy = await createTask({
        title: t('tasks.copySuffix', { title: task.title }),
        description: task.description ?? undefined,
        priority: task.priority,
        status: task.status === 'done' ? 'todo' : task.status,
        due_date: task.due_date ? task.due_date.slice(0, 10) : undefined,
        assignee_id: task.assignee_id ?? null,
        tags: task.tags ? [...task.tags] : [],
        project: task.project ?? null,
      })
      upsertLocal(copy)
      select(copy.id)
    } catch { addToast('error', t('tasks.toast.duplicateFailed')) }
  }

  async function refreshTask(id: string) {
    try { upsertLocal(await $fetch<Task>(`/api/tasks/${id}`)) } catch { /* 다음 새로고침에 맞춰진다 */ }
  }

  // ── 메뉴(상태 칩 ▾ · 행 ⋮ · + 필터 · 묶기 · 정렬 · 모바일 ⋯) ──
  const [menu, setMenu] = useState<{ kind: MenuKind; anchor: DOMRect | null; task?: Task } | null>(null)
  function openMenu(kind: MenuKind, anchor: DOMRect | null, task?: Task) { setMenu({ kind, anchor, task }) }
  function anchorOf(e: MouseEvent<HTMLElement>) { return e.currentTarget.getBoundingClientRect() }

  const menuItems: UiMenuItem[] = (() => {
    const m = menu
    if (!m) return []
    if (m.kind === 'status' && m.task) {
      const s = m.task.status
      return STATUS_ORDER.map(k => ({ key: k, label: t(STATUS_META[k].labelKey), radio: true, checked: s === k }))
    }
    if (m.kind === 'row' && m.task) {
      return [
        { key: 'open', label: t('tasks.menu.open'), icon: 'panel-left' },
        { key: 'status', label: m.task.status === 'in_progress' ? t('tasks.menu.backToTodo') : t('tasks.menu.toInProgress'), icon: 'activity', disabled: m.task.status === 'done' },
        { key: 'duplicate', label: t('tasks.menu.duplicate'), icon: 'copy' },
        { key: 'delete', label: t('common.delete'), icon: 'trash', danger: true, separated: true },
      ]
    }
    if (m.kind === 'filter') {
      return [
        { key: 'h-status', label: t('tasks.filterStatus'), heading: true },
        { key: 's:all', label: t('common.all'), radio: true, checked: !statusFilter && !overdueOnly },
        ...STATUS_ORDER.map(k => ({ key: `s:${k}`, label: t(STATUS_META[k].labelKey), radio: true, checked: statusFilter === k })),
        { key: 's:overdue', label: t('tasks.menu.overdue'), radio: true, checked: overdueOnly },
        { key: 'h-pri', label: t('tasks.filterPriority'), heading: true, separated: true },
        { key: 'p:all', label: t('common.all'), radio: true, checked: !priorityFilter },
        ...PRIORITY_ORDER.map(p => ({ key: `p:${p}`, label: `${PRIORITY_META[p].arrow} ${t(PRIORITY_META[p].labelKey)}`, radio: true, checked: priorityFilter === p })),
        { key: 'h-assignee', label: t('tasks.menu.assignee'), heading: true, separated: true },
        { key: 'a:all', label: t('common.all'), radio: true, checked: !assigneeFilter },
        { key: 'a:me', label: t('tasks.assign.toMeShort'), radio: true, checked: assigneeFilter === 'me' },
        { key: 'a:none', label: t('tasks.assign.none'), radio: true, checked: assigneeFilter === 'none' },
        ...taskUsers.filter(u => u.id !== user?.id).map(u => ({ key: `a:${u.id}`, label: u.display_name || u.username, hint: u.username, radio: true, checked: assigneeFilter === u.id })),
        ...(facets.tags.length ? [
          { key: 'h-tag', label: t('tasks.menu.tag'), heading: true, separated: true },
          { key: 't:', label: t('common.all'), radio: true, checked: !tagFilter },
          ...facets.tags.map(tg => ({ key: `t:${tg}`, label: `#${tg}`, radio: true, checked: tagFilter === tg })),
        ] : []),
        ...(facets.projects.length ? [
          { key: 'h-project', label: t('tasks.menu.project'), heading: true, separated: true },
          { key: 'j:', label: t('common.all'), radio: true, checked: !projectFilter },
          ...facets.projects.map(pj => ({ key: `j:${pj}`, label: pj, radio: true, checked: projectFilter === pj })),
        ] : []),
      ]
    }
    if (m.kind === 'group') return (Object.keys(GROUP_LABEL) as TaskGroupBy[]).map(k => ({ key: k, label: GROUP_LABEL[k], radio: true, checked: groupBy === k }))
    if (m.kind === 'sort') return (Object.keys(SORT_LABEL) as TaskSort[]).map(k => ({ key: k, label: SORT_LABEL[k], radio: true, checked: sortBy === k }))
    // 모바일 ⋯ = 묶기 + 정렬
    return [
      { key: 'h-g', label: t('tasks.menu.group'), heading: true },
      ...(Object.keys(GROUP_LABEL) as TaskGroupBy[]).map(k => ({ key: `g:${k}`, label: GROUP_LABEL[k], radio: true, checked: groupBy === k })),
      { key: 'h-s', label: t('tasks.menu.sort'), heading: true, separated: true },
      ...(Object.keys(SORT_LABEL) as TaskSort[]).map(k => ({ key: `o:${k}`, label: SORT_LABEL[k], radio: true, checked: sortBy === k })),
    ]
  })()

  function onMenuSelect(key: string) {
    const m = menu
    if (!m) return
    if (m.kind === 'status' && m.task) { if (key !== m.task.status) void patch(m.task, { status: key as TaskStatus }); return }
    if (m.kind === 'row' && m.task) {
      if (key === 'open') select(m.task.id)
      else if (key === 'status') void patch(m.task, { status: m.task.status === 'in_progress' ? 'todo' : 'in_progress' })
      else if (key === 'duplicate') void duplicate(m.task)
      else if (key === 'delete') void remove(m.task)
      return
    }
    if (m.kind === 'filter') {
      const i = key.indexOf(':')
      const k = key.slice(0, i)
      const v = key.slice(i + 1)
      if (k === 's') {
        setOverdueOnly(v === 'overdue')
        setStatusFilter(v === 'all' || v === 'overdue' ? null : v as TaskStatus)
      } else if (k === 'p') setPriorityFilter(v === 'all' ? null : v as TaskPriority)
      else if (k === 'a') setAssigneeFilter(v === 'all' ? null : v)
      else if (k === 't') setTagFilter(v || null)
      else if (k === 'j') setProjectFilter(v || null)
      return
    }
    if (m.kind === 'group') { setGroupBy(key as TaskGroupBy); return }
    if (m.kind === 'sort') { setSortBy(key as TaskSort); return }
    const [k, v] = key.split(':')
    if (k === 'g') setGroupBy(v as TaskGroupBy)
    if (k === 'o') setSortBy(v as TaskSort)
  }

  function clearFilters() {
    setStatusFilter(null)
    setPriorityFilter(null)
    setOverdueOnly(false)
    setAssigneeFilter(null)
    setTagFilter(null)
    setProjectFilter(null)
  }

  const [viewMode, setViewMode] = useState<string | number | null>('list')
  const viewItems = [
    { value: 'list', label: t('tasks.view.list') },
    // 보드 보기는 토글 자리만(다음 단계)
    { value: 'board', label: t('tasks.view.board'), disabled: true, ariaLabel: t('tasks.view.boardSoon') },
  ]

  // 모바일 상세가 열리면 탭바 숨김(LayoutMobileDetailBar 가 켠다) — 닫힐 때 원복
  useEffect(() => { if (!selectedId || !isMobile) setDetailOpen(false) }, [selectedId, isMobile, setDetailOpen])

  return (
    <div className="relative flex h-full overflow-hidden">
      {/* 목록 */}
      <div
        className="flex min-w-0 flex-1 flex-col overflow-hidden md:px-7 md:pt-6"
        style={isMobile && selected ? { display: 'none' } : undefined}
      >
        {/* 머리(모바일, 56 · 제목 "작업" 18/600 + "나에게 배정 n" · ⋯ 묶기·정렬) — 공용 상단바 대신 */}
        <header className="flex h-14 shrink-0 items-center border-b border-border pl-4 pr-1 md:hidden">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold leading-6 text-foreground">{t('nav.tasks')}</h1>
            <p className="truncate text-xs text-muted-foreground">{t('tasks.counts.assigned')} <span className="font-mono">{counts.open}</span></p>
          </div>
          <UiIconButton label={t('tasks.chip.groupSort')} icon="more-horizontal" size="lg" noTooltip className="shrink-0" onClick={() => openMenu('view', null)} />
        </header>

        {/* 머리(데스크톱) */}
        <div className="mb-3.5 hidden items-end gap-3 md:flex">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">{t('tasks.heading')}</h1>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              {t('tasks.counts.assigned')} <span className="font-mono">{counts.open}</span>
              {' · '}{t('tasks.counts.overdue')} <span className={cn('font-mono', counts.overdue ? 'text-danger' : '')}>{counts.overdue}</span>
              {' · '}{t('common.today')} <span className="font-mono">{counts.today}</span>
            </p>
          </div>
          <UiSegment modelValue={viewMode} onUpdateModelValue={setViewMode} items={viewItems} ariaLabel={t('tasks.view.label')} />
        </div>

        {/* 칩 줄(데스크톱 32 · 모바일 36, 같은 줄 하나) */}
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap px-4 py-2 scrollbar-none md:mb-2.5 md:overflow-visible md:px-0 md:py-0">
          <UiChip modelValue={mineChip} onUpdateModelValue={setMineChip} label={t('tasks.counts.assigned')} size={isMobile ? 'lg' : 'md'} />
          <UiChip modelValue={inProgressChip} onUpdateModelValue={setInProgressChip} label={t('tasks.statusInProgress')} size={isMobile ? 'lg' : 'md'} />
          <UiChip modelValue={highChip} onUpdateModelValue={setHighChip} label={t('tasks.chip.highPriority')} size={isMobile ? 'lg' : 'md'} className="max-md:hidden" />
          {!isMobile
            ? (
              <UiChip
                variant="add"
                label={t('tasks.chip.filterMore')}
                count={activeFilterCount || undefined}
                onClick={e => openMenu('filter', anchorOf(e))}
              />
            )
            : (
              <UiChip
                variant="static"
                label={t('tasks.chip.filter')}
                size="lg"
                count={activeFilterCount || undefined}
                onClick={() => openMenu('filter', null)}
              />
            )}
          {activeFilterCount > 0 && (
            <button
              type="button"
              className="h-8 shrink-0 px-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={clearFilters}
            >{t('tasks.chip.clearFilters')}</button>
          )}
          <span className="flex-1" />
          <div className="hidden items-center text-xs text-muted-foreground md:flex">
            <button type="button" aria-haspopup="menu" className="inline-flex h-8 items-center gap-1 rounded-sm px-1.5 hover:text-foreground" onClick={e => openMenu('group', anchorOf(e))}>
              {t('tasks.chip.groupBy', { label: GROUP_LABEL[groupBy] })}<UiIcon name="chevron-down" className="h-3 w-3" />
            </button>
            <span aria-hidden="true">·</span>
            <button type="button" aria-haspopup="menu" className="inline-flex h-8 items-center gap-1 rounded-sm px-1.5 hover:text-foreground" onClick={e => openMenu('sort', anchorOf(e))}>
              {t('tasks.chip.sortBy', { label: SORT_LABEL[sortBy] })}<UiIcon name="chevron-down" className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* 빠른 입력(데스크톱). 모바일은 FAB → 시트 */}
        <TasksQuickInput ref={quickRef} className="hidden shrink-0 md:flex" busy={creating} onSubmit={quickCreate} />

        {/* 목록 */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-24 md:mt-2.5 md:pb-6">
          {loading && !tasks.length
            ? <UiSkeleton preset="list" rows={6} className="px-4 md:px-0" />
            : error
              ? (
                <UiErrorTile
                  placement="panel"
                  className="mx-4 mt-6 md:mx-0"
                  title={t('tasks.list.loadError')}
                  detail={t('tasks.list.loadErrorDetail')}
                  onRetry={() => void load()}
                />
              )
              : !tasks.length
                ? (
                  <UiEmptyState
                    className="mx-4 mt-6 md:mx-0"
                    icon="check-square"
                    title={t('tasks.list.empty')}
                    description={isMobile ? t('tasks.list.emptyMobile') : t('tasks.list.emptyDesktop')}
                  />
                )
                : !groups.length
                  ? (
                    <UiEmptyState
                      variant="inline"
                      className="mx-4 md:mx-0"
                      title={t('tasks.list.noMatch')}
                      actionLabel={t('tasks.chip.clearFilters')}
                      onAction={clearFilters}
                    />
                  )
                  : groups.map(g => (
                    <section key={g.key} aria-label={`${groupLabel(g)} ${g.items.length}`}>
                      <h2
                        className={cn(
                          'flex items-center gap-2 text-xs font-semibold max-md:sticky max-md:top-0 max-md:z-[1] max-md:h-8 max-md:bg-card max-md:px-4 md:h-9 md:px-1',
                          g.tone === 'danger' ? 'text-danger' : 'text-foreground max-md:text-muted-foreground',
                        )}
                      >
                        {groupLabel(g)}
                        <span className="font-mono font-medium text-muted-foreground">{g.items.length}</span>
                      </h2>
                      {g.items.map(task => (
                        <TasksRow
                          key={task.id}
                          task={task}
                          selected={task.id === selectedId}
                          onSelect={() => select(task.id)}
                          onToggle={() => void toggle(task)}
                          onStatus={a => openMenu('status', a, task)}
                          onMenu={a => openMenu('row', isMobile ? null : a, task)}
                        />
                      ))}
                    </section>
                  ))}
        </div>
      </div>

      {/* 상세: 데스크톱 패널 360(768~1023 은 덮는 패널) / 모바일 전체 화면 */}
      {selected && (
        <aside
          aria-label={t('tasks.detailLabel')}
          className="flex w-full flex-col md:absolute md:inset-y-0 md:right-0 md:z-drawer md:w-[360px] md:border-l md:border-border md:shadow-lg lg:static lg:shadow-none"
        >
          {isMobile && (
            <LayoutMobileDetailBar
              title={t('tasks.task')}
              subtitle={t('tasks.breadcrumb')}
              backTo="/tasks"
              backLabel={t('tasks.backToList')}
              actions={<UiIconButton label={t('common.more')} icon="more-horizontal" size="lg" noTooltip onClick={() => openMenu('row', null, selected)} />}
            />
          )}
          <TasksDetail
            key={selected.id}
            task={selected}
            className="min-h-0 flex-1"
            onPatch={d => void patch(selected, d as Partial<Task>)}
            onClose={() => select(null)}
            onDuplicate={() => void duplicate(selected)}
            onRemove={() => void remove(selected)}
            onSubtasksChanged={() => void refreshTask(selected.id)}
          />
        </aside>
      )}

      {/* 모바일 FAB → 새 작업 시트 */}
      {!selected && <UiFab label={t('tasks.new.title')} onClick={() => setShowNewSheet(true)} />}
      {showNewSheet && (
        <UiModal title={t('tasks.new.title')} onClose={() => setShowNewSheet(false)}>
          <div className="flex flex-col gap-2 pb-2">
            <TasksQuickInput size="lg" autofocus busy={creating} onSubmit={quickCreate} />
            <p className="text-xs text-muted-foreground">{t('tasks.new.hint')}</p>
          </div>
        </UiModal>
      )}

      {menu && (
        <UiMenu
          dense
          width={220}
          items={menuItems}
          anchor={menu.anchor}
          title={menu.kind === 'filter' ? t('tasks.chip.filter') : menu.kind === 'status' ? t('tasks.filterStatus') : menu.kind === 'view' ? t('tasks.chip.groupSort') : menu.task?.title ?? t('tasks.menu.sort')}
          align={menu.kind === 'status' || menu.kind === 'filter' ? 'start' : 'end'}
          onSelect={onMenuSelect}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
