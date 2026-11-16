/**
 * 인증·셋업·손님 진입 공통 틀.
 * 인증·셋업·동의·손님 화면은 layout: false + AuthShell.
 *  데스크톱(lg↑): 왼쪽 월페이퍼(관리자 업로드 이미지·영상/그라디언트/그리드) + 좌하단 브랜드(타일 40 · 28/700 · 태그라인 15)
 *                + 오른쪽 520 단색 패널(48/60 패딩, border-left) 안 400 폼.
 *  모바일: 상단 브랜드 띠 160(월페이퍼 + 하단 스크림, 타일 32 · 18/700) → 키보드 표시 시 72 한 줄(타일 28 · 15/600)
 *          + 단색 폼(24 패딩). 카드 없음. 100vh 금지 → dvh.
 * 브랜딩(앱 이름·로고·태그라인·월페이퍼)은 useSiteConfig 값을 그대로 사용.
 * 스타일(월페이퍼 구슬·그리드·켄번스·스크림)은 AuthShell.css.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { $fetch } from '~/lib/api'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { SourceNotice } from '~/components/SourceNotice'
import './AuthShell.css'

export interface AuthShellProps {
  /** 폼 열(400) 안에 세로로 배치할 내용 */
  children?: ReactNode
}

// image 모드: 업로드된 배경 목록을 조회하여 접속마다 무작위 1개 선택. 영상이면 루프 재생, 이미지면 Ken Burns.
interface Wp { url: string; type: string }

