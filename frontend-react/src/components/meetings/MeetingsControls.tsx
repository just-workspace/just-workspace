/**
 * 회의 컨트롤 바 — 카메라·마이크·녹화(호스트)·잡음 제거·화면 공유·배경 블러·가상 배경·참가자·채팅·장치 + 나가기.
 */
import { useRef, type ChangeEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useMeetings } from '~/composables/useMeetings'
import { UiIcon } from '~/components/ui/Icon'

export type MeetingsSidebarTab = 'participants' | 'waitingRoom' | 'chat'

export interface MeetingsControlsProps {
  cameraEnabled: boolean
  micEnabled: boolean
  screenShareEnabled: boolean
  blurEnabled?: boolean
  /** 가상 배경(이미지) 활성 상태 — 클릭 시 해제 */
  vbgEnabled?: boolean
  /** 배경 처리 중(블러·가상 배경 공용) */
  blurBusy?: boolean
  /** 잡음 제거(브라우저 기본 잡음 억제) 활성 상태 */
  noiseEnabled?: boolean
  noiseBusy?: boolean
  deviceMenuOpen?: boolean
  /** 녹화 버튼은 호스트에게만 표시 */
  isHost?: boolean
  recording?: boolean
  recordingBusy?: boolean
  sidebarOpen?: boolean
  sidebarTab?: MeetingsSidebarTab
  onToggleCamera?: () => void
  onToggleMic?: () => void
  onToggleScreen?: () => void
  onToggleBlur?: () => void
  onToggleNoise?: () => void
  onToggleDeviceMenu?: () => void
  /** 가상 배경 이미지(null = 해제) */
  onSetBackground?: (file: File | null) => void
  onToggleRecording?: () => void
  onLeave?: () => void
  onToggleSidebar?: (tab: MeetingsSidebarTab) => void
}

const btn = 'inline-flex items-center justify-center h-14 w-14 sm:h-[52px] sm:w-[52px] rounded-2xl transition-colors'

