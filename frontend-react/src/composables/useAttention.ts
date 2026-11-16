/**
 * "나를 부른 것"(개인 멘션 + 안 읽은 DM) 총수를 탭 제목·파비콘에 표시한다.
 * 레일·탭바 배지는 동일 숫자(useChat().totalMentions)를 각 컴포넌트가 직접 읽는다.
 * 굵게 표시만 되는 일반 미읽음은 집계하지 않는다 — 채팅 시안 결정(굵게 = 미읽음, 숫자 = 나를 부른 것).
 *
 * 셸(DefaultLayout)이 1회 호출한다: useAttention()
 *
 * 제목: 기반 lib/head 에 titleTemplate 이 없으므로
 * 본 모듈에서 <title> 변화를 감시하여(화면들이 useHead 로 지정한 제목 = 바탕) 숫자 접두를 부가한다.
 */
import { useEffect, useRef, useState } from 'react'
import { useChat } from '~/composables/useChat'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useHead } from '~/lib/head'

/** 탭 제목 = (n) 바탕 — 페이지가 이미 "제목 | 앱이름" 을 구성한다. 숫자 접두만 부가한다 */
export function attentionTitle(base: string, n: number): string {
  return n > 0 ? `(${n > 99 ? '99+' : n}) ${base}` : base
}

export function useAttention() {
  const { totalMentions } = useChat()
  const { appName, favicon } = useSiteConfig()

  // ── 탭 제목 접두(titleTemplate 대응) ──
  const live = useRef({ n: totalMentions, appName })
  live.current = { n: totalMentions, appName }
  const titleState = useRef<{ base: string; applied: string | null }>({ base: '', applied: null })
  const applyRef = useRef<() => void>(() => {})

  useEffect(() => {
    const st = titleState.current
    const apply = () => {
      const cur = document.title
      // 본 모듈이 적용한 값이 아니면 화면(useHead)이 변경한 새 바탕
      if (cur !== st.applied) st.base = cur
      const next = attentionTitle(st.base || live.current.appName, live.current.n)
      st.applied = next
      if (document.title !== next) document.title = next
    }
    applyRef.current = apply
    apply()
    const mo = new MutationObserver(() => apply())
    mo.observe(document.head, { subtree: true, childList: true, characterData: true })
    return () => {
      mo.disconnect()
      applyRef.current = () => {}
      // 셸 언마운트 시 접두 없는 바탕으로 복원한다
      if (document.title === st.applied) document.title = st.base
      st.applied = null
    }
  }, [])

  useEffect(() => { applyRef.current() }, [totalMentions, appName])

  // ── 파비콘에 숫자 점 — 원래 아이콘 위에 primary 원 + 숫자. 렌더링 실패 시(교차 출처 등) 원래 아이콘 유지. ──
  const [badged, setBadged] = useState<string | null>(null)
  const drawSeq = useRef(0)
  useEffect(() => {
    const n = totalMentions
    const seq = ++drawSeq.current
    if (n <= 0) { setBadged(null); return }
    void (async () => {
      try {
        const src = favicon || '/icon.svg'
        const img = new Image()
        img.crossOrigin = 'anonymous'
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('icon'))
          img.src = src
        })
        const size = 64
        const c = document.createElement('canvas')
        c.width = size; c.height = size
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0, size, size)
        const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
        const label = n > 9 ? '9+' : String(n)
        g.beginPath()
        g.arc(size - 18, 18, 18, 0, Math.PI * 2)
        g.fillStyle = primary ? `hsl(${primary})` : '#4d8eff'
        g.fill()
        g.fillStyle = '#fff'
        g.font = 'bold 26px "JetBrains Mono", monospace'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(label, size - 18, 19)
        if (seq === drawSeq.current) setBadged(c.toDataURL('image/png'))
      } catch {
        if (seq === drawSeq.current) setBadged(null)
      }
    })()
    // totalMentions 만 감시한다(파비콘 설정이 변경되어도 다음 숫자 변화 시 다시 렌더링)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalMentions])

  useHead({ link: badged ? [{ rel: 'icon', href: badged, key: 'dynamic-favicon' }] : [] })
}
