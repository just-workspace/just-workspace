// Vue 원본: frontend/composables/useChannelTabs.ts
// 채널 탭(시안 ChannelTabs · 11 답 D6) — 메시지 · 파일 · 위키 + 더보기(회의 · 작업 · 탭 관리).
// 서버: /api/chat/channels/{id}/tabs|files|meetings|tasks (backend app/chat/tabs.py). 채팅 상태(useChat)와는 따로 둔다.
// 상태 없는 요청 묶음이라 store 없이 모듈 함수 + 같은 이름의 hook(useChannelTabs)으로 둔다.
import { $fetch } from '~/lib/api'

export type ChannelTabKey = 'messages' | 'files' | 'wiki' | 'meetings' | 'tasks'

export interface ChannelFolder {
  owner_id: string
  owner_name: string
  /** 내 폴더일 때만 가상경로(my/..) */
  path: string | null
  /** "내 파일" 아래 경로 조각 */
  segments: string[]
  share_id: string | null
  mine: boolean
  accessible: boolean
  can_write: boolean
}

/** 메시지 뒤에 오는 탭(메시지는 늘 처음 · 고정) */
export type ChannelTabMovable = 'files' | 'wiki' | 'meetings' | 'tasks'

export interface ChannelTabLayoutItem { key: ChannelTabMovable; visible: boolean }

export interface ChannelTabsSummary {
  files_count: number
  folder: ChannelFolder | null
  /** 예전 페이지 연결(있으면) */
  wiki: { id: string; title: string; space_id: string } | null
  /** 위키 탭이 보여 주는 스페이스(R4 — 스페이스 단위 연결) · pages = 페이지 수 */
  wiki_space?: { id: string; name: string; pages: number } | null
  meetings_upcoming: number
  tasks_open: number
  /** 탭 순서·끄기(R4) — 채널 멤버 모두에게 같다 */
  layout?: ChannelTabLayoutItem[]
  can_manage: boolean
}

export interface ChannelFileItem {
  name: string
  size: number
  source: 'message' | 'folder'
  who: string
  at: string | null
  message_id: string | null
  url: string | null
  /** 폴더 파일의 경로 — 내 폴더면 my/.., 아니면 shared-with-me/<공유>/.. */
  path: string | null
}

export interface ChannelMeetingItem {
  id: string
  title: string
  status: string
  scheduled_at: string | null
  duration_minutes: number | null
  started_at?: string | null
  ended_at?: string | null
  /** 지난 회의 실제 길이(분) */
  actual_minutes?: number | null
  host_name: string
  is_host?: boolean
  join_path: string
}

export interface ChannelTaskItem {
  id: string
  title: string
  status: string
  priority: string
  due_date: string | null
  assignee_name: string | null
  assignee_id?: string | null
  owner_name: string
  can_open: boolean
}

export type ChannelTaskFilter = 'open' | 'mine' | 'done'
export interface ChannelTaskCounts { open: number; mine: number; done: number }

const base = (id: string) => `/api/chat/channels/${encodeURIComponent(id)}`

export async function fetchSummary(channelId: string) {
  return await $fetch<ChannelTabsSummary>(`${base(channelId)}/tabs`)
}
export interface ChannelTabsUpdate {
  folder_path?: string | null
  wiki_page_id?: string | null
  wiki_space_id?: string | null
  layout?: { order: ChannelTabMovable[]; hidden: ChannelTabMovable[] }
}
export async function updateTabs(channelId: string, body: ChannelTabsUpdate) {
  return await $fetch<ChannelTabsSummary>(`${base(channelId)}/tabs`, { method: 'PUT', body })
}
export async function fetchFiles(channelId: string) {
  return await $fetch<{ items: ChannelFileItem[]; folder: ChannelFolder | null }>(`${base(channelId)}/files`)
}
export async function fetchMeetings(channelId: string) {
  return (await $fetch<{ items: ChannelMeetingItem[] }>(`${base(channelId)}/meetings`)).items
}
/** 예정·진행 중(items) + 지난 회의(past) */
export async function fetchMeetingGroups(channelId: string) {
  const r = await $fetch<{ items: ChannelMeetingItem[]; past?: ChannelMeetingItem[] }>(`${base(channelId)}/meetings`)
  return { items: r.items, past: r.past ?? [] }
}
export async function fetchTasks(channelId: string) {
  return (await $fetch<{ items: ChannelTaskItem[] }>(`${base(channelId)}/tasks`)).items
}
/** 칩(열린 작업·나에게 배정·완료) 별 목록 + 칩 숫자 */
export async function fetchTaskList(channelId: string, filter: ChannelTaskFilter) {
  const r = await $fetch<{ items: ChannelTaskItem[]; counts?: ChannelTaskCounts }>(`${base(channelId)}/tasks`, { params: { filter } })
  return { items: r.items, counts: r.counts ?? null }
}
export async function createTask(channelId: string, title: string, extra?: { priority?: string; due_date?: string | null; assignee_id?: string | null }) {
  return await $fetch('/api/tasks/', { method: 'POST', body: { title, channel_id: channelId, ...(extra ?? {}) } })
}

/** 탭 줄 순서: 메시지 + 저장된 순서(빠진 키는 기본 순서로 뒤에) */
export function orderedTabs(summary: ChannelTabsSummary | null): ChannelTabLayoutItem[] {
  const base: ChannelTabMovable[] = ['files', 'wiki', 'meetings', 'tasks']
  const saved = (summary?.layout ?? []).filter(x => base.includes(x.key))
  const keys = saved.map(x => x.key)
  return [...saved, ...base.filter(k => !keys.includes(k)).map(key => ({ key, visible: true }))]
}

const api = { fetchSummary, updateTabs, fetchFiles, fetchMeetings, fetchMeetingGroups, fetchTasks, fetchTaskList, createTask }

/** Vue useChannelTabs() 와 같은 멤버 */
export function useChannelTabs() {
  return api
}

/** 파일 종류 타일 글자(시안 PDF · XLS · IMG · ZIP · DOC · MD) */
export function fileKindLabel(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (ext === 'pdf') return 'PDF'
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'XLS'
  if (['doc', 'docx', 'odt', 'hwp'].includes(ext)) return 'DOC'
  if (['ppt', 'pptx', 'odp'].includes(ext)) return 'PPT'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'].includes(ext)) return 'IMG'
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) return 'ZIP'
  if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'VID'
  if (['md', 'txt', 'log'].includes(ext)) return ext.toUpperCase()
  return ext ? ext.slice(0, 3).toUpperCase() : 'FILE'
}
