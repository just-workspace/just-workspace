// 음성 채널 화면: 사이드바 "음성" 구역·접속자, 새 채널 모달의 음성 체크, 접속 바(상태·음질 버튼·팝오버), 본문(타일·띠·채팅),
// 음질 패널(무손실 활성·하이레조 웹 disabled·고급), 상태 12종 중 재연결·중계 실패·권한 없음·이어폰·독점 실패·하이레조 확인창
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({ calls: [] as Array<{ url: string; opts?: any }>, handler: (_u: string, _o?: any): any => ({}) }))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})
// LiveKit 은 브라우저 전용 — 전송은 가짜로 갈아 끼운다
const fakeTransport = vi.hoisted(() => ({
  join: vi.fn(async () => {}), leave: vi.fn(async () => {}), setSend: vi.fn(async () => {}), setMuted: vi.fn(async () => {}),
  setDeafened: vi.fn(), setScreenAudio: vi.fn(async () => true), attachRemoteAudio: vi.fn(), getStats: vi.fn(async () => ({})),
  getLevels: vi.fn(() => ({ left: -100, right: -100 })), peers: vi.fn(() => []), on: vi.fn(() => () => {}),
  effectiveTier: vi.fn(() => 'voice'), micState: vi.fn(() => 'ok'), setParticipantVolume: vi.fn(), tiers: ['voice', 'music'],
}))
vi.mock('~/lib/voice/transports/livekit', () => ({ createLiveKitVoiceTransport: () => fakeTransport, LiveKitVoiceTransport: class {}, isMicUnavailable: () => false }))

const { i18n } = await import('~/i18n')
const { authStore } = await import('~/composables/useAuth')
const { chatStore } = await import('~/composables/useChat')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { mediaDevicesStore } = await import('~/composables/useMediaDevices')
type Channel = import('~/composables/useChat').Channel
const { voiceStore, joinVoice, confirmHiresExclusive, reportExclusiveError } = await import('~/composables/useVoice')
const { EMPTY_STATS } = await import('~/lib/voice/stats')
const { DEFAULT_VOICE_PREFS } = await import('~/lib/voice/prefs')
const { ChatSidebar } = await import('~/components/chat/ChatSidebar')
const { ChatCreateModal } = await import('~/components/chat/ChatCreateModal')
const { VoiceConnectedBar } = await import('~/components/voice/VoiceConnectedBar')
const { VoiceChannelView } = await import('~/components/voice/VoiceChannelView')
const { VoiceQualityPanel } = await import('~/components/voice/VoiceQualityPanel')
const { VoiceStatsContent } = await import('~/components/voice/VoiceStatsPanel')
const { VoiceHiresDialog } = await import('~/components/voice/VoiceHiresDialog')

const t = (k: string, a?: Record<string, unknown>) => i18n.t(k, a)
const me = { id: 'u1', username: 'kim', display_name: '김서연', email: '', is_admin: false } as any
const ch = (p: Partial<Channel>): Channel => ({
  id: 'c1', name: 'general', type: 'public', description: null, created_by: 'u1', is_archived: false,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', member_count: 2, unread_count: 0, ...p,
})
const presence = (identity: string, name: string, extra: Record<string, unknown> = {}) => ({
  identity, user_id: null, name, avatar_url: null, muted: false, deafened: false, tier: 'voice' as const, joined_at: 1, ...extra,
})
const dev = (deviceId: string, label: string) => ({ deviceId, groupId: deviceId, label, rawLabel: label, isBluetooth: false, isDefault: true })

