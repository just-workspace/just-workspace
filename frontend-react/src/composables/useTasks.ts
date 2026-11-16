/**
 * 작업 목록·쓰기.
 *
 * 호출할 때마다 목록 상태(tasks·total·loading·error)를 새로 생성하며, 담당자 후보·프로젝트/태그 목록만 모듈 싱글턴이다:
 * 목록 상태는 hook 을 호출한 컴포넌트의 지역 상태, 후보·facets 는 tasksStore(전역).
 *
 * React: const { tasks, total, loading, error, fetchTasks, upsertLocal, removeLocal, createTask, …, taskUsers, facets } = useTasks()
 * 컴포넌트 외부: tasksStore.getState() · loadUsers() · loadFacets() · rememberFacets() · createTask() 등 직접 import.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'

export interface Task {
  id: string
  /** 생성자 */
  user_id?: string
  title: string
  description: string | null
  due_date: string | null
  priority: 'low' | 'medium' | 'high' | 'urgent'
  status: 'todo' | 'in_progress' | 'review' | 'done'
  sort_order: number
  parent_id: string | null
  subtask_count: number
  completed_subtask_count: number
  created_at: string
  updated_at: string
  /** 담당자(없으면 null) — 변경은 생성자만 가능(서버 403) */
  assignee_id?: string | null
  assignee_name?: string | null
  tags?: string[]
  project?: string | null
}

