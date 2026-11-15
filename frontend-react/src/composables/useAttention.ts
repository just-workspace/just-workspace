/**
 * "나를 부른 것"(개인 멘션 + 안 읽은 DM) 총수를 탭 제목·파비콘에 싣는다(R-23). Vue 판 composables/useAttention.ts 대응.
 * 레일·탭바 배지는 같은 숫자(useChat().totalMentions)를 각 컴포넌트가 직접 읽는다.
 * 굵게 표시만 되는 일반 미읽음은 세지 않는다 — 채팅 시안 결정(굵게 = 미읽음, 숫자 = 나를 부른 것).
 *
 * 셸(DefaultLayout)이 한 번 부른다: useAttention()
 *
 * 제목: Vue 는 useHead({ titleTemplate }) 로 숫자 접두를 붙였다. 토대 lib/head 에 titleTemplate 이 없어
 * 여기서 <title> 변화를 지켜보며(화면들이 useHead 로 정한 제목 = 바탕) 같은 접두를 붙인다. 결과 문자열은 Vue 와 같다.
 */
import { useEffect, useRef, useState } from 'react'
import { useChat } from '~/composables/useChat'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useHead } from '~/lib/head'

/** 탭 제목 = (n) 바탕 — 페이지가 이미 "제목 | 앱이름" 을 만들어 준다. 숫자 접두만 붙인다 */
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
      // 우리가 붙인 값이 아니면 화면(useHead)이 바꾼 새 바탕
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
      // 셸이 내려가면 접두 없는 바탕으로 되돌린다
      if (document.title === st.applied) document.title = st.base
      st.applied = null
    }
  }, [])

  useEffect(() => { applyRef.current() }, [totalMentions, appName])

  // ── 파비콘에 숫자 점 — 원래 아이콘 위에 primary 원 + 숫자. 그리지 못하면(교차 출처 등) 원래 아이콘 그대로. ──
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
    // Vue 는 totalMentions 만 지켜봤다(파비콘 설정이 바뀌어도 다음 숫자 변화 때 다시 그림)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalMentions])

  useHead({ link: badged ? [{ rel: 'icon', href: badged, key: 'dynamic-favicon' }] : [] })
}
