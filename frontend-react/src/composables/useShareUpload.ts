/**
 * 게시판 첨부·위키 이미지 업로드("내 파일함에 저장됩니다").
 * 파일을 내 파일함 폴더(my/<folder>)에 업로드하고, 타 사용자도 열 수 있도록 공유 링크를 생성하여 해당 주소를 반환한다.
 *
 * 이전 게시판 작성 화면은 /api/files/upload 응답의 url·filename 을 사용했으나, 해당 응답에는 name·size·path 만 있어
 * 첨부 주소가 비어 있었다(첨부가 열리지 않던 원인). 본 모듈에서 공유 링크를 생성하여 보완한다.
 *
 * 상태 없음. React: const { upload } = useShareUpload() · 컴포넌트 외부: import { shareUpload } from …
 */
import { $fetch } from '~/lib/api'

export interface UploadedShare { name: string; url: string; size: number; path: string }

export async function shareUpload(file: File, folder: string): Promise<UploadedShare> {
  const form = new FormData()
  form.append('file', file)
  const up = await $fetch<{ name: string; size: number; path: string }>('/api/files/upload', {
    method: 'POST',
    body: form,
    params: { path: `my/${folder}`, size: file.size },
  })
  const link = await $fetch<{ url: string }>('/api/files/share', {
    method: 'POST',
    body: { path: up.path },
  })
  return { name: up.name, url: link.url, size: up.size, path: up.path }
}

export function useShareUpload() {
  return { upload: shareUpload }
}
