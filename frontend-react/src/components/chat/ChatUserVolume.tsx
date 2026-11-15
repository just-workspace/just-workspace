/**
 * 사람별 음량(handover-22 · 시안 Pop22 #vol 260 / Mob22 #m-vol 시트) — 음성 접속자 줄에서 우클릭·길게 누르기로 연다.
 *  머리: 아바타 28 · "○○ 님 음량" 14/600 · 값 mono 13 primary
 *  UiSlider 0–200(5% 단계, 100 눈금) + 아래 0 · 100 · 200(mono 11) → 100% 넘으면 warning 한 줄
 *  → (위 선) "나만 음소거" UiSwitch · "기본값(100%)으로".
 * 저장: 개인 설정 chatUserVolumes / chatUserMuted(사용자 id 기준) — 끄는 동안은 화면만, 놓을 때(onCommit) 저장.
 * 실제 소리: lib/voice/userVolume 이 설정을 읽어 LiveKit 원격 참가자 음량(0–2.0, 100% 넘으면 WebAudio 이득)에 적용한다.
 *
 * SIDEBAR 연결: 접속자 줄에 {...userVolumeTriggerProps({ userId, name, avatarUrl })} 를 펼치면 우클릭·길게 누르기(500ms)로 열린다.
 *  또는 openUserVolume({ userId, name, avatarUrl, anchor: anchorOf(el) }) 를 직접. 그리는 곳(ChatUserVolumeHost)은 pages/chat 에 있다.
 *  자기 자신(내 줄)은 열지 않는다.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createStore, useStore } from 'zustand'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { anchorOf, initialOf } from '~/composables/useChatUi'
import { useIsMobile } from '~/composables/useIsMobile'
import { USER_VOLUME, setChatUserMuted, setChatUserVolume, userPrefsStore } from '~/composables/useUserPrefs'
import { snapVolume, userMutedOf, userVolumeOf } from '~/lib/voice/userVolume'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiIcon } from '~/components/ui/Icon'
import { UiSlider } from '~/components/ui/Slider'
import { UiSwitch } from '~/components/ui/Switch'
import { ChatFloating } from './ChatFloating'

export interface UserVolumeTarget {
  userId: string
  name: string
  avatarUrl?: string | null
  /** 화면 좌표 사각형(anchorOf). 없으면 화면 가운데 */
  anchor?: { x: number; y: number; w: number; h: number } | null
}

const volumeStore = createStore<{ target: UserVolumeTarget | null }>()(() => ({ target: null }))

/** 사람별 음량 열기(내 줄이면 무시) */
export function openUserVolume(t: UserVolumeTarget) {
  if (t.userId === authStore.getState().user?.id) return
  volumeStore.setState({ target: t })
}
export function closeUserVolume() { volumeStore.setState({ target: null }) }

const LONG_PRESS_MS = 500

/** 접속자 줄에 펼칠 속성 — 우클릭(contextmenu) · 터치 길게 누르기 */
export function userVolumeTriggerProps(t: Omit<UserVolumeTarget, 'anchor'>) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
  return {
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault()
      openUserVolume({ ...t, anchor: anchorOf(e.currentTarget) })
    },
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'touch') return
      const el = e.currentTarget
      clear()
      timer = setTimeout(() => { timer = null; openUserVolume({ ...t, anchor: anchorOf(el) }) }, LONG_PRESS_MS)
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
  }
}

/** 지금 열린 사람별 음량 카드 — pages/chat 이 한 번 그린다 */
export function ChatUserVolumeHost() {
  const target = useStore(volumeStore, s => s.target)
  if (!target) return null
  return <ChatUserVolume key={target.userId} target={target} onClose={closeUserVolume} />
}

export function ChatUserVolume({ target, onClose }: { target: UserVolumeTarget; onClose: () => void }) {
  const { t } = useI18n()
  const mobile = useIsMobile()
  const saved = useStore(userPrefsStore, s => userVolumeOf(target.userId, s.prefs))
  const muted = useStore(userPrefsStore, s => userMutedOf(target.userId, s.prefs))
  const [vol, setVol] = useState(saved)
  const dragging = useRef(false)
  // 다른 곳(다른 탭·서버 동기화)에서 바뀌면 따라간다 — 끄는 동안은 그대로
  useEffect(() => { if (!dragging.current) setVol(saved) }, [saved])

  const title = t('chat.shell.vol.title', { name: target.name })
  const pct = (v: number) => `${v}%`

  return (
    <ChatFloating anchor={target.anchor ?? null} width={260} mobile={mobile} role="menu" ariaLabel={title} onClose={onClose} sheetMaxHeight={320}>
      <div className={mobile ? 'flex flex-col gap-3 px-4 pb-8 pt-6' : 'flex flex-col gap-3 p-3'}>
        <div className="flex items-center gap-2">
          <UiAvatar src={target.avatarUrl} alt={target.name} fallback={initialOf(target.name)} className="h-7 w-7" textSize={11} />
          <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-foreground">{title}</p>
          <span className="font-mono text-[13px] font-semibold text-primary" aria-hidden="true">{pct(vol)}</span>
        </div>
        <div className="flex flex-col gap-1">
          <UiSlider
            ariaLabel={title}
            min={USER_VOLUME.min}
            max={USER_VOLUME.max}
            step={USER_VOLUME.step}
            marks={[USER_VOLUME.def]}
            modelValue={vol}
            onUpdateModelValue={(v) => { dragging.current = true; setVol(snapVolume(v)) }}
            onCommit={(v) => { dragging.current = false; setChatUserVolume(target.userId, snapVolume(v)) }}
            formatValue={pct}
            className={mobile ? 'h-11' : undefined}
          />
          <div className="flex justify-between font-mono text-[11px] text-muted-foreground" aria-hidden="true">
            <span>{USER_VOLUME.min}</span><span>{USER_VOLUME.def}</span><span>{USER_VOLUME.max}</span>
          </div>
        </div>
        {vol > USER_VOLUME.def && (
          <p className="flex items-start gap-1.5 text-[12px] text-warning" role="status">
            <UiIcon name="alert-triangle" className="mt-px h-3.5 w-3.5 shrink-0" />{t('chat.shell.vol.clipWarn')}
          </p>
        )}
        <div className="flex flex-col border-t border-border pt-2">
          <div className={mobile ? 'flex h-11 items-center justify-between text-[14px]' : 'flex h-9 items-center justify-between text-[14px]'}>
            <span id={`vol-mute-${target.userId}`}>{t('chat.shell.vol.muteForMe')}</span>
            <UiSwitch
              ariaLabel={t('chat.shell.vol.muteForMe')}
              modelValue={muted}
              onUpdateModelValue={(v) => setChatUserMuted(target.userId, v)}
            />
          </div>
          <button
            type="button"
            className={(mobile ? 'h-11' : 'h-9') + ' flex items-center rounded-md text-left text-[14px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring'}
            onClick={() => { setVol(USER_VOLUME.def); setChatUserVolume(target.userId, USER_VOLUME.def) }}
          >{t('chat.shell.vol.reset')}</button>
        </div>
      </div>
    </ChatFloating>
  )
}

export default ChatUserVolume
