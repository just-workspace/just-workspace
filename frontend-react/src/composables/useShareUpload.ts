/**
 * 게시판 첨부·위키 이미지 업로드("내 파일함에 저장됩니다").
 * 파일을 내 파일함 폴더(my/<folder>)에 올리고, 다른 사람도 열 수 있게 공유 링크를 만들어 그 주소를 돌려준다.
 *
 * 예전 게시판 쓰기 화면은 /api/files/upload 응답의 url·filename 을 썼는데, 그 응답에는 name·size·path 만 있어
 * 첨부 주소가 비어 있었다(첨부가 열리지 않던 원인). 여기서 공유 링크를 만들어 메운다.
 *
 * 상태 없음. React: const { upload } = useShareUpload() · 컴포넌트 밖: import { shareUpload } from …
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