/** 담당자 후보(워크스페이스 사용자 — GET /api/chat/users) */
export interface TaskUser {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

interface TaskListResponse {
  tasks: Task[]
  total: number
}

export interface TaskCreateData {
  title: string
  description?: string | null
  due_date?: string | null
  priority?: Task['priority']
  status?: Task['status']
  parent_id?: string | null
  /** null = 담당 해제 */
  assignee_id?: string | null
  tags?: string[]
  /** null = 프로젝트 없음 */
  project?: string | null
}

export interface TaskFilters {
  /** 쉼표로 복수 지정(todo,review) */
  status?: string | null
  priority?: string | null
  sort_by?: string
  sort_dir?: string
  page?: number
  limit?: number
  parent_id?: string | null
  /** me | none | 사용자 id */
  assignee?: string | null
  tag?: string | null
  project?: string | null
}

// 담당자 후보·프로젝트/태그 목록은 페이지를 이동해도 1회만 조회한다
export const tasksStore = createStore<{ taskUsers: TaskUser[]; facets: { projects: string[]; tags: string[] } }>()(() => ({
  taskUsers: [],
  facets: { projects: [], tags: [] },
}))
let _usersLoaded: Promise<void> | null = null

/** 담당자 후보(워크스페이스 사용자) — 최초 1회 */
export function loadUsers(force = false) {
  if (_usersLoaded && !force) return _usersLoaded
  _usersLoaded = $fetch<TaskUser[]>('/api/chat/users')
    .then((list) => { tasksStore.setState({ taskUsers: list }) })
    .catch(() => { _usersLoaded = null })
  return _usersLoaded
}

/** 프로젝트·태그 자동완성(GET /api/tasks/facets) */
export async function loadFacets() {
  try { tasksStore.setState({ facets: await $fetch<{ projects: string[]; tags: string[] }>('/api/tasks/facets') }) }
  catch { /* 자동완성 목록만 빈 상태 */ }
}

/** 방금 사용한 태그·프로젝트를 자동완성에 즉시 추가한다(서버 재조회 없음) */
export function rememberFacets(task: Pick<Task, 'tags' | 'project'>) {
  const cur = tasksStore.getState().facets
  const tags = new Set(cur.tags)
  const projects = new Set(cur.projects)
  for (const tg of task.tags || []) tags.add(tg)
  if (task.project) projects.add(task.project)
  tasksStore.setState({ facets: { projects: [...projects].sort(), tags: [...tags].sort() } })
}

export async function fetchSubtasks(parentId: string): Promise<Task[]> {
  const data = await $fetch<TaskListResponse>(`/api/tasks/${parentId}/subtasks?limit=200&sort_dir=asc`)
  return data.tasks
}

export async function createTask(data: TaskCreateData): Promise<Task> {
  const result = await $fetch<Task>('/api/tasks/', {
    method: 'POST',
    body: data,
  })
  return result
}

export async function updateTask(id: string, data: Partial<TaskCreateData>): Promise<Task> {
  const result = await $fetch<Task>(`/api/tasks/${id}`, {
    method: 'PATCH',
    body: data,
  })
  return result
}

export async function deleteTask(id: string): Promise<void> {
  await $fetch(`/api/tasks/${id}`, { method: 'DELETE' })
}

export async function toggleTask(id: string): Promise<Task> {
  const result = await $fetch<Task>(`/api/tasks/${id}/toggle`, {
    method: 'POST',
  })
  return result
}

interface ListState { tasks: Task[]; total: number; loading: boolean; error: boolean }

/** 목록 상태 변경 규칙(순수 — 테스트 대상): upsertLocal·removeLocal */
export function upsertInto(s: ListState, task: Task): ListState {
  const i = s.tasks.findIndex(x => x.id === task.id)
  if (i >= 0) { const tasks = [...s.tasks]; tasks.splice(i, 1, task); return { ...s, tasks } }
  if (!task.parent_id) return { ...s, tasks: [task, ...s.tasks], total: s.total + 1 }
  return s
}
export function removeFrom(s: ListState, id: string): ListState {
  const i = s.tasks.findIndex(x => x.id === id)
  if (i < 0) return s
  const tasks = [...s.tasks]; tasks.splice(i, 1)
  return { ...s, tasks, total: Math.max(0, s.total - 1) }
}

export function useTasks() {
  const [list, setList] = useState<ListState>({ tasks: [], total: 0, loading: false, error: false })
  const taskUsers = useStore(tasksStore, s => s.taskUsers)
  const facets = useStore(tasksStore, s => s.facets)

  // 필터 칩을 활성화한 직후 비활성화하면 지연 도착한 이전 응답("진행 중만")이 현재 목록을 덮어썼다 — 마지막 요청만 반영한다
  const fetchSeq = useRef(0)
  const fetchTasks = useCallback(async (filters: TaskFilters = {}) => {
    const my = ++fetchSeq.current
    setList(s => ({ ...s, loading: true, error: false }))
    try {
      const params = new URLSearchParams()
      if (filters.status) params.set('status', filters.status)
      if (filters.priority) params.set('priority', filters.priority)
      if (filters.sort_by) params.set('sort_by', filters.sort_by)
      if (filters.sort_dir) params.set('sort_dir', filters.sort_dir)
      if (filters.page !== undefined) params.set('page', String(filters.page))
      if (filters.limit !== undefined) params.set('limit', String(filters.limit))
      if (filters.parent_id) params.set('parent_id', filters.parent_id)
      if (filters.assignee) params.set('assignee', filters.assignee)
      if (filters.tag) params.set('tag', filters.tag)
      if (filters.project) params.set('project', filters.project)
      const qs = params.toString()
      const data = await $fetch<TaskListResponse>(`/api/tasks/${qs ? `?${qs}` : ''}`)
      if (my !== fetchSeq.current) return
      setList(s => ({ ...s, tasks: data.tasks, total: data.total, loading: false }))
    } catch {
      if (my !== fetchSeq.current) return
      // 목록 조회 실패를 빈 목록과 구분한다(실패가 "비어 있음"으로 표시되지 않도록)
      setList(s => ({ ...s, tasks: [], total: 0, error: true, loading: false }))
    }
  }, [])

  /** 패널·행에서 변경한 작업을 재조회 없이 목록에 반영(낙관적 갱신 후 서버 응답으로 덮어쓰기) */
  const upsertLocal = useCallback((task: Task) => { setList(s => upsertInto(s, task)) }, [])
  const removeLocal = useCallback((id: string) => { setList(s => removeFrom(s, id)) }, [])

  return useMemo(() => ({
    taskUsers,
    facets,
    loadUsers,
    loadFacets,
    rememberFacets,
    tasks: list.tasks,
    total: list.total,
    loading: list.loading,
    error: list.error,
    upsertLocal,
    removeLocal,
    fetchTasks,
    fetchSubtasks,
    createTask,
    updateTask,
    deleteTask,
    toggleTask,
  }), [taskUsers, facets, list, upsertLocal, removeLocal, fetchTasks])
}
