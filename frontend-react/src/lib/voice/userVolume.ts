/**
 * 사용자별 음량 — 개인 설정 chatUserVolumes(%)·chatUserMuted 를 음성 접속자에게 실제로 적용한다.
 *  · 값은 사용자 id 기준으로 저장한다(identity 는 세션마다 변경된다). identity → user_id 는 chatStore.voiceStates 의 participants.
 *  · 적용: 전송의 setParticipantGain(identity, 0..2). 나만 음소거면 0. 100% 는 1(기본).
 *  · 접속자·설정·음성 상태가 변경될 때마다 재적용한다(동일 값이면 재호출하지 않는다).
 * 화면(ChatUserVolume)·사이드바 접속자 줄 표시는 아래 순수 함수(userVolumeOf · volumeBadge)를 사용한다.
 */
import type { StoreApi } from 'zustand'
import { USER_VOLUME, userPrefsStore, type Prefs } from '~/composables/useUserPrefs'
import { chatStore } from '~/composables/useChat'
import type { VoicePeer } from '~/lib/voice/transport'

/** 해당 사용자의 음량(%) — 저장값이 없으면 100 */
export function userVolumeOf(userId: string, prefs: Pick<Prefs, 'chatUserVolumes'>): number {
  const v = prefs.chatUserVolumes?.[userId]
  return typeof v === 'number' ? v : USER_VOLUME.def
}
export function userMutedOf(userId: string, prefs: Pick<Prefs, 'chatUserMuted'>): boolean {
  return !!prefs.chatUserMuted?.[userId]
}
/** 전송에 전달할 값(0..2) */
export function gainFor(userId: string, prefs: Pick<Prefs, 'chatUserVolumes' | 'chatUserMuted'>): number {
  if (userMutedOf(userId, prefs)) return 0
  return userVolumeOf(userId, prefs) / 100
}
/** 접속자 줄 꼬리표 — 100 이 아니면 "120%", 아니면 '' (SIDEBAR 가 mono primary 로 렌더링한다) */
export function volumeBadge(userId: string, prefs: Pick<Prefs, 'chatUserVolumes'>): string {
  const v = userVolumeOf(userId, prefs)
  return v === USER_VOLUME.def ? '' : `${v}%`
}
/** 5% 단위로 맞추고 0–200 범위로 제한 */
export function snapVolume(pct: number): number {
  const v = Math.max(USER_VOLUME.min, Math.min(USER_VOLUME.max, pct))
  return Math.round(v / USER_VOLUME.step) * USER_VOLUME.step
}

/** identity → user_id (지금 접속한 채널의 음성 상태) */
export function identityUserMap(channelId: string | null): Map<string, string> {
  const m = new Map<string, string>()
  if (!channelId) return m
  const st = chatStore.getState().voiceStates[channelId]
  for (const p of st?.participants ?? []) if (p.user_id) m.set(p.identity, p.user_id)
  return m
}

interface VoiceLike { channelId: string | null; peers: VoicePeer[] }
interface Deps { voiceStore: StoreApi<VoiceLike>; setPeerGain: (identity: string, gain: number) => void }

let _installed = false
/** useVoice 가 store 생성 후 1회 호출한다 */
export function installUserVolumeSync({ voiceStore, setPeerGain }: Deps) {
  if (_installed) return
  _installed = true
  const applied = new Map<string, number>()
  const sync = () => {
    const { channelId, peers } = voiceStore.getState()
    if (!channelId) { applied.clear(); return }
    const ids = identityUserMap(channelId)
    const prefs = userPrefsStore.getState().prefs
    for (const p of peers) {
      if (p.isLocal) continue
      const uid = ids.get(p.identity)
      const g = uid ? gainFor(uid, prefs) : 1
      if (applied.get(p.identity) === g) continue
      applied.set(p.identity, g)
      setPeerGain(p.identity, g)
    }
  }
  voiceStore.subscribe((s, prev) => {
    if (s.channelId !== prev.channelId) applied.clear()
    if (s.peers !== prev.peers || s.channelId !== prev.channelId) sync()
  })
  userPrefsStore.subscribe((s, prev) => {
    if (s.prefs.chatUserVolumes !== prev.prefs.chatUserVolumes || s.prefs.chatUserMuted !== prev.prefs.chatUserMuted) sync()
  })
  chatStore.subscribe((s, prev) => { if (s.voiceStates !== prev.voiceStates) sync() })
}