beforeEach(() => {
  api.calls = []
  api.handler = () => ({})
  localStorage.clear()
  isMobileStore.setState({ isMobile: false })
  mediaDevicesStore.setState({ cameras: [], microphones: [], speakers: [] })
  authStore.setState({ user: me })
  fakeTransport.micState.mockReturnValue('ok')
  fakeTransport.effectiveTier.mockReturnValue('voice')
  fakeTransport.setSend.mockClear()
  chatStore.setState({
    channels: [ch({}), ch({ id: 'v1', name: '라운지', is_voice: true }), ch({ id: 'v2', name: '음악방', is_voice: true, type: 'private' })],
    selectedChannelId: 'v1', messages: [], members: [], allUsers: [], outbox: [], drafts: {}, loadingChannels: false, channelsError: null,
    voiceStates: { v1: { participants: [presence('a', '이도윤', { muted: true }), presence('b', '박민지', { tier: 'music', deafened: true })], since: 1 } },
  })
  voiceStore.setState({
    channelId: null, identity: null, connectionState: 'disconnected', peers: [], muted: false, deafened: false, statsOpen: false, qualityOpen: false,
    screenAudio: false, busy: false, listenOnly: false, reconnectSince: null, exclusiveError: null, hiresPrompt: null, barHosts: 0,
    prefs: { ...DEFAULT_VOICE_PREFS }, effectiveTier: 'voice', stats: { ...EMPTY_STATS },
  })
})

describe('사이드바 "음성" 구역', () => {
  // 음성 채널은 별도 구역 없이 카테고리에 섞인다(카테고리 없으면 "분류 없음")
  it('음성 채널 행(아이콘·이름·인원 mono) · 접속자 줄(음소거·듣기 끔·단계 짧은 글자)', () => {
    renderInRouter(<ChatSidebar />)
    expect(screen.queryByTestId('voice-section')).toBeNull()
    const row = screen.getByRole('button', { name: t('chat.voice.sidebar.occupants', { name: '라운지', n: 2 }) })
    expect(row.textContent).toContain('2')
    expect(screen.getByRole('button', { name: t('chat.voice.sidebar.empty', { name: '음악방' }) })).toBeTruthy()
    const list = screen.getByRole('list', { name: t('chat.voice.sidebar.occupantList', { name: '라운지' }) })
    expect(list.textContent).toContain('이도윤')
    expect(within(list).getByRole('img', { name: t('chat.voice.muted') })).toBeTruthy()
    expect(within(list).getByRole('img', { name: t('chat.voice.sidebar.deafened') })).toBeTruthy()
    expect(list.textContent).toContain(t('chat.voice.tier.music.short'))
    // 텍스트 채널 목록엔 안 들어간다
    expect(screen.queryByRole('button', { name: /^라운지$/ })).toBeNull()
    // 들어가기 전엔 접속 바 없음
    expect(screen.queryByTestId('voice-bar')).toBeNull()
  })
  it('누르면 토큰을 받아 바로 들어간다(벨 없음) — 전송 join · 상태 보고 · 내 채널 = 선택 덧칠 굵게 · 사이드바 하단에 접속 바', async () => {
    api.handler = (url) => url.endsWith('/voice/token') ? { token: 'jwt', livekit_url: 'ws://x', room: 'voice-v1', identity: 'me-1' } : {}
    renderInRouter(<ChatSidebar />)
    fireEvent.click(screen.getByRole('button', { name: t('chat.voice.sidebar.occupants', { name: '라운지', n: 2 }) }))
    await waitFor(() => expect(fakeTransport.join).toHaveBeenCalled())
    expect(api.calls.some(c => c.url === '/api/chat/channels/v1/voice/token')).toBe(true)
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/chat/channels/v1/voice/state')).toBe(true))
    expect(voiceStore.getState().channelId).toBe('v1')
    const row = await screen.findByRole('button', { name: new RegExp(t('chat.voice.sidebar.connected')) })
    expect(row.className).toContain('bg-overlay-selected')
    expect(row.className).toContain('font-semibold')
    expect(screen.getByTestId('voice-bar')).toBeTruthy()
    expect(voiceStore.getState().barHosts).toBe(1)
  })
})

describe('새 채널 모달', () => {
  it('종류 "음성" → voice:true 로 만든다', async () => {
    api.handler = (url, opts) => (url === '/api/chat/channels' && opts?.method === 'POST') ? { id: 'nv', name: '새방', type: 'public', is_voice: true } : url.includes('/messages') ? { messages: [], has_more: false } : {}
    renderInRouter(<ChatCreateModal onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(t('chat.create.namePlaceholder')), { target: { value: '새방' } })
    fireEvent.click(screen.getByRole('radio', { name: t('chat.side.create.kind_voice') }))
    fireEvent.click(screen.getByRole('button', { name: t('chat.create.submit') }))
    await waitFor(() => expect(api.calls.find(c => c.url === '/api/chat/channels' && c.opts?.method === 'POST')?.opts.body).toMatchObject({ voice: true }))
  })
})

