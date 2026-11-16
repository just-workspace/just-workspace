// 구 주소 호환용 리다이렉트(라우터가 /settings/account 로 이동시킨다).
import { Navigate } from 'react-router'

export default function Page() {
  return <Navigate to="/settings/account" replace />
}
