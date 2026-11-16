/**
 * 파일 댓글. GET/POST /api/files/comments, PATCH/DELETE /api/files/comments/{id}.
 * 파일은 본인 경로(my/..)와 공유받은 경로(shared-with-me/..) 모두 동일한 댓글을 조회한다(서버가 소유자 경로로 통합).
 * 작성은 댓글 권한 이상 필요(서버가 can_comment 로 전달), 수정·삭제는 작성자만 가능(is_mine).
 *
 * 싱글턴 아님 — 컴포넌트 지역 상태 hook.
 * React: const { items, canComment, role, owner, isOriginalOwner, loading, error, load, add, edit, remove, resolve, mentionable, requestAccess } = useFileComments(path)
 *   path 는 렌더 시점 문자열 — load·add 는 호출 시점의 최신 path 를 사용한다.
 * 답글(add 의 parentId) · 위치 조각(anchor) · 해결(resolve) · "@" 후보(mentionable — 그 파일 권한 표시) ·
 *   보기 권한의 "권한 요청"(requestAccess — 원 소유자에게 알림).
 */
import { useCallback, useRef, useState } from 'react'
import { $fetch } from '~/lib/api'
import type { ShareRole } from '~/composables/useFiles'

export interface FileComment {
  id: string
  content: string
  author: { id: string; username: string; display_name: string; avatar_url?: string | null } | null
  mentions: { id: string; username: string; display_name: string | null }[]
  is_edited: boolean
  is_mine: boolean
  /** 답글이면 최상위 댓글 id */
  parent_id?: string | null
  /** 위치 조각(예 "시트 3 · D14") */
  anchor?: string | null
  resolved?: boolean
  resolved_by?: { id: string; display_name: string } | null
  created_at: string | null
  updated_at: string | null
}

/** "@" 후보 — role 이 null 이면 해당 파일 조회 불가(언급 시에도 알림 미발송) */
export interface FileMentionCandidate {
  id: string
  username: string
  display_name: string
  email?: string | null
  avatar_url?: string | null
  role: ShareRole | null
}

export function useFileComments(path: string) {
  const p = useRef(path)
  p.current = path
  const [items, setItems] = useState<FileComment[]>([])
  const itemsRef = useRef<FileComment[]>([])
  const [canComment, setCanComment] = useState(false)
  const [role, setRole] = useState<ShareRole | null>(null)
  const [owner, setOwner] = useState<{ id: string; display_name: string } | null>(null)
  const [isOriginalOwner, setIsOriginalOwner] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const put = useCallback((v: FileComment[]) => { itemsRef.current = v; setItems(v) }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await $fetch<{ items: FileComment[]; can_comment: boolean; role: ShareRole; owner?: { id: string; display_name: string } | null; is_original_owner?: boolean }>('/api/files/comments', { params: { path: p.current } })
      put(r.items)
      setCanComment(r.can_comment)
      setRole(r.role)
      setOwner(r.owner ?? null)
      setIsOriginalOwner(!!r.is_original_owner)
    } catch (e: any) {
      put([])
      setCanComment(false)
      setError(e?.data?.detail || 'error')
    } finally {
      setLoading(false)
    }
  }, [put])

  const add = useCallback(async (content: string, opts?: { parentId?: string | null; anchor?: string | null }) => {
    const body: Record<string, unknown> = { path: p.current, content }
    if (opts?.parentId) body.parent_id = opts.parentId
    if (opts?.anchor) body.anchor = opts.anchor
    const c = await $fetch<FileComment>('/api/files/comments', { method: 'POST', body })
    put([...itemsRef.current, c])
    return c
  }, [put])

  const edit = useCallback(async (id: string, content: string) => {
    const c = await $fetch<FileComment>(`/api/files/comments/${id}`, { method: 'PATCH', body: { content } })
    put(itemsRef.current.map(x => (x.id === id ? c : x)))
  }, [put])

  const remove = useCallback(async (id: string) => {
    await $fetch(`/api/files/comments/${id}`, { method: 'DELETE' })
    // 최상위 댓글 삭제 시 서버가 답글도 삭제
    put(itemsRef.current.filter(x => x.id !== id && x.parent_id !== id))
  }, [put])

  /** 해결/다시 열기(최상위만) */
  const resolve = useCallback(async (id: string, resolved: boolean) => {
    const c = await $fetch<FileComment>(`/api/files/comments/${id}/resolve`, { method: 'POST', body: { resolved } })
    put(itemsRef.current.map(x => (x.id === id ? c : x)))
  }, [put])

  /** "@" 후보(해당 파일 권한 포함) */
  const mentionable = useCallback(async (q: string) => {
    return (await $fetch<{ items: FileMentionCandidate[] }>('/api/files/comments/mentionable', { params: { path: p.current, q } })).items
  }, [])

  /** 보기 권한 → 원 소유자에게 권한 요청 알림 */
  const requestAccess = useCallback(async (want: 'comment' | 'edit' = 'comment') => {
    return await $fetch<{ ok: boolean }>('/api/files/access-request', { method: 'POST', body: { path: p.current, role: want } })
  }, [])

  return { items, canComment, role, owner, isOriginalOwner, loading, error, load, add, edit, remove, resolve, mentionable, requestAccess }
}