/** 회의 컨트롤 바 */
export function MeetingsControls(props: MeetingsControlsProps) {
  const {
    cameraEnabled, micEnabled, screenShareEnabled, blurEnabled, vbgEnabled, blurBusy, noiseEnabled, noiseBusy,
    deviceMenuOpen, isHost, recording, recordingBusy, sidebarOpen, sidebarTab,
  } = props
  const { t } = useI18n()
  const { unreadChat, pendingRequests } = useMeetings()

  const bgFileInput = useRef<HTMLInputElement | null>(null)
  function onVbgClick() {
    if (vbgEnabled) props.onSetBackground?.(null)   // 활성 상태이면 해제
    else bgFileInput.current?.click()                // 그 외에는 이미지 선택
  }
  function onBgFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null
    if (f) props.onSetBackground?.(f)
    e.target.value = ''
  }

  return (
    // 스크롤러(버튼 그룹)와 나가기 버튼을 형제 요소로 배치한다. 기존에는 나가기 버튼이 스크롤 컨테이너 내부에
    // absolute 로 배치되어 좁은 화면에서 스크롤 시 다른 버튼 위에 겹쳐 표시되었다.
    // 높이는 콘텐츠 기반이므로 safe-area 패딩이 높이를 잠식하지 않고 가산된다.
    <div className="flex items-stretch bg-background border-t border-border shrink-0 pb-[env(safe-area-inset-bottom)]">
      <div className="flex-1 min-w-0 flex items-center justify-start sm:justify-center gap-2 sm:gap-3 px-2 sm:px-4 py-2 overflow-x-auto scrollbar-none">
        {/* 카메라 토글 */}
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={() => props.onToggleCamera?.()}
            className={cn(btn, cameraEnabled ? 'bg-muted hover:bg-muted/80' : 'bg-destructive/15 text-destructive hover:bg-destructive/25')}
            title={cameraEnabled ? t('meetings.controls.cameraOff') : t('meetings.controls.cameraOn')}
          >
            {cameraEnabled ? <UiIcon name="camera" className="h-5 w-5" /> : <UiIcon name="camera-off" className="h-5 w-5" />}
          </button>
          <span className="text-[11px] font-medium text-muted-foreground">{cameraEnabled ? t('meetings.controls.cameraOff') : t('meetings.controls.cameraOn')}</span>
        </div>

        {/* 마이크 토글 */}
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={() => props.onToggleMic?.()}
            className={cn(btn, micEnabled ? 'bg-muted hover:bg-muted/80' : 'bg-destructive/15 text-destructive hover:bg-destructive/25')}
            title={micEnabled ? t('meetings.controls.micOff') : t('meetings.controls.micOn')}
          >
            {micEnabled ? <UiIcon name="mic-on" className="h-5 w-5" /> : <UiIcon name="mic-off" className="h-5 w-5" />}
          </button>
          <span className="text-[11px] font-medium text-muted-foreground">{micEnabled ? t('meetings.controls.micOff') : t('meetings.controls.micOn')}</span>
        </div>

        {/* 녹화(호스트 전용) — 모바일 첫 화면에 표시되도록 마이크 바로 다음에 배치 */}
        {isHost && (
          <div className="flex flex-col items-center gap-1">
            <button
              onClick={() => props.onToggleRecording?.()}
              disabled={recordingBusy}
              className={cn(btn, 'disabled:opacity-40', recording ? 'bg-danger/20 text-danger hover:bg-danger/30' : 'bg-muted hover:bg-muted/80')}
              title={recording ? t('meetings.controls.recStop') : t('meetings.controls.recStart')}
            >
              {recordingBusy
                ? <UiIcon name="loader" strokeWidth={2.4} className="h-5 w-5 animate-spin" />
                : recording
                  ? <span className="h-4 w-4 rounded-[3px] bg-danger" />
                  : <span className="h-4 w-4 rounded-full border-2 border-current" />}
            </button>
            <span className={cn('text-[11px] font-medium', recording ? 'text-danger' : 'text-muted-foreground')}>{recording ? t('meetings.controls.recStop') : t('meetings.controls.recStart')}</span>
          </div>
        )}

        {/* 화면공유 토글 */}
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={() => props.onToggleScreen?.()}
            className={cn(btn, screenShareEnabled ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'bg-muted hover:bg-muted/80')}
            title={screenShareEnabled ? t('meetings.controls.screenStop') : t('meetings.controls.screenShare')}
          >
            <UiIcon name="monitor" className="h-5 w-5" />
          </button>
          <span className="text-[11px] font-medium text-muted-foreground">{screenShareEnabled ? t('meetings.controls.screenStop') : t('meetings.controls.screenShare')}</span>
        </div>

        {/* 잡음 제거 토글 — 브라우저 기본 잡음 억제. 마이크 활성 시에만 */}
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={() => props.onToggleNoise?.()}
            disabled={!micEnabled || noiseBusy}
            aria-pressed={!!noiseEnabled}
            title={t('meetings.controls.noise')}
            className={cn(btn, 'disabled:opacity-40', noiseEnabled ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'bg-muted hover:bg-muted/80')}
          >
            {noiseBusy
              ? <UiIcon name="loader" strokeWidth={2.4} className="h-5 w-5 animate-spin" />
              : <UiIcon name="audio-lines" className="h-5 w-5" />}
          </button>
          <span className="text-[11px] font-medium text-muted-foreground">{t('meetings.controls.noise')}</span>
        </div>

        {/* 배경 블러 토글 (카메라 활성 시에만, GPU 우선/CPU 폴백) */}
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={() => props.onToggleBlur?.()}
            disabled={!cameraEnabled || blurBusy}
            className={cn(btn, 'disabled:opacity-40', blurEnabled ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'bg-muted hover:bg-muted/80')}
            title={t('meetings.controls.blur')}
          >
            {blurBusy
              ? <UiIcon name="loader" strokeWidth={2.4} className="h-5 w-5 animate-spin" />
              : <UiIcon name="aperture" className="h-5 w-5" />}
          </button>
          <span className="text-[11px] font-medium text-muted-foreground">{t('meetings.controls.blur')}</span>
        </div>

        {/* 가상배경(이미지) 토글 */}
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={onVbgClick}
            disabled={!cameraEnabled || blurBusy}
            className={cn(btn, 'disabled:opacity-40', vbgEnabled ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'bg-muted hover:bg-muted/80')}
            title={t('meetings.controls.vbg')}
          >
            <UiIcon name="image-frame" className="h-5 w-5" />
          </button>
          <span className="text-[11px] font-medium text-muted-foreground">{t('meetings.controls.vbg')}</span>
          <input ref={bgFileInput} type="file" accept="image/*" className="hidden" onChange={onBgFileChange} />
        </div>

        {/* 구분선 */}
        <div className="w-px h-8 bg-border mx-1 hidden sm:block" />

        {/* 참여자 사이드바 토글 */}
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={() => props.onToggleSidebar?.('participants')}
            className={cn('relative', btn, sidebarOpen && sidebarTab === 'participants' ? 'bg-primary/15 text-primary' : 'bg-muted hover:bg-muted/80')}
            title={t('meetings.controls.participants')}
          >
            <UiIcon name="users" className="h-5 w-5" />
            {pendingRequests.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center h-4 min-w-[1rem] px-1 text-[11px] font-bold rounded-full bg-warning text-background">
                {pendingRequests.length}
              </span>
            )}
          </button>
          <span className="text-[11px] font-medium text-muted-foreground">{t('meetings.controls.participants')}</span>
        </div>

        {/* 채팅 사이드바 토글 */}
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={() => props.onToggleSidebar?.('chat')}
            className={cn('relative', btn, sidebarOpen && sidebarTab === 'chat' ? 'bg-primary/15 text-primary' : 'bg-muted hover:bg-muted/80')}
            title={t('meetings.controls.chat')}
          >
            <UiIcon name="chat" className="h-5 w-5" />
            {unreadChat > 0 && !(sidebarOpen && sidebarTab === 'chat') && (
              <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center h-4 min-w-[1rem] px-1 text-[11px] font-bold rounded-full bg-primary text-primary-foreground">
                {unreadChat > 99 ? '99+' : unreadChat}
              </span>
            )}
          </button>
          <span className="text-[11px] font-medium text-muted-foreground">{t('meetings.controls.chat')}</span>
        </div>

        {/* 장치 전환 */}
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={() => props.onToggleDeviceMenu?.()}
            className={cn(btn, deviceMenuOpen ? 'bg-primary/15 text-primary' : 'bg-muted hover:bg-muted/80')}
            title={t('meetings.controls.devices')}
          >
            <UiIcon name="settings" className="h-5 w-5" />
          </button>
          <span className="text-[11px] font-medium text-muted-foreground">{t('meetings.controls.devices')}</span>
        </div>
      </div>

      {/* 나가기 — 스크롤러 외부, 상시 표시 */}
      <div className="shrink-0 flex flex-col items-center justify-center gap-1 px-2 sm:px-4 border-l border-border">
        <button
          onClick={() => props.onLeave?.()}
          className="inline-flex items-center justify-center h-14 w-14 sm:h-[52px] sm:w-[52px] rounded-2xl bg-danger text-background hover:bg-danger/90 transition-colors"
          title={t('meetings.controls.leave')}
        >
          <UiIcon name="log-out" className="h-5 w-5" />
        </button>
        <span className="text-[11px] font-medium text-danger">{t('meetings.controls.leave')}</span>
      </div>
    </div>
  )
}

export default MeetingsControls