describe('접속 바 · 본문 · 음질 패널(접속 중)', () => {
  beforeEach(async () => {
    api.handler = (url) => url.endsWith('/voice/token') ? { token: 'jwt', livekit_url: 'ws://x', room: 'voice-v1', identity: 'me-1' } : {}
    fakeTransport.peers.mockReturnValue([
      { identity: 'me-1', name: '김서연', isLocal: true, isSpeaking: false, micMuted: false, sharingAudio: false },
      { identity: 'a', name: '이도윤', isLocal: false, isSpeaking: true, micMuted: false, sharingAudio: false },
    ] as any)
    await joinVoice('v1')
    chatStore.setState({ voiceStates: { v1: { participants: [presence('a', '이도윤'), presence('b', '박민지', { tier: 'music', muted: true }), presence('me-1', '김서연')], since: 1 } } })
  })
  it('접속 바: 상태(role=status) "음성 연결됨" · 채널 · 워크스페이스 · 음질 버튼(aria-expanded) · 마이크/듣기 끔(aria-pressed)/음질 설정/나가기', async () => {
    renderInRouter(<VoiceConnectedBar />)
    const bar = screen.getByTestId('voice-bar')
    const status = within(bar).getByRole('status')
    expect(status.textContent).toContain(t('chat.voice.bar.status.connected'))
    expect(status.textContent).toContain('라운지')
    const q = within(bar).getByRole('button', { name: t('chat.voice.bar.qualityBtn') })
    expect(q.getAttribute('aria-expanded')).toBe('false')
    expect(q.textContent).toContain(t('chat.voice.tier.voice.short'))
    fireEvent.click(q)
    expect(q.getAttribute('aria-expanded')).toBe('true')
    const pop = await screen.findByRole('dialog', { name: t('chat.voice.stats.title') })
    expect(pop.style.width).toBe('400px')
    expect(within(pop).getByText(t('chat.voice.stats.refresh'))).toBeTruthy()
    expect(within(pop).getAllByRole('meter')).toHaveLength(2)
    expect(within(pop).getByRole('button', { name: t('chat.voice.stats.stabilize') })).toBeTruthy()
    // 음소거
    fireEvent.click(within(bar).getByRole('button', { name: t('chat.voice.mute') }))
    await waitFor(() => expect(fakeTransport.setMuted).toHaveBeenCalledWith(true))
    expect(voiceStore.getState().muted).toBe(true)
    // 듣기 끔(aria-pressed) → 음소거 유지, 전송에 deafen
    const deafen = within(bar).getByRole('button', { name: t('chat.voice.deafen') })
    expect(deafen.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(deafen)
    expect(fakeTransport.setDeafened).toHaveBeenCalledWith(true)
    expect(within(bar).getByRole('button', { name: t('chat.voice.undeafen') }).getAttribute('aria-pressed')).toBe('true')
    // 음소거 해제 → 듣기도 켠다
    fireEvent.click(within(bar).getByRole('button', { name: t('chat.voice.unmute') }))
    await waitFor(() => expect(voiceStore.getState().muted).toBe(false))
    expect(voiceStore.getState().deafened).toBe(false)
    // 음질 설정(aria-pressed) → 팝오버 460
    const settings = within(bar).getByRole('button', { name: t('chat.voice.quality.settings') })
    expect(settings.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(settings)
    const qp = await screen.findByRole('dialog', { name: t('chat.voice.quality.title') })
    expect(qp.style.width).toBe('460px')
    expect(settings.getAttribute('aria-pressed')).toBe('true')
    // 나가기 → 전송 leave + 서버에 leave
    fireEvent.click(within(bar).getByRole('button', { name: t('chat.voice.bar.leave') }))
    await waitFor(() => expect(fakeTransport.leave).toHaveBeenCalled())
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/chat/channels/v1/voice/leave')).toBe(true))
    expect(voiceStore.getState().channelId).toBeNull()
  })
  it('본문: 타일 그리드(말하는 중 = success 테두리·배지·실제 형식·상태 줄) · 머리 [음악 공유] · 오른쏙 채팅 패널 "이 음성채널 안에서만"', () => {
    api.handler = (url) => url.includes('/messages') ? { messages: [], has_more: false } : {}
    renderInRouter(<VoiceChannelView />)
    const tiles = screen.getAllByTestId('voice-tile')
    expect(tiles).toHaveLength(3)
    const speaking = tiles.find(x => x.textContent?.includes('이도윤'))!
    expect(speaking.className).toContain('border-success/60')
    expect(speaking.textContent).toContain(t('chat.voice.view.status.speaking'))
    const mine = tiles.find(x => x.textContent?.includes('김서연'))!
    expect(mine.textContent).toContain('Opus 모노 32 kbps')
    const muted = tiles.find(x => x.textContent?.includes('박민지'))!
    expect(within(muted).getByRole('img', { name: t('chat.voice.muted') })).toBeTruthy()
    expect(muted.textContent).toContain(t('chat.voice.tier.music.short'))
    expect(screen.getByRole('button', { name: t('chat.voice.musicShare') })).toBeTruthy()
    const chat = screen.getByTestId('voice-chat')
    expect(chat.className).toContain('w-[340px]')
    expect(chat.textContent).toContain(t('chat.voice.view.chat.scope'))
    expect(screen.getByPlaceholderText(t('chat.voice.view.chat.placeholder', { name: '라운지' }))).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('본문(들어가기 전): 겹친 아바타 · "○○ 님이 들어가 있습니다" · [들어가기] · "내 음질" · 채팅 없음', () => {
    voiceStore.setState({ channelId: null, identity: null, connectionState: 'disconnected' })
    renderInRouter(<VoiceChannelView />)
    expect(screen.getByText(t('chat.voice.view.inside', { names: ['이도윤', '박민지', '김서연'].join(t('chat.voice.view.namesSep')) }))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('chat.voice.join') }).className).toContain('px-6')
    expect(screen.getByText(t('chat.voice.tier.voice.name'), { selector: 'b' })).toBeTruthy()
    expect(screen.queryByTestId('voice-chat')).toBeNull()
    expect(screen.queryByTestId('voice-tile')).toBeNull()
  })
  it('음질 패널: 무손실 활성 · 하이레조는 웹에서 disabled + 이유 · 음악 → warning 한 줄 + 슬라이더 256–510 · 버퍼 목표 → 송신 설정', async () => {
    renderInRouter(<VoiceQualityPanel onClose={() => {}} />)
    const tiersGroup = screen.getByRole('radiogroup', { name: t('chat.voice.quality.title') })
    expect(within(tiersGroup).getAllByRole('radio')).toHaveLength(4)
    const lossless = screen.getByRole('radio', { name: new RegExp(t('chat.voice.tier.lossless.name')) })
    expect(lossless.getAttribute('aria-disabled') === 'true' || (lossless as HTMLButtonElement).disabled).toBe(false)
    const hires = screen.getByRole('radio', { name: new RegExp(t('chat.voice.tier.hires.name')) })
    expect((hires as HTMLButtonElement).disabled).toBe(true)
    expect(hires.textContent).toContain(t('chat.voice.tier.hires.webWhy'))
    expect(hires.textContent).toContain('150–300 ms')
    expect(screen.getByText(t('chat.voice.quality.advanced'))).toBeTruthy()
    expect(screen.queryByTestId('voice-earnote')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(t('chat.voice.tier.music.name')) }))
    await waitFor(() => expect(voiceStore.getState().prefs.tier).toBe('music'))
    // 음성 처리 기본 켬 → 이어폰 경고 없음, 모노 안내. 에코 제거를 끄면 이어폰 경고
    expect(screen.queryByTestId('voice-earnote')).toBeNull()
    expect(screen.getByTestId('voice-processing').textContent).toContain(t('chat.voice.quality.proc.musicMonoNote'))
    fireEvent.click(screen.getByRole('switch', { name: new RegExp(t('chat.voice.quality.proc.aec')) }))
    await waitFor(() => expect(voiceStore.getState().prefs.echoCancellation).toBe(false))
    expect(screen.getByTestId('voice-earnote').textContent).toContain(t('chat.voice.quality.earNote'))
    const slider = screen.getByLabelText(t('chat.voice.quality.bitrate')) as HTMLInputElement
    expect(slider.min).toBe('256000')
    expect(slider.max).toBe('510000')
    fireEvent.change(slider, { target: { value: '510000' } })
    await waitFor(() => expect(voiceStore.getState().prefs.musicBitrate).toBe(510_000))
    await waitFor(() => expect(fakeTransport.setSend).toHaveBeenCalled())
    expect((fakeTransport.setSend.mock.calls as unknown as any[][]).at(-1)![0]).toMatchObject({ tier: 'music', musicBitrate: 510_000, bufferTarget: 'auto' })
    // 샘플레이트 96 은 웹에서 흐림 · 버퍼 목표 120
    const sr = screen.getByRole('radiogroup', { name: t('chat.voice.quality.sampleRate') })
    expect(within(sr).getByRole('radio', { name: '96' }).getAttribute('aria-disabled')).toBe('true')
    const buf = screen.getByRole('radiogroup', { name: t('chat.voice.quality.buffer') })
    fireEvent.click(within(buf).getByRole('radio', { name: '120' }))
    await waitFor(() => expect(voiceStore.getState().prefs.bufferTarget).toBe(120))
    expect((fakeTransport.setSend.mock.calls as unknown as any[][]).at(-1)![0]).toMatchObject({ bufferTarget: 120 })
    expect(JSON.parse(localStorage.getItem('voice.quality')!)).toMatchObject({ tier: 'music', musicBitrate: 510_000, bufferTarget: 120 })
  })
  it('음질 상태(증명): 무손실 실측 — 형식 mono · 버퍼(안정화) · 손실·복구 · 중계 WebTransport · 받는 중 사람별 형식', () => {
    voiceStore.setState({
      effectiveTier: 'lossless', prefs: { ...DEFAULT_VOICE_PREFS, tier: 'lossless', bufferTarget: 120 },
      stats: { ...EMPTY_STATS, codec: 'PCM 24/48', channels: 2, sendBitrate: 2_304_000, rttMs: 142, bufferMs: 120, recovered: 31, recvPacketsLost: 2, packetsLost: 2, packetsSent: 9998, transport: 'webtransport' },
    })
    renderInRouter(<VoiceStatsContent mobile={false} />)
    const box = screen.getByTestId('voice-stats')
    expect(within(box).getByText('PCM 24/48 · 2.3 Mbps · 스테레오')).toBeTruthy()
    expect(box.textContent).toContain('142 ms')
    expect(box.textContent).toContain(t('chat.voice.stats.bufferStabilized', { ms: 120 }))
    expect(box.textContent).toContain(t('chat.voice.stats.lossValue', { pct: '0.02%', rec: '31', fail: '2' }))
    expect(box.textContent).toContain('WebTransport')
    expect(box.textContent).toContain(t('chat.voice.stats.receiving', { list: '이도윤 Opus 32 · 박민지 Opus' }))
  })
})

