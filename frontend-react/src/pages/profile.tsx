// 옛 주소 호환용 리다이렉트(라우터가 /settings/account 로 보낸다).
import { Navigate } from 'react-router'

export default function Page() {
  return <Navigate to="/settings/account" replace />
}
