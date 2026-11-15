// Vue 원본: frontend/pages/error.vue
// /error 라우트. 화면은 전역 오류 화면과 같은 AuthErrorScreen(로그인 후 404 = 셸 안, 그 외 = 인증 틀).
// Vue 도 이 라우트에서는 useError() 가 비어 있어 오류 없음(= 500 화면)으로 그린다 — 같은 동작.
import { AuthErrorScreen } from '~/components/auth/AuthErrorScreen'

export default function Page() {
  return <AuthErrorScreen />
}
