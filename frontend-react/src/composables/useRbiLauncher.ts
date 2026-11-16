/**
 * 사용자 메뉴의 "격리 브라우저 열기" — 모듈이 활성화되어 있고 사용 가능한 대상이 하나 이상이며 rbi 출처가 설정된 경우에만 주소를 반환한다.
 * 격리 브라우저는 워크스페이스 내비게이션에 포함되지 않는다(useNav NAV_EXCLUDED) — 이 링크와 rbi.<도메인> 직접 접속이 사용자 진입 경로이다.
 */
import { useEffect, useState } from 'react'
import { usePlatform } from '~/composables/usePlatform'
import { loadRbiLauncher } from '~/composables/useRbi'

export function useRbiLauncher(): string | null {
  const { isModuleEnabled } = usePlatform()
  const on = isModuleEnabled('rbi')
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!on) { setUrl(null); return }
    let alive = true
    void loadRbiLauncher().then(i => { if (alive) setUrl(i.targets.length ? i.url : null) })
    return () => { alive = false }
  }, [on])
  return url
}
