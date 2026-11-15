/**
 * TanStack Query 클라이언트 — 서버 상태(화면별 목록·상세)용.
 * 재시도·포커스 재조회는 기본으로 끈다(화면이 직접 다시 읽는다).
 *
 * 쿼리 키 규칙: [모듈, 자원, ...매개변수]  예) ['mail', 'messages', { folder, page }] · ['admin', 'users']
 * 같은 데이터를 여러 화면이 쓰면 키 팩토리를 그 모듈 composable 파일에 둔다(예: mailKeys.messages(folder)).
 */
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 0,
    },
    mutations: { retry: false },
  },
})