describe('상태', () => {
  beforeEach(async () => {
    api.handler = (url) => url.endsWith('/voice/token') ? { token: 'jwt', livekit_url: 'ws://x', room: 'voice-v1', identity: 'me-1' } : url.includes('/messages') ? { messages: [], has_more: false } : {}
    fakeTransport.peers.mockReturnValue([{ identity: 'me-1', name: '김서연', isLocal: true, isSpeaking: false, micMuted: false, sharingAudio: false }] as any)
    await joinVoice('v1')
    chatStore.setState({ voiceStates: { v1: { participants: [presence('me-1', '김서연'), presence('a', '이도윤')], since: 1 } } })
  })
  it('연결 중: "연결하는 중…" · 지연 "—" · 마이크 잠김', () => {
    voiceStore.setState({ connectionState: 'connecting' })
    renderInRouter(<VoiceConnectedBar />)
    const bar = screen.getByTestId('voice-bar')
    expect(within(bar).getByRole('status').textContent).toContain(t('chat.voice.bar.status.connecting'))
    expect(within(bar).getByRole('button', { name: t('chat.voice.bar.qualityBtn') }).textContent).toContain('—')
    expect((within(bar).getByRole('button', { name: t('chat.voice.bar.micConnecting') }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('재연결: 접속 바 위 테두리 warning 2px + "다시 연결하는 중… N초" · 본문 warning 띠(role=alert)', () => {
    voiceStore.setState({ connectionState: 'reconnecting', reconnectSince: Date.now() - 3200 })
    renderInRouter(<><VoiceConnectedBar /><VoiceChannelView /></>)
    const bar = screen.getByTestId('voice-bar')
    expect(bar.className).toContain('border-t-2')
    expect(bar.className).toContain('border-warning/60')
    expect(within(bar).getByRole('status').textContent).toContain(t('chat.voice.bar.status.reconnecting', { n: 3 }))
    const band = screen.getByRole('alert')
    expect(band.getAttribute('data-band')).toBe('reconnect')
    expect(band.textContent).toContain(t('chat.voice.band.reconnect.title'))
    expect(band.textContent).toContain(t('chat.voice.band.reconnect.desc'))
  })
  it('무손실 중계 실패: 음악으로 강등 → warning 띠 + [무손실 다시 시도](setSend) · 내 배지는 실제 단계(음악)', async () => {
    voiceStore.setState({ prefs: { ...DEFAULT_VOICE_PREFS, tier: 'lossless' }, effectiveTier: 'music' })
    renderInRouter(<><VoiceConnectedBar /><VoiceChannelView /></>)
    const band = screen.getByRole('alert')
    expect(band.getAttribute('data-band')).toBe('relayFail')
    expect(band.textContent).toContain(t('chat.voice.band.relayFail.title'))
    expect(within(screen.getByTestId('voice-bar')).getByRole('button', { name: t('chat.voice.bar.qualityBtn') }).textContent).toContain(t('chat.voice.tier.music.short'))
    expect(within(screen.getAllByTestId('voice-tile')[0]).getByText(t('chat.voice.tier.music.short'))).toBeTruthy()
    fakeTransport.setSend.mockClear()
    fireEvent.click(within(band).getByRole('button', { name: t('chat.voice.band.relayFail.btn') }))
    await waitFor(() => expect(fakeTransport.setSend).toHaveBeenCalled())
  })
  it('권한 없음: 들어가되 듣기만 — "듣기만 하는 중" · 마이크 잠김 · 내 타일 "듣기만 · 마이크 권한 없음" · 브라우저별 한 줄 + [다시 시도]', async () => {
    fakeTransport.micState.mockReturnValue('denied')
    voiceStore.setState({ listenOnly: true })
    renderInRouter(<><VoiceConnectedBar /><VoiceChannelView /></>)
    const bar = screen.getByTestId('voice-bar')
    expect(within(bar).getByRole('status').textContent).toContain(t('chat.voice.bar.status.listenOnly'))
    expect((within(bar).getByRole('button', { name: t('chat.voice.bar.micLocked') }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByTestId('voice-tile')[0].textContent).toContain(t('chat.voice.view.status.listenOnly'))
    const band = screen.getByRole('alert')
    expect(band.getAttribute('data-band')).toBe('noPermission')
    expect(band.textContent).toContain(t('chat.voice.band.noPermission.title'))
    fakeTransport.micState.mockReturnValue('ok')
    fireEvent.click(within(band).getByRole('button', { name: t('chat.voice.band.noPermission.btn') }))
    await waitFor(() => expect(fakeTransport.setSend).toHaveBeenCalled())
    await waitFor(() => expect(voiceStore.getState().listenOnly).toBe(false))
  })
  it('이어폰 권장: 출력이 스피커로 감지되고 음악 이상이면 warning 띠 + [음성으로 바꾸기] · 감지 못 하면 띠 없음', async () => {
    voiceStore.setState({ prefs: { ...DEFAULT_VOICE_PREFS, tier: 'music' }, effectiveTier: 'music' })
    mediaDevicesStore.setState({ speakers: [dev('spk', 'Speakers (Realtek(R) Audio)')] })
    const r = renderInRouter(<VoiceChannelView />)
    const band = screen.getByRole('alert')
    expect(band.getAttribute('data-band')).toBe('earphone')
    expect(band.textContent).toContain(t('chat.voice.band.earphone.title'))
    fireEvent.click(within(band).getByRole('button', { name: t('chat.voice.band.earphone.btn') }))
    await waitFor(() => expect(voiceStore.getState().prefs.tier).toBe('voice'))
    r.unmount()
    voiceStore.setState({ prefs: { ...DEFAULT_VOICE_PREFS, tier: 'music' }, effectiveTier: 'music' })
    mediaDevicesStore.setState({ speakers: [dev('x', 'USB Audio Device')] })
    renderInRouter(<VoiceChannelView />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('장치 독점 실패: danger 띠 + [다시 시도]', async () => {
    reportExclusiveError({ app: 'MusicApp', device: 'Scarlett 2i2' })
    renderInRouter(<VoiceChannelView />)
    const band = screen.getByRole('alert')
    expect(band.getAttribute('data-band')).toBe('exclusiveFail')
    expect(band.className).toContain('border-danger/60')
    expect(band.textContent).toContain('MusicApp')
    fireEvent.click(within(band).getByRole('button', { name: t('chat.voice.band.exclusiveFail.btn') }))
    await waitFor(() => expect(voiceStore.getState().exclusiveError).toBeNull())
  })
  it('하이레조 켜기(데스크톱 앱, 처음 한 번): alertdialog 440 · 장치 이름 굵게 · 형식 mono · "다음부터 묻지 않기" → 다음엔 묻지 않는다', async () => {
    renderInRouter(<VoiceHiresDialog />)
    const p = confirmHiresExclusive('Scarlett 2i2', 'PCM 32/192 · 비트퍼펙트 · 12.3 Mbps')
    const dlg = await screen.findByRole('alertdialog')
    expect(dlg.textContent).toContain(t('chat.voice.hires.title'))
    expect(within(dlg).getByText('Scarlett 2i2', { selector: 'b' })).toBeTruthy()
    expect(within(dlg).getByText('PCM 32/192 · 비트퍼펙트 · 12.3 Mbps').className).toContain('font-mono')
    fireEvent.click(within(dlg).getByLabelText(t('chat.voice.hires.skip')))
    fireEvent.click(within(dlg).getByRole('button', { name: t('chat.voice.hires.confirm') }))
    await expect(p).resolves.toBe(true)
    await waitFor(() => expect(voiceStore.getState().prefs.hiresAskSkip).toBe(true))
    await expect(confirmHiresExclusive('Scarlett 2i2', 'x')).resolves.toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
  it('모바일: 접속 바 버튼 44 네 칸 균등 · 음질 패널은 바텀시트(하이레조 없음 · 버퍼 목표만)', async () => {
    isMobileStore.setState({ isMobile: true })
    renderInRouter(<VoiceConnectedBar mobile />)
    const bar = screen.getByTestId('voice-bar')
    expect(bar.querySelector('.grid-cols-4')).toBeTruthy()
    fireEvent.click(within(bar).getByRole('button', { name: t('chat.voice.quality.settings') }))
    const sheet = await screen.findByRole('dialog', { name: t('chat.voice.quality.title') })
    expect(within(within(sheet).getByRole('radiogroup', { name: t('chat.voice.quality.title') })).getAllByRole('radio')).toHaveLength(3)
    expect(within(sheet).queryByRole('radio', { name: new RegExp(t('chat.voice.tier.hires.name')) })).toBeNull()
    expect(within(sheet).getByRole('radiogroup', { name: t('chat.voice.quality.buffer') })).toBeTruthy()
    expect(within(sheet).queryByLabelText(t('chat.voice.quality.bitrate'))).toBeNull()
    expect(sheet.textContent).toContain(t('chat.voice.quality.hiresMobileNote'))
  })
})
