/**
 * 상단바 3단 경로: 워크스페이스 / 모듈 / 위치.
 * 모듈 이름은 셸(useNav)이 보유하고, 세 번째 "위치"(메일 폴더·파일 경로·위키 페이지·게시판 이름)는 각 페이지가
 * useBreadcrumb('받은편지함') 으로 설정한다. 라우트 변경 시 셸(DefaultLayout)이 초기화한다.
 *
 * React:
 *   useBreadcrumb(folderName)        // 값이 바뀌면 갱신, 언마운트 때 비움
 *   const { location, set, clear } = useBreadcrumb()   // 읽기·직접 설정
 * 컴포넌트 밖: setBreadcrumb(v) / clearBreadcrumb()
 */
import { useEffect } from 'react'
import { createStore, useStore } from 'zustand'

export const breadcrumbStore = createStore<{ location: string }>()(() => ({ location: '' }))

export function setBreadcrumb(v: string | null | undefined) { breadcrumbStore.setState({ location: v ?? '' }) }
export function clearBreadcrumb() { breadcrumbStore.setState({ location: '' }) }

/**
 * @param location 전달하면(문자열·null 포함) 이 컴포넌트가 위치를 소유한다 — 값 변경 시 갱신, 언마운트 시 초기화.
 *                 생략하면 읽기/설정만 수행.
 */
export function useBreadcrumb(location?: string | null) {
  const owns = arguments.length > 0
  const current = useStore(breadcrumbStore, s => s.location)

  useEffect(() => {
    if (!owns) return
    setBreadcrumb(location)
  }, [owns, location])

  useEffect(() => {
    if (!owns) return
    return () => clearBreadcrumb()
  }, [owns])

  return { location: current, set: setBreadcrumb, clear: clearBreadcrumb }
}
