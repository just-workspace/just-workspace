/**
 * 오피스 편집기(WOPI) 열기·잠금 상태 — Vue 판 composables/useOfficeEditor.ts 그대로. 상태 없음.
 * React: const { isOfficeFile, openEditor, getLockStatus, OFFICE_EXTENSIONS } = useOfficeEditor()
 * 컴포넌트 밖: 같은 이름 함수를 직접 import(isOfficeFile 은 useFiles 에도 같은 이름이 있어 여기서는 isOfficeFileName 도 낸다).
 */
import { $fetch } from '~/lib/api'

export type EditorType = 'onlyoffice' | 'auto'

export interface EditorSession {
  editor: string
  editor_url: string
  token: string
  token_ttl: number
  file_name: string
  wopi_src: string
}

export interface LockStatus {
  locked: boolean
  user_id?: string | null
  user_name?: string | null
  editor?: string | null
}

export const OFFICE_EXTENSIONS = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp',
])

export function isOfficeFileName(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  return OFFICE_EXTENSIONS.has(ext)
}

export async function openEditor(
  path: string,
  editor: EditorType = 'auto',
): Promise<EditorSession> {
  return await $fetch<EditorSession>('/api/wopi/open', {
    method: 'POST',
    body: { path, editor },
  })
}

export async function getLockStatus(path: string): Promise<LockStatus> {
  return await $fetch<LockStatus>('/api/wopi/lock-status', {
    params: { path },
  })
}

export function useOfficeEditor() {
  return {
    isOfficeFile: isOfficeFileName,
    openEditor,
    getLockStatus,
    OFFICE_EXTENSIONS,
  }
}