export function AuthShell({ children }: AuthShellProps) {
  const { appName, brandLogo, config } = useSiteConfig()

  const cfg = (k: string) => (config?.[k] ?? '').trim()

  const wallpaper = cfg('brand.wallpaper') || 'gradient'
  const wallpaperUrl = cfg('brand.wallpaper_url')
  const tagline = cfg('brand.tagline') || 'self-hosted workspace'
  const initial = (appName || 'W').trim().charAt(0).toUpperCase()

  const [picked, setPicked] = useState<Wp | null>(null)
  useEffect(() => {
    if (wallpaper !== 'image') return
    let alive = true
    void (async () => {
      let wallpapers: Wp[] = []
      try {
        const d = await $fetch<{ wallpapers: Wp[] }>('/api/branding/wallpapers')
        wallpapers = d.wallpapers || []
      } catch { /* 목록 조회 실패 시 단일 url 로 폴백 */ }
      if (!alive) return
      if (wallpapers.length) {
        setPicked(wallpapers[Math.floor(Math.random() * wallpapers.length)])
      } else if (wallpaperUrl && !wallpaperUrl.endsWith('/wallpapers')) {
        setPicked({ url: wallpaperUrl, type: /\.(mp4|webm)$/i.test(wallpaperUrl) ? 'video' : 'image' })
      }
    })()
    return () => { alive = false }
    // 최초 마운트 시점의 설정으로 1회 실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const effWallpaper = wallpaper === 'image' && !picked ? 'gradient' : wallpaper
  const footerLinks = cfg('brand.footer_links').split(',').map(s => s.trim()).filter(Boolean)

  // 모바일 시스템 키보드 감지(띠 160 → 72). visualViewport 가 120px 이상 줄어들면 키보드 표시로 판정한다.
  // visualViewport 미지원 브라우저는 폼 내부 포커스로 대체한다.
  const [keyboard, setKeyboard] = useState(false)
  const [focusInside, setFocusInside] = useState(false)
  const vvRef = useRef<VisualViewport | null>(null)
  useEffect(() => {
    const vv = window.visualViewport ?? null
    vvRef.current = vv
    if (!vv) return
    const onViewport = () => { setKeyboard(window.innerHeight - vv.height > 120) }
    vv.addEventListener('resize', onViewport)
    onViewport()
    return () => { vv.removeEventListener('resize', onViewport) }
  }, [])
  const compact = keyboard || (!vvRef.current && focusInside)

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground lg:flex-row">
      {/* 월페이퍼: 모바일 = 상단 띠(160 → 72), 데스크톱 = 왼쪽 컬럼 */}
      <div
        className={cn(
          'auth-brand-panel relative shrink-0 overflow-hidden transition-[height] duration-200 lg:h-auto lg:min-h-dvh lg:flex-1',
          compact ? 'auth-brand-compact h-[72px] border-b border-border lg:border-b-0' : 'h-[160px]',
        )}
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        {/* 키보드가 표시된 모바일(한 줄 띠)은 월페이퍼 없이 단색 + 하단 테두리 */}
        <div className={cn('pointer-events-none absolute inset-0', compact ? 'max-lg:hidden' : '')}>
          {effWallpaper === 'gradient' ? (
            <>
              <span className="auth-orb auth-orb-1" />
              <span className="auth-orb auth-orb-2" />
              <span className="auth-orb auth-orb-3" />
            </>
          ) : effWallpaper === 'grid' ? (
            <div className="auth-grid absolute inset-0" />
          ) : effWallpaper === 'image' && picked ? (
            picked.type === 'video'
              ? <video src={picked.url} autoPlay loop muted playsInline className="absolute inset-0 h-full w-full object-cover" />
              : <img src={picked.url} alt="" className="auth-kenburns absolute inset-0 h-full w-full object-cover" />
          ) : null}
        </div>
        {/* 스크림: 모바일 띠는 아래로, 데스크톱은 하단 300 */}
        <div className={cn('auth-scrim pointer-events-none absolute inset-0', compact ? 'max-lg:hidden' : '')} />

        {/* 모바일 브랜드(띠 좌하단 / 키보드 시 한 줄) */}
        <div className={cn('absolute inset-x-0 bottom-0 flex items-center lg:hidden', compact ? 'h-full gap-2.5 px-6' : 'gap-2.5 px-6 pb-[18px]')}>
          {brandLogo
            ? <img src={brandLogo} alt="" className={cn('shrink-0 rounded-sm object-cover', compact ? 'h-7 w-7' : 'h-8 w-8')} />
            : (
              <span
                aria-hidden="true"
                className={cn('grid shrink-0 place-items-center rounded-sm bg-primary font-bold text-primary-foreground', compact ? 'h-7 w-7 text-[13px]' : 'h-8 w-8 text-[15px]')}
              >{initial}</span>
            )}
          <span className={cn('truncate', compact ? 'text-[15px] font-semibold text-foreground' : 'text-lg font-bold text-white')}>{appName}</span>
        </div>

        {/* 데스크톱 브랜드(좌하단 56) */}
        <div className="absolute bottom-14 left-14 right-14 hidden flex-col lg:flex">
          <div className="flex items-center gap-3">
            {brandLogo
              ? <img src={brandLogo} alt="" className="h-10 w-10 shrink-0 rounded-[10px] object-cover" />
              : (
                <span
                  aria-hidden="true"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-primary text-lg font-bold text-primary-foreground"
                >{initial}</span>
              )}
            <span className="truncate text-[28px] font-bold tracking-[-0.02em] text-white">{appName}</span>
          </div>
          <p className="mt-2.5 max-w-[680px] truncate text-[15px] text-white/85">{tagline}</p>
          {footerLinks.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/60">
              {footerLinks.map(l => <span key={l}>{l}</span>)}
            </div>
          )}
        </div>
      </div>

      {/* 폼 패널: 모바일 = 단색 폼, 데스크톱 = 오른쪽 520 */}
      <div
        className="flex w-full flex-1 flex-col items-center bg-background px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-6 lg:min-h-dvh lg:w-[520px] lg:flex-none lg:justify-center lg:border-l lg:border-border lg:px-[60px] lg:py-12"
        onFocus={() => setFocusInside(true)}
        onBlur={() => setFocusInside(false)}
      >
        <div className="flex w-full max-w-[400px] flex-col gap-[18px]">
          {children}
          {/* 본 서비스가 실행하는 프로그램의 소스 — 비로그인 사용자도 열람할 수 있어야 한다 */}
          <SourceNotice variant="compact" className="pt-2" />
        </div>
      </div>
    </div>
  )
}

export default AuthShell
